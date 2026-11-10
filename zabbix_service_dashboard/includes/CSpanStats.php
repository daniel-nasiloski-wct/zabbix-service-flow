<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

use ApmDb;
use ApmDbClickHouse;
use CApiUserGroupHelper;
use CClickHouseHelper;
use CClickHouseQuery;
use CWebUser;

/**
 * Estatísticas do mapa calculadas no ClickHouse, no mesmo banco e com o mesmo filtro de permissão que a
 * apmspan.get usa (CApmSpan::getFromClickHouse). Trazer os spans crus para o PHP limitava a janela a
 * 50 mil spans e baixava dezenas de MB de atributos; aqui vêm só as contas prontas, sem limite.
 *
 * Três consultas: serviços e endpoints (spans Server), chamadas a bancos e serviços externos (spans
 * Client sem filho em outro serviço) e ligações entre serviços (span cujo filho Server/Consumer está em
 * outro serviço; a estatística é a do span do chamador). Tempos em nanossegundos, como no banco.
 */
class CSpanStats {

	public const TOP_TRACES = 5;

	/**
	 * @param array $filter Filtro por atributos já no formato de CSpanFilter::apiOptions().
	 *
	 * @return array ['services' => [...], 'calls' => [...], 'links' => [...]]
	 */
	public static function load(int $from, int $till, array $filter = []): array {
		$db = ApmDbClickHouse::getInstance(ApmDb::getInstance()->getConfig());
		$fetch = static function (string $sql, array $params) use ($db): array {
			$rows = [];
			foreach ($db->fetch($sql, $params) as $row) {
				$rows[] = $row;
			}

			return $rows;
		};

		$top_n = '('.self::TOP_TRACES.')';

		// Serviços (linha com total = 1) e seus endpoints; lastSeen e total de spans contam todos os tipos.
		$spans = self::spans('s', $from, $till, $filter, [
			'svc' => 's.ServiceName', 'name' => 's.SpanName', 'kind' => 's.SpanKind', 'd' => 's.Duration',
			'err' => "toInt8(s.StatusCode='Error')", 'ts' => 'toUnixTimestamp64Nano(s.Timestamp)', 'tid' => 's.TraceId'
		]);
		$services = $fetch(
			'SELECT svc,name,grouping(name) AS total,count() AS spans,max(ts) AS last,'.
				"countIf(kind='Server') AS n,sumIf(err,kind='Server') AS errors,".
				"if(n>0,avgIf(d,kind='Server'),0) AS avg,if(n>0,quantileExactIf(0.95)(d,kind='Server'),0) AS p95,".
				'groupArraySortedIf'.$top_n."((-err,-toInt64(d),tid,ts,name),kind='Server') AS top".
			' FROM ('.$spans->getSql().')'.
			' GROUP BY GROUPING SETS ((svc,name),(svc))'.
			' HAVING total=1 OR n>0'.
			' ORDER BY svc,name',
			$spans->getParams()
		);

		// Pares chamador → filho em outro serviço: viram ligação entre serviços e saem das chamadas externas.
		$parents = self::spans('p', $from, $till, $filter, [
			'svc' => 'p.ServiceName', 'name' => 'p.SpanName', 'sid' => 'p.SpanId', 'd' => 'p.Duration',
			'err' => "toInt8(p.StatusCode='Error')", 'ts' => 'toUnixTimestamp64Nano(p.Timestamp)', 'tid' => 'p.TraceId'
		]);
		$children = self::spans('c', $from, $till, $filter, [
			'svc' => 'c.ServiceName', 'name' => 'c.SpanName', 'pid' => 'c.ParentSpanId', 'tid' => 'c.TraceId'
		], ["c.SpanKind IN ('Server','Consumer')", "c.ParentSpanId!=''"]);
		$remote = ' FROM ('.$parents->getSql().') AS p'.
			' INNER JOIN ('.$children->getSql().') AS c ON p.tid=c.tid AND p.sid=c.pid'.
			' WHERE p.svc!=c.svc';
		$remote_params = $parents->getParams() + $children->getParams();

		$links = $fetch(
			'SELECT p.svc AS src,c.svc AS dst,count() AS n,sum(p.err) AS errors,avg(p.d) AS avg,'.
				'quantileExact(0.95)(p.d) AS p95,max(p.ts) AS last,'.
				"sumMap([concat(p.name,' → ',c.name)],[toUInt64(1)]) AS ops,".
				'groupArraySorted'.$top_n."((-p.err,-toInt64(p.d),p.tid,p.ts,concat(p.name,' → ',c.name))) AS top".
			$remote.
			' GROUP BY src,dst'.
			' ORDER BY src,dst',
			$remote_params
		);

		// Chamadas para fora: banco (db.system) ou serviço externo (server.address; instrumentações com as
		// convenções antigas só gravam net.peer.name ou http.host). Um destino por chamador.
		$clients = self::spans('t', $from, $till, $filter, [
			'svc' => 't.ServiceName', 'name' => 't.SpanName', 'sid' => 't.SpanId', 'd' => 't.Duration',
			'err' => "toInt8(t.StatusCode='Error')", 'ts' => 'toUnixTimestamp64Nano(t.Timestamp)', 'tid' => 't.TraceId',
			'db' => "t.SpanAttributes['db.system']",
			'ext' => "multiIf(t.SpanAttributes['server.address']!='',t.SpanAttributes['server.address'],".
				"t.SpanAttributes['net.peer.name']!='',t.SpanAttributes['net.peer.name'],t.SpanAttributes['http.host'])"
		], ["t.SpanKind='Client'"]);
		$calls = $fetch(
			"SELECT svc,if(db!='','db','external') AS kind,if(db!='',db,ext) AS target,".
				'count() AS n,sum(err) AS errors,avg(d) AS avg,quantileExact(0.95)(d) AS p95,max(ts) AS last,'.
				'sumMap([name],[toUInt64(1)]) AS ops,'.
				'groupArraySorted'.$top_n.'((-err,-toInt64(d),tid,ts,name)) AS top'.
			' FROM ('.$clients->getSql().')'.
			" WHERE target!='' AND (tid,sid) NOT IN (SELECT p.tid,p.sid".$remote.')'.
			' GROUP BY svc,kind,target'.
			' ORDER BY svc,kind,target',
			$clients->getParams() + $remote_params
		);

		return ['services' => $services, 'calls' => $calls, 'links' => $links];
	}

	/**
	 * Spans da janela com as permissões do usuário (como na apmspan.get) e o filtro por atributos.
	 *
	 * @param string[] $columns alias => expressão
	 * @param string[] $where   Condições extras.
	 */
	private static function spans(string $alias, int $from, int $till, array $filter, array $columns,
			array $where = []): CClickHouseQuery {
		$query = (new CClickHouseQuery())
			->from('otel_traces', $alias)
			->where($alias.'.Timestamp>=toDateTime64({time_from:Int32},9)', ['time_from' => ['Int32', $from]])
			->where($alias.'.Timestamp<toDateTime64({time_till:Int32},9)', ['time_till' => ['Int32', $till]]);

		foreach ($columns as $name => $expression) {
			$query->select($expression, $name);
		}
		foreach ($where as $condition) {
			$query->where($condition);
		}

		if (CWebUser::getType() != USER_TYPE_SUPER_ADMIN) {
			CClickHouseHelper::addAttributeFilter($query, $alias.'.ResourceAttributes',
				CApiUserGroupHelper::getApmFilterResourceAttributes(SIGNAL_TYPE_TRACES), TAG_EVAL_TYPE_OR
			);
		}

		foreach (['resource' => 'ResourceAttributes', 'span' => 'SpanAttributes'] as $type => $field) {
			if (!empty($filter[$type.'_attributes'])) {
				CClickHouseHelper::addAttributeFilter($query, $alias.'.'.$field, $filter[$type.'_attributes'],
					(int) $filter[$type.'_attributes_evaltype']
				);
			}
		}

		return $query;
	}
}

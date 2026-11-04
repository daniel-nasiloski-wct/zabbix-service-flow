<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

use API;
use RuntimeException;

/**
 * Coleta do Zabbix pela API interna do frontend, com as permissões do usuário logado (sem token,
 * sem user.login). Port de server/zabbix.js loadData(): spans da janela + hosts, itens, histórico
 * e triggers em problema dos hosts com o mesmo nome do service.name.
 */
class CCollector {

	public const ITEM_KEYS = ['apm.requests', 'apm.latency.p95', 'apm.errors', 'apm.logs.error'];
	public const SPAN_FIELDS = ['traceid', 'spanid', 'parent_spanid', 'span_name', 'span_kind', 'service_name',
		'span_attributes', 'duration', 'status_code', 'timestamp'
	];
	public const SPAN_LIMIT = 50000;
	public const HISTORY_SECONDS = 1800;

	/**
	 * Tudo o que o navegador precisa, no mesmo formato que o servidor Node entregava em /api/flow.
	 * Atualiza a topologia salva do módulo com o que apareceu nos spans.
	 *
	 * Com filtro por atributos (CSpanFilter) o mapa mostra só o que os spans filtrados contêm: a memória
	 * de topologia e os hosts sem span ficam de fora (senão o filtro não filtraria nada), e nada é
	 * gravado na memória; só as remoções continuam valendo.
	 */
	public static function snapshot(int $minutes, array $filter = []): array {
		self::raiseLimits();

		$filtered = CSpanFilter::isActive($filter);
		$topology = new CTopology();
		$known = $topology->known();
		$known_names = [];
		if (!$filtered) {
			foreach ($known['nodes'] as $n) {
				if ($n['kind'] === 'service') {
					$known_names[] = $n['id'];
				}
			}
		}

		$d = self::loadData($minutes, $known_names, CSpanFilter::apiOptions($filter));
		$graph = CGraph::buildGraph($d['spans'], $minutes);
		if ($filtered) {
			$merged = CGraph::mergeKnown($graph, ['hidden' => $known['hidden']], [], $minutes);
		}
		else {
			$topology->record(CGraph::seenTopology($graph));
			$merged = CGraph::mergeKnown($graph, $topology->known(), $d['apmHosts'], $minutes);
		}

		return [
			'graph' => $merged,
			'filtered' => $filtered,
			'order' => $known['order'] ?? [],
			'hosts' => $d['hosts'],
			'items' => $d['items'],
			'triggers' => $d['triggers'],
			'history' => $d['history'],
			'from' => $d['from'],
			'till' => $d['till'],
			'spans' => count($d['spans']),
			'frontend' => '',
			'updated' => (int) round(microtime(true) * 1000)
		];
	}

	/**
	 * @param string[] $known_names  Serviços já conhecidos da topologia salva (podem estar sem spans na janela).
	 * @param array    $span_options Parâmetros extras do apmspan.get (filtro por atributos).
	 */
	public static function loadData(int $minutes, array $known_names = [], array $span_options = []): array {
		$till = time();
		$from = $till - $minutes * 60;

		// Os mais novos primeiro, para o limite cortar os antigos; depois volta à ordem cronológica,
		// que é a que o grafo espera (amostras mais recentes ficam).
		$spans = self::call('apmspan.get', API::ApmSpan()->get($span_options + [
			'time_from' => $from,
			'time_till' => $till,
			'limit' => self::SPAN_LIMIT,
			'output' => self::SPAN_FIELDS,
			'sortfield' => ['timestamp'],
			'sortorder' => ZBX_SORT_DOWN
		]));
		$spans = array_reverse($spans);

		$apm_items = self::call('item.get', API::Item()->get([
			'filter' => ['key_' => 'apm.requests'],
			'monitored' => true,
			'output' => ['hostid']
		]));

		$names = array_values(array_unique(array_merge(array_column($spans, 'service_name'), $known_names)));
		$apm_hostids = array_values(array_unique(array_column($apm_items, 'hostid')));

		$by_name = $names
			? self::call('host.get', API::Host()->get(['filter' => ['host' => $names], 'output' => ['hostid', 'host', 'name']]))
			: [];
		$by_item = $apm_hostids
			? self::call('host.get', API::Host()->get(['hostids' => $apm_hostids, 'output' => ['hostid', 'host', 'name']]))
			: [];

		$hosts = [];
		foreach (array_merge($by_name, $by_item) as $h) {
			$hosts[$h['hostid']] = ['hostid' => $h['hostid'], 'host' => $h['host'], 'name' => $h['name']];
		}
		$hosts = array_values($hosts);
		$apm_hosts = array_column($by_item, 'host');
		$hostids = array_column($hosts, 'hostid');

		$items = [];
		$triggers = [];
		if ($hostids) {
			$items = self::call('item.get', API::Item()->get([
				'hostids' => $hostids,
				'filter' => ['key_' => self::ITEM_KEYS],
				'output' => ['itemid', 'hostid', 'key_', 'name', 'lastvalue', 'lastclock', 'units']
			]));
			$triggers = self::call('trigger.get', API::Trigger()->get([
				'hostids' => $hostids,
				'filter' => ['value' => TRIGGER_VALUE_TRUE],
				'monitored' => true,
				'skipDependent' => true,
				'expandDescription' => true,
				'output' => ['triggerid', 'description', 'priority', 'lastchange'],
				'selectHosts' => ['hostid']
			]));
		}

		$history = $items
			? self::call('history.get', API::History()->get([
				'itemids' => array_column($items, 'itemid'),
				'history' => ITEM_VALUE_TYPE_FLOAT,
				'time_from' => $till - self::HISTORY_SECONDS,
				'sortfield' => 'clock',
				'sortorder' => ZBX_SORT_UP,
				'output' => ['itemid', 'clock', 'value']
			]))
			: [];

		return [
			'spans' => $spans, 'hosts' => $hosts, 'apmHosts' => $apm_hosts, 'items' => $items,
			'triggers' => $triggers, 'history' => $history, 'from' => $from, 'till' => $till
		];
	}

	/** A API interna devolve false e empilha mensagens quando falha; vira exceção com a mensagem. */
	private static function call(string $method, $result): array {
		if ($result === false || !is_array($result)) {
			$messages = array_column(get_and_clear_messages(), 'message');
			throw new RuntimeException($method.': '.($messages ? implode('; ', $messages) : 'API error'));
		}

		return $result;
	}

	/** Até 50 mil spans em arrays PHP pedem mais memória do que o padrão do frontend. */
	private static function raiseLimits(): void {
		$limit = ini_get('memory_limit');
		$bytes = self::toBytes((string) $limit);
		if ($bytes !== -1 && $bytes < 512 * 1024 * 1024) {
			@ini_set('memory_limit', '512M');
		}
		@set_time_limit(60);
	}

	private static function toBytes(string $value): int {
		$value = trim($value);
		if ($value === '' || $value === '-1') {
			return -1;
		}
		$unit = strtolower(substr($value, -1));
		$number = (int) $value;

		return match ($unit) {
			'g' => $number * 1024 * 1024 * 1024,
			'm' => $number * 1024 * 1024,
			'k' => $number * 1024,
			default => $number
		};
	}
}

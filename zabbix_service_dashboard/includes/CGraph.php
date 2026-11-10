<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

/**
 * Monta o fluxo de serviços a partir das estatísticas agregadas no ClickHouse (CSpanStats): quem chama
 * quem, com estatísticas por ligação. O formato de saída é o mesmo do buildGraph de src/graph.js;
 * mergeKnown e seenTopology são port fiel do JS, e o teste tests/parity.sh garante que os dois produzem o
 * mesmo resultado para a mesma entrada.
 */
class CGraph {

	/** Estatísticas no formato do mapa; tempos de entrada em nanossegundos, de saída em segundos. */
	private static function stats(int $count, int $errors, float $avg_ns, float $p95_ns, int $minutes): array {
		return [
			'count' => $count,
			'rpm' => $count / $minutes,
			'errors' => $errors,
			'errPct' => $count ? 100 * $errors / $count : 0,
			'p95' => $count ? $p95_ns / 1e9 : 0.0,
			'avg' => $count ? $avg_ns / 1e9 : 0
		];
	}

	private static function rowStats(array $row, string $count_field, int $minutes): array {
		return self::stats((int) $row[$count_field], (int) $row['errors'], (float) $row['avg'], (float) $row['p95'],
			$minutes
		);
	}

	/**
	 * Traces para o tooltip, já na ordem do ClickHouse (groupArraySorted): primeiro os com erro, depois os
	 * mais lentos. Cada item é a tupla (-erro, -duração, traceid, timestamp em ns, nome do span).
	 */
	private static function traces(array $top, callable $op): array {
		return array_map(static fn(array $t): array => [
			'traceid' => (string) $t[2],
			'seconds' => -(float) $t[1] / 1e9,
			'error' => (int) $t[0] !== 0,
			'ts' => (float) $t[3] / 1e6,
			'op' => $op((string) $t[4])
		], $top);
	}

	/** Contagens por operação (sumMap: [[nomes], [contagens]]) em chamadas por minuto, da maior para a menor. */
	private static function ops(array $ops, int $minutes): array {
		$out = [];
		foreach ($ops[0] ?? [] as $i => $name) {
			$out[] = ['name' => (string) $name, 'rpm' => (int) $ops[1][$i] / $minutes];
		}
		usort($out, static fn(array $a, array $b): int => $b['rpm'] <=> $a['rpm']);

		return $out;
	}

	/**
	 * @param array $stats   Saída de CSpanStats::load().
	 * @param int   $minutes Tamanho da janela, para as taxas por minuto.
	 *
	 * @return array ['nodes' => [...], 'edges' => [...]]
	 */
	public static function fromStats(array $stats, int $minutes): array {
		$nodes = [];
		$edges = [];
		$same = static fn(string $op): string => $op;

		foreach ($stats['services'] as $row) {
			$svc = (string) $row['svc'];
			if ((int) $row['total'] === 1) {
				$nodes[$svc] = ($nodes[$svc] ?? []) + [
					'id' => $svc,
					'kind' => 'service',
					'label' => $svc,
					'lastSeen' => (float) $row['last'] / 1e9,
					'stats' => self::rowStats($row, 'n', $minutes),
					'endpoints' => [],
					'traces' => self::traces($row['top'], $same)
				];
			}
			else {
				$nodes[$svc]['endpoints'][] = ['name' => (string) $row['name']] + self::rowStats($row, 'n', $minutes);
			}
		}
		foreach ($nodes as &$node) {
			usort($node['endpoints'], static fn(array $a, array $b): int => $b['count'] <=> $a['count']);
		}
		unset($node);

		foreach ($stats['links'] as $row) {
			$key = $row['src'].'→'.$row['dst'];
			$edges[] = [
				'key' => $key,
				'from' => (string) $row['src'],
				'to' => (string) $row['dst'],
				'lastSeen' => (float) $row['last'] / 1e9,
				'stats' => self::rowStats($row, 'n', $minutes),
				'ops' => self::ops($row['ops'], $minutes),
				'traces' => self::traces($row['top'], $same)
			];
		}

		// Um nó por chamador: o mysql do checkout e o do shipping são bancos diferentes.
		foreach ($stats['calls'] as $row) {
			$svc = (string) $row['svc'];
			$target = ($row['kind'] === 'db' ? 'db:' : 'ext:').$row['target'].'@'.$svc;
			$last = (float) $row['last'] / 1e9;
			$row_stats = self::rowStats($row, 'n', $minutes);
			$nodes[$target] = [
				'id' => $target,
				'kind' => (string) $row['kind'],
				'label' => (string) $row['target'],
				'lastSeen' => $last,
				'stats' => $row_stats,
				'endpoints' => [],
				'traces' => self::traces($row['top'], static fn(string $op): string => $svc.': '.$op)
			];
			$edges[] = [
				'key' => $svc.'→'.$target,
				'from' => $svc,
				'to' => $target,
				'lastSeen' => $last,
				'stats' => $row_stats,
				'ops' => self::ops($row['ops'], $minutes),
				'traces' => self::traces($row['top'], $same)
			];
		}

		return ['nodes' => array_values($nodes), 'edges' => $edges];
	}

	/**
	 * Junta o que veio nos spans da janela com a topologia salva (known) e os hosts com itens apm.*:
	 * o que não teve tráfego na janela continua no mapa, marcado como idle. O que o usuário removeu
	 * (known.hidden, id => horário da remoção) só volta se tiver um span mais novo que a remoção.
	 *
	 * @param array $graph     Saída de fromStats().
	 * @param array $known     ['nodes' => [[id, kind, label, lastSeen]], 'edges' => [[key, from, to, lastSeen]], 'hidden' => [id => ts]]
	 * @param array $apm_hosts Nomes técnicos dos hosts que têm o item apm.requests.
	 */
	public static function mergeKnown(array $graph, array $known, array $apm_hosts, int $minutes): array {
		$hidden_at = $known['hidden'] ?? [];
		$shown = static fn(string $id, $last): bool =>
			!array_key_exists($id, $hidden_at) || ((float) ($last ?? 0)) > (float) $hidden_at[$id];
		$idle_stats = self::stats(0, 0, 0, 0, $minutes);

		$nodes = [];
		foreach ($graph['nodes'] as $n) {
			if ($shown($n['id'], $n['lastSeen'])) {
				$nodes[$n['id']] = $n + ['idle' => false];
			}
		}
		foreach ($known['nodes'] ?? [] as $n) {
			if (!array_key_exists($n['id'], $nodes) && $shown($n['id'], $n['lastSeen'])) {
				$nodes[$n['id']] = [
					'id' => $n['id'], 'kind' => $n['kind'], 'label' => $n['label'], 'lastSeen' => $n['lastSeen'],
					'stats' => $idle_stats, 'endpoints' => [], 'traces' => [], 'idle' => true
				];
			}
		}
		foreach ($apm_hosts as $host) {
			$host = (string) $host;
			if (!array_key_exists($host, $nodes) && !array_key_exists($host, $hidden_at)) {
				$nodes[$host] = [
					'id' => $host, 'kind' => 'service', 'label' => $host, 'lastSeen' => null,
					'stats' => $idle_stats, 'endpoints' => [], 'traces' => [], 'idle' => true
				];
			}
		}

		$edges = [];
		foreach ($graph['edges'] as $e) {
			if (array_key_exists($e['from'], $nodes) && array_key_exists($e['to'], $nodes)) {
				$edges[$e['key']] = $e + ['idle' => false];
			}
		}
		foreach ($known['edges'] ?? [] as $e) {
			if (!array_key_exists($e['key'], $edges) && array_key_exists($e['from'], $nodes)
					&& array_key_exists($e['to'], $nodes)) {
				$edges[$e['key']] = [
					'key' => $e['key'], 'from' => $e['from'], 'to' => $e['to'], 'lastSeen' => $e['lastSeen'],
					'stats' => $idle_stats, 'ops' => [], 'traces' => [], 'idle' => true
				];
			}
		}

		return ['nodes' => array_values($nodes), 'edges' => array_values($edges)];
	}

	/** O que vai para a topologia salva: só o que teve span na janela. */
	public static function seenTopology(array $graph): array {
		return [
			'nodes' => array_map(static fn(array $n): array => [
				'id' => $n['id'], 'kind' => $n['kind'], 'label' => $n['label'], 'lastSeen' => $n['lastSeen']
			], $graph['nodes']),
			'edges' => array_map(static fn(array $e): array => [
				'key' => $e['key'], 'from' => $e['from'], 'to' => $e['to'], 'lastSeen' => $e['lastSeen']
			], $graph['edges'])
		];
	}
}

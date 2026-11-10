<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

/**
 * Monta o fluxo de serviços a partir dos spans: quem chama quem, com estatísticas por ligação.
 * Port fiel de src/graph.js (buildGraph, mergeKnown, seenTopology); o teste tests/parity.sh garante
 * que os dois produzem o mesmo resultado para a mesma entrada.
 */
class CGraph {

	public const MAX_SAMPLES = 200;

	private static function p95(array $values): float {
		if (!$values) {
			return 0.0;
		}
		sort($values);
		$n = count($values);

		return (float) $values[min($n - 1, (int) floor($n * 0.95))];
	}

	private static function stats(array $acc, int $minutes): array {
		$n = count($acc['durations']);

		return [
			'count' => $n,
			'rpm' => $n / $minutes,
			'errors' => $acc['errors'],
			'errPct' => $n ? 100 * $acc['errors'] / $n : 0,
			'p95' => self::p95($acc['durations']),
			'avg' => $n ? array_sum($acc['durations']) / $n : 0
		];
	}

	private static function newAcc(): array {
		return ['durations' => [], 'errors' => 0, 'samples' => [], 'ops' => [], 'last' => 0.0];
	}

	private static function spanTime(array $span): float {
		return (float) $span['timestamp'] / 1e9;
	}

	private static function add(array &$acc, array $span, ?string $op): void {
		$seconds = (float) $span['duration'] / 1e9;
		$error = ($span['status_code'] ?? '') === 'Error';
		$acc['durations'][] = $seconds;
		$acc['errors'] += $error ? 1 : 0;
		if ($op !== null && $op !== '') {
			$acc['ops'][$op] = ($acc['ops'][$op] ?? 0) + 1;
		}
		$acc['last'] = max($acc['last'], self::spanTime($span));
		$acc['samples'][] = [
			'traceid' => (string) $span['traceid'],
			'seconds' => $seconds,
			'error' => $error,
			'ts' => (float) $span['timestamp'] / 1e6,
			'op' => $op
		];
		if (count($acc['samples']) > self::MAX_SAMPLES) {
			array_shift($acc['samples']);
		}
	}

	/** Traces para o tooltip: primeiro os com erro, depois os mais lentos. */
	private static function topTraces(array $samples, int $n = 5): array {
		usort($samples, static fn(array $a, array $b): int =>
			((int) $b['error'] <=> (int) $a['error']) ?: ($b['seconds'] <=> $a['seconds'])
		);

		return array_slice($samples, 0, $n);
	}

	private static function attributes(array $span): array {
		$attrs = $span['span_attributes'] ?? [];
		if (is_string($attrs)) {
			$attrs = json_decode($attrs, true) ?: [];
		}

		return is_array($attrs) ? $attrs : [];
	}

	/**
	 * @param array $spans   Spans da janela (campos da apmspan.get).
	 * @param int   $minutes Tamanho da janela, para as taxas por minuto.
	 *
	 * @return array ['nodes' => [...], 'edges' => [...]]
	 */
	public static function buildGraph(array $spans, int $minutes): array {
		$by_id = [];
		foreach ($spans as $s) {
			$by_id['s'.$s['spanid']] = $s;
		}
		$nodes = [];
		$edges = [];
		$remote_parents = [];
		$last_seen = [];

		$node = static function (string $id, string $kind, string $label) use (&$nodes): void {
			if (!array_key_exists($id, $nodes)) {
				$nodes[$id] = ['id' => $id, 'kind' => $kind, 'label' => $label, 'acc' => self::newAcc(), 'endpoints' => []];
			}
		};
		$edge = static function (string $from, string $to) use (&$edges): string {
			$key = $from.'→'.$to;
			if (!array_key_exists($key, $edges)) {
				$edges[$key] = ['key' => $key, 'from' => $from, 'to' => $to, 'acc' => self::newAcc()];
			}

			return $key;
		};

		// Ligações entre serviços: span filho em outro serviço; a estatística vem do span CLIENT do chamador.
		foreach ($spans as $s) {
			$svc = (string) $s['service_name'];
			$node($svc, 'service', $svc);
			$last_seen[$svc] = max($last_seen[$svc] ?? 0.0, self::spanTime($s));
			$parent = $by_id['s'.($s['parent_spanid'] ?? '')] ?? null;
			if ($parent !== null && (string) $parent['service_name'] !== $svc) {
				$remote_parents['s'.$parent['spanid']] = true;
				$key = $edge((string) $parent['service_name'], $svc);
				self::add($edges[$key]['acc'], $parent, $parent['span_name'].' → '.$s['span_name']);
			}
		}

		foreach ($spans as $s) {
			$svc = (string) $s['service_name'];
			if ($s['span_kind'] === 'Server') {
				self::add($nodes[$svc]['acc'], $s, (string) $s['span_name']);
				$ep = (string) $s['span_name'];
				if (!array_key_exists($ep, $nodes[$svc]['endpoints'])) {
					$nodes[$svc]['endpoints'][$ep] = self::newAcc();
				}
				self::add($nodes[$svc]['endpoints'][$ep], $s, null);
			}
			elseif ($s['span_kind'] === 'Client' && !isset($remote_parents['s'.$s['spanid']])) {
				// Chamada para algo sem instrumentação: banco (db.system) ou serviço externo (server.address;
				// instrumentações com as convenções antigas só gravam net.peer.name ou http.host).
				// Um nó por chamador: o mysql do checkout e o do shipping são bancos diferentes.
				$attrs = self::attributes($s);
				$db = $attrs['db.system'] ?? null;
				$ext = ($attrs['server.address'] ?? '') ?: (($attrs['net.peer.name'] ?? '') ?: ($attrs['http.host'] ?? null));
				$target = null;
				if ($db) {
					$target = 'db:'.$db.'@'.$svc;
					$node($target, 'db', (string) $db);
				}
				elseif ($ext) {
					$target = 'ext:'.$ext.'@'.$svc;
					$node($target, 'external', (string) $ext);
				}
				if ($target !== null) {
					$key = $edge($svc, $target);
					self::add($edges[$key]['acc'], $s, (string) $s['span_name']);
					self::add($nodes[$target]['acc'], $s, $svc.': '.$s['span_name']);
				}
			}
		}

		$final_nodes = [];
		foreach ($nodes as $id => $n) {
			$endpoints = [];
			foreach ($n['endpoints'] as $name => $acc) {
				$endpoints[] = ['name' => (string) $name] + self::stats($acc, $minutes);
			}
			usort($endpoints, static fn(array $a, array $b): int => $b['count'] <=> $a['count']);
			$final_nodes[] = [
				'id' => (string) $id,
				'kind' => $n['kind'],
				'label' => $n['label'],
				'lastSeen' => ($last_seen[$id] ?? 0.0) ?: $n['acc']['last'],
				'stats' => self::stats($n['acc'], $minutes),
				'endpoints' => $endpoints,
				'traces' => self::topTraces($n['acc']['samples'])
			];
		}
		$final_edges = [];
		foreach ($edges as $e) {
			$ops = [];
			foreach ($e['acc']['ops'] as $name => $count) {
				$ops[] = ['name' => (string) $name, 'rpm' => $count / $minutes];
			}
			usort($ops, static fn(array $a, array $b): int => $b['rpm'] <=> $a['rpm']);
			$final_edges[] = [
				'key' => $e['key'],
				'from' => $e['from'],
				'to' => $e['to'],
				'lastSeen' => $e['acc']['last'],
				'stats' => self::stats($e['acc'], $minutes),
				'ops' => $ops,
				'traces' => self::topTraces($e['acc']['samples'])
			];
		}

		return ['nodes' => $final_nodes, 'edges' => $final_edges];
	}

	/**
	 * Junta o que veio nos spans da janela com a topologia salva (known) e os hosts com itens apm.*:
	 * o que não teve tráfego na janela continua no mapa, marcado como idle. O que o usuário removeu
	 * (known.hidden, id => horário da remoção) só volta se tiver um span mais novo que a remoção.
	 *
	 * @param array $graph     Saída de buildGraph().
	 * @param array $known     ['nodes' => [[id, kind, label, lastSeen]], 'edges' => [[key, from, to, lastSeen]], 'hidden' => [id => ts]]
	 * @param array $apm_hosts Nomes técnicos dos hosts que têm o item apm.requests.
	 */
	public static function mergeKnown(array $graph, array $known, array $apm_hosts, int $minutes): array {
		$hidden_at = $known['hidden'] ?? [];
		$shown = static fn(string $id, $last): bool =>
			!array_key_exists($id, $hidden_at) || ((float) ($last ?? 0)) > (float) $hidden_at[$id];
		$idle_stats = self::stats(self::newAcc(), $minutes);

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

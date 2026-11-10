<?php declare(strict_types = 1);
// Mesmo que graph-parity.mjs, com o port PHP (zabbix_service_dashboard/includes/CGraph.php). O grafo de
// entrada é o que o buildGraph do JS montou (argv[2]); no módulo ele vem das contas do ClickHouse.

require __DIR__.'/../zabbix_service_dashboard/includes/CGraph.php';

use Modules\ServiceDashboard\Includes\CGraph;

$fixture = json_decode(file_get_contents($argv[1]), true);
$graph = json_decode(file_get_contents($argv[2]), true)['graph'];
$out = [
	'graph' => $graph,
	'seen' => CGraph::seenTopology($graph),
	'merged' => CGraph::mergeKnown($graph, $fixture['known'] ?? ['nodes' => [], 'edges' => [], 'hidden' => []],
		$fixture['apmHosts'] ?? [], (int) $fixture['minutes'])
];

function normalize($v) {
	if (is_array($v)) {
		if (array_is_list($v)) {
			return array_map('normalize', $v);
		}
		ksort($v, SORT_STRING);
		$out = [];
		foreach ($v as $k => $x) {
			if ($x !== null) {
				$out[(string) $k] = normalize($x);
			}
		}

		return $out ?: new stdClass();
	}
	if (is_float($v)) {
		return floor($v) == $v && abs($v) < 1e15 ? (int) $v : round($v, 6);
	}

	return $v;
}

// Listas vazias ficam [] (como no JS); objetos vazios viram {}.
echo json_encode(normalize($out), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

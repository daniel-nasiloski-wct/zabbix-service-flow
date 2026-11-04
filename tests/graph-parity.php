<?php declare(strict_types = 1);
// Mesmo que graph-parity.mjs, com o port PHP (zabbix_service_dashboard/includes/CGraph.php).

require __DIR__.'/../zabbix_service_dashboard/includes/CGraph.php';

use Modules\ServiceDashboard\Includes\CGraph;

$fixture = json_decode(file_get_contents($argv[1]), true);
$graph = CGraph::buildGraph($fixture['spans'], (int) $fixture['minutes']);
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

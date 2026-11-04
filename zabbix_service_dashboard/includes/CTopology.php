<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

use DB;

/**
 * Memória da topologia (serviços e ligações já vistos, por 7 dias) e das remoções manuais, guardada na
 * coluna `config` da própria linha do módulo na tabela `module` — o lugar que o Zabbix reserva para a
 * configuração de cada módulo. Nenhuma outra tabela é tocada. Payload compacto, com teto, para caber
 * no TEXT de 64 KB do MySQL.
 *
 * Formato em config['topology']:
 *   {"v":1, "n":{id:[kind,lastSeen]}, "e":{key:[from,to,lastSeen]}, "h":{id:hiddenAt}, "o":[ids]}
 *   kind: 0 service, 1 db, 2 external. A label é derivada do id (db:mysql@svc → "mysql").
 *   "o" é a ordem dos cards da visão geral escolhida no modo de edição (arrastar e soltar + Save).
 */
class CTopology {

	public const MODULE_ID = 'zabbix_service_dashboard';
	public const DAYS = 7;
	public const MAX_NODES = 400;
	public const MAX_EDGES = 1200;
	public const MAX_BYTES = 60000;
	/** lastSeen só é regravado quando avança pelo menos isto (evita um UPDATE a cada coleta). */
	public const WRITE_EVERY = 300;

	private const KINDS = ['service' => 0, 'db' => 1, 'external' => 2];
	private const KIND_NAMES = ['service', 'db', 'external'];

	private ?string $moduleid = null;
	private array $config = [];
	private array $state = ['v' => 1, 'n' => [], 'e' => [], 'h' => [], 'o' => []];
	private bool $dirty = false;

	public function __construct() {
		$rows = DB::select('module', ['output' => ['moduleid', 'config'], 'filter' => ['id' => self::MODULE_ID]]);
		if (!$rows) {
			return;
		}
		$this->moduleid = (string) $rows[0]['moduleid'];
		$config = json_decode((string) $rows[0]['config'], true);
		$this->config = is_array($config) ? $config : [];
		$state = $this->config['topology'] ?? null;
		if (is_array($state) && ($state['v'] ?? 0) === 1) {
			$this->state = ['v' => 1, 'n' => (array) ($state['n'] ?? []), 'e' => (array) ($state['e'] ?? []),
				'h' => (array) ($state['h'] ?? []),
				'o' => array_values(array_map('strval', (array) ($state['o'] ?? [])))
			];
		}
		$this->prune();
	}

	/** Topologia salva no formato que CGraph::mergeKnown() espera. */
	public function known(): array {
		$nodes = [];
		foreach ($this->state['n'] as $id => [$kind, $last_seen]) {
			$id = (string) $id;
			$nodes[] = ['id' => $id, 'kind' => self::KIND_NAMES[$kind] ?? 'service', 'label' => self::label($id, (int) $kind),
				'lastSeen' => $last_seen
			];
		}
		$edges = [];
		foreach ($this->state['e'] as $key => [$from, $to, $last_seen]) {
			$edges[] = ['key' => (string) $key, 'from' => (string) $from, 'to' => (string) $to, 'lastSeen' => $last_seen];
		}
		$hidden = [];
		foreach ($this->state['h'] as $id => $at) {
			$hidden[(string) $id] = $at;
		}

		return ['nodes' => $nodes, 'edges' => $edges, 'hidden' => $hidden, 'order' => $this->state['o']];
	}

	/** Ordem dos cards da visão geral (ids das aplicações), gravada pelo Save do modo de edição. */
	public function setOrder(array $ids): void {
		if ($this->moduleid === null) {
			return;
		}
		$this->state['o'] = array_slice(array_values(array_unique(array_map('strval', $ids))), 0, self::MAX_NODES);
		$this->dirty = true;
		$this->save();
	}

	/**
	 * Grava o que apareceu nos spans da janela (CGraph::seenTopology). Um span mais novo que a remoção
	 * traz o item de volta; um mais velho (ainda na janela) é ignorado.
	 */
	public function record(array $seen): void {
		if ($this->moduleid === null) {
			return;
		}
		$shown = [];
		foreach ($seen['nodes'] as $n) {
			$id = (string) $n['id'];
			$last = (int) floor((float) $n['lastSeen']);
			if (array_key_exists($id, $this->state['h'])) {
				if ($last <= (int) $this->state['h'][$id]) {
					continue;
				}
				unset($this->state['h'][$id]);
				$this->dirty = true;
			}
			$shown[$id] = true;
			$kind = self::KINDS[$n['kind']] ?? 0;
			$this->upsert('n', $id, [$kind, $last], 1);
		}
		foreach ($seen['edges'] as $e) {
			if (isset($shown[(string) $e['from']], $shown[(string) $e['to']])) {
				$this->upsert('e', (string) $e['key'], [(string) $e['from'], (string) $e['to'], (int) floor((float) $e['lastSeen'])], 2);
			}
		}
		$this->save();
	}

	/** Remove nós (e as ligações que os tocam) e anota o horário, para só voltarem com span mais novo. */
	public function remove(array $ids): void {
		if ($this->moduleid === null) {
			return;
		}
		$now = time();
		foreach ($ids as $id) {
			$id = (string) $id;
			unset($this->state['n'][$id]);
			foreach ($this->state['e'] as $key => [$from, $to]) {
				if ((string) $from === $id || (string) $to === $id) {
					unset($this->state['e'][$key]);
				}
			}
			$this->state['h'][$id] = $now;
		}
		$this->dirty = true;
		$this->save();
	}

	private function upsert(string $set, string $id, array $value, int $time_index): void {
		$current = $this->state[$set][$id] ?? null;
		if ($current === null) {
			$this->state[$set][$id] = $value;
			$this->dirty = true;

			return;
		}
		$stored = (int) $current[$time_index];
		if ($value[$time_index] > $stored) {
			$this->state[$set][$id][$time_index] = $value[$time_index];
			if ($value[$time_index] - $stored >= self::WRITE_EVERY) {
				$this->dirty = true;
			}
		}
	}

	private function prune(): void {
		$min = time() - self::DAYS * 86400;
		foreach ($this->state['n'] as $id => $v) {
			if (!is_array($v) || count($v) < 2 || (int) $v[1] < $min) {
				unset($this->state['n'][$id]);
				$this->dirty = true;
			}
		}
		foreach ($this->state['e'] as $key => $v) {
			if (!is_array($v) || count($v) < 3 || (int) $v[2] < $min
					|| !isset($this->state['n'][(string) $v[0]], $this->state['n'][(string) $v[1]])) {
				unset($this->state['e'][$key]);
				$this->dirty = true;
			}
		}
		foreach ($this->state['h'] as $id => $at) {
			if ((int) $at < $min) {
				unset($this->state['h'][$id]);
				$this->dirty = true;
			}
		}
	}

	/** Teto: descarta primeiro o que foi visto há mais tempo. */
	private function cap(): void {
		if (count($this->state['n']) > self::MAX_NODES) {
			uasort($this->state['n'], static fn(array $a, array $b): int => $b[1] <=> $a[1]);
			$this->state['n'] = array_slice($this->state['n'], 0, self::MAX_NODES, true);
			foreach ($this->state['e'] as $key => [$from, $to]) {
				if (!isset($this->state['n'][(string) $from], $this->state['n'][(string) $to])) {
					unset($this->state['e'][$key]);
				}
			}
		}
		if (count($this->state['e']) > self::MAX_EDGES) {
			uasort($this->state['e'], static fn(array $a, array $b): int => $b[2] <=> $a[2]);
			$this->state['e'] = array_slice($this->state['e'], 0, self::MAX_EDGES, true);
		}
	}

	private function save(): void {
		if (!$this->dirty || $this->moduleid === null) {
			return;
		}
		$this->cap();
		$json = $this->encode();
		// Ainda grande demais para a coluna: aperta mais os tetos até caber.
		while (strlen($json) > self::MAX_BYTES && ($this->state['n'] || $this->state['e'])) {
			uasort($this->state['n'], static fn(array $a, array $b): int => $b[1] <=> $a[1]);
			$this->state['n'] = array_slice($this->state['n'], 0, max(1, (int) (count($this->state['n']) * 0.8)), true);
			foreach ($this->state['e'] as $key => [$from, $to]) {
				if (!isset($this->state['n'][(string) $from], $this->state['n'][(string) $to])) {
					unset($this->state['e'][$key]);
				}
			}
			$json = $this->encode();
		}
		DB::update('module', [['values' => ['config' => $json], 'where' => ['moduleid' => $this->moduleid]]]);
		$this->dirty = false;
	}

	private function encode(): string {
		$config = $this->config;
		$config['topology'] = [
			'v' => 1,
			'n' => (object) $this->state['n'],
			'e' => (object) $this->state['e'],
			'h' => (object) $this->state['h'],
			'o' => array_values($this->state['o'])
		];

		return json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
	}

	private static function label(string $id, int $kind): string {
		if ($kind === 0) {
			return $id;
		}
		$colon = strpos($id, ':');
		$at = strrpos($id, '@');
		if ($colon === false || $at === false || $at <= $colon) {
			return $id;
		}

		return substr($id, $colon + 1, $at - $colon - 1);
	}
}

<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

use CProfile;

/**
 * Filtro por atributos, igual ao de APM → Traces: condições sobre atributos de recurso e de span
 * (Exists, Equals, Contains, Does not exist, Does not equal, Does not contain; And/Or ou Or), com os
 * mesmos nomes de campo (filter_resource_attributes[…], filter_span_attributes[…]) e guardado no perfil
 * do usuário (tabela profiles, como o Zabbix faz com os próprios filtros). As condições vão direto
 * para apmspan.get, que já as traduz para o ClickHouse.
 */
class CSpanFilter {

	public const PROFILE = 'web.servicedashboard.filter';
	public const TYPES = ['resource', 'span'];

	/**
	 * O filtro por atributos existe no frontend a partir do 8.0.0rc3 (CTagFilterFieldHelper::FILTER_TYPE_APM_ATTRIBUTE,
	 * class.apm.attrfilteritem.js e resource_attributes/span_attributes em apmspan.get). Em versões
	 * anteriores o módulo funciona sem o filtro, em vez de dar erro fatal na página.
	 */
	public static function supported(): bool {
		return defined('CTagFilterFieldHelper::FILTER_TYPE_APM_ATTRIBUTE');
	}

	private const OPERATORS = [TAG_OPERATOR_EXISTS, TAG_OPERATOR_EQUAL, TAG_OPERATOR_LIKE, TAG_OPERATOR_NOT_EXISTS,
		TAG_OPERATOR_NOT_EQUAL, TAG_OPERATOR_NOT_LIKE
	];

	/** Regras de validação (validador novo) dos campos do filtro, com o prefixo dos nomes. */
	public static function rules(string $prefix = 'filter_'): array {
		$rules = [];
		foreach (self::TYPES as $type) {
			$rules[$prefix.$type.'_attributes_evaltype'] = ['integer', 'in' => [TAG_EVAL_TYPE_AND_OR, TAG_EVAL_TYPE_OR]];
			$rules[$prefix.$type.'_attributes'] = ['array',
				'field' => ['object', 'fields' => [
					'key' => ['string'],
					'operator' => ['integer', 'in' => self::OPERATORS],
					'value' => ['string']
				]]
			];
		}

		return $rules;
	}

	/** Filtro limpo a partir dos campos recebidos: só linhas com chave; operador e valor saneados. */
	public static function normalize(array $input, string $prefix = 'filter_'): array {
		if (!self::supported()) {
			$input = [];
		}
		$filter = [];
		foreach (self::TYPES as $type) {
			$evaltype = (int) ($input[$prefix.$type.'_attributes_evaltype'] ?? TAG_EVAL_TYPE_AND_OR);
			$filter[$type.'_attributes_evaltype'] = $evaltype == TAG_EVAL_TYPE_OR ? TAG_EVAL_TYPE_OR : TAG_EVAL_TYPE_AND_OR;
			$filter[$type.'_attributes'] = [];
			foreach ((array) ($input[$prefix.$type.'_attributes'] ?? []) as $row) {
				if (!is_array($row)) {
					continue;
				}
				$key = trim((string) ($row['key'] ?? ''));
				if ($key === '') {
					continue;
				}
				$operator = (int) ($row['operator'] ?? TAG_OPERATOR_LIKE);
				if (!in_array($operator, self::OPERATORS, true)) {
					$operator = TAG_OPERATOR_LIKE;
				}
				$value = in_array($operator, [TAG_OPERATOR_EXISTS, TAG_OPERATOR_NOT_EXISTS], true)
					? ''
					: (string) ($row['value'] ?? '');
				$filter[$type.'_attributes'][] = ['key' => $key, 'operator' => $operator, 'value' => $value];
			}
		}

		return $filter;
	}

	public static function isActive(array $filter): bool {
		foreach (self::TYPES as $type) {
			if (!empty($filter[$type.'_attributes'])) {
				return true;
			}
		}

		return false;
	}

	/** Filtro salvo no perfil do usuário (vazio se nunca aplicou). */
	public static function load(): array {
		$input = [];
		foreach (self::TYPES as $type) {
			$input['filter_'.$type.'_attributes_evaltype'] = CProfile::get(self::PROFILE.'_'.$type.'_attributes_evaltype',
				TAG_EVAL_TYPE_AND_OR
			);
			$rows = [];
			foreach (CProfile::getArray(self::PROFILE.'_'.$type.'_attributes.key', []) as $i => $key) {
				$rows[] = [
					'key' => $key,
					'value' => CProfile::get(self::PROFILE.'_'.$type.'_attributes.value', '', $i),
					'operator' => CProfile::get(self::PROFILE.'_'.$type.'_attributes.operator', TAG_OPERATOR_LIKE, $i)
				];
			}
			$input['filter_'.$type.'_attributes'] = $rows;
		}

		return self::normalize($input);
	}

	public static function save(array $filter): void {
		foreach (self::TYPES as $type) {
			CProfile::update(self::PROFILE.'_'.$type.'_attributes_evaltype', $filter[$type.'_attributes_evaltype'],
				PROFILE_TYPE_INT
			);
			$rows = $filter[$type.'_attributes'];
			CProfile::updateArray(self::PROFILE.'_'.$type.'_attributes.key', array_column($rows, 'key'), PROFILE_TYPE_STR);
			CProfile::updateArray(self::PROFILE.'_'.$type.'_attributes.value', array_column($rows, 'value'),
				PROFILE_TYPE_STR
			);
			CProfile::updateArray(self::PROFILE.'_'.$type.'_attributes.operator', array_column($rows, 'operator'),
				PROFILE_TYPE_INT
			);
		}
		// Como no Zabbix: só força a aba aberta quando há condições; sem condições, fica como o usuário
		// deixou (a aba recolhida/expandida é gravada pelo próprio JS do CFilter em ".active").
		if (self::isActive($filter)) {
			CProfile::update(self::PROFILE.'.active', 1, PROFILE_TYPE_INT);
		}
	}

	public static function reset(): void {
		foreach (self::TYPES as $type) {
			CProfile::delete(self::PROFILE.'_'.$type.'_attributes_evaltype');
			CProfile::deleteIdx(self::PROFILE.'_'.$type.'_attributes.key');
			CProfile::deleteIdx(self::PROFILE.'_'.$type.'_attributes.value');
			CProfile::deleteIdx(self::PROFILE.'_'.$type.'_attributes.operator');
		}
	}

	/** Parâmetros extras para API::ApmSpan()->get(). */
	public static function apiOptions(array $filter): array {
		$options = [];
		foreach (self::TYPES as $type) {
			if (!empty($filter[$type.'_attributes'])) {
				$options[$type.'_attributes'] = $filter[$type.'_attributes'];
				$options[$type.'_attributes_evaltype'] = $filter[$type.'_attributes_evaltype'];
			}
		}

		return $options;
	}

	/** Sufixo da assinatura do cache: filtros diferentes não compartilham coleta. */
	public static function signature(array $filter): string {
		return self::isActive($filter) ? 'f'.substr(md5(json_encode($filter)), 0, 12) : '';
	}
}

<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Actions;

use CController;
use CControllerResponseData;
use Modules\ServiceDashboard\Includes\CCache;
use Modules\ServiceDashboard\Includes\CI18n;
use Modules\ServiceDashboard\Includes\CTopology;
use Throwable;

/**
 * POST JSON {"ids": [...], "_csrf_token": "..."} → tira aplicação/serviço do mapa (só da memória do
 * módulo; nada muda no Zabbix). O item volta sozinho se chegar um span mais novo que a remoção.
 * Permitido a Admin e Super admin.
 */
class CControllerServiceDashboardRemove extends CController {

	protected function init(): void {
		$this->setInputValidationMethod(self::INPUT_VALIDATION_FORM);
		$this->setPostContentType(self::POST_CONTENT_TYPE_JSON);
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput(['object', 'fields' => [
			'ids' => ['array', 'required', 'field' => ['string', 'required', 'not_empty', 'length' => 255]]
		]]);

		if (!$ret) {
			$this->json(['error' => CI18n::t('Nothing to remove')]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN;
	}

	protected function doAction(): void {
		$ids = array_values(array_unique(array_map('strval', $this->getInput('ids', []))));

		try {
			if (!$ids) {
				throw new \RuntimeException(CI18n::t('Nothing to remove'));
			}
			CCache::exclusive(static function () use ($ids): void {
				(new CTopology())->remove($ids);
			});
			CCache::invalidateAll();
			$this->json(['removed' => count($ids)]);
		}
		catch (Throwable $e) {
			$this->json(['error' => $e->getMessage()]);
		}
	}

	private function json(array $out): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($out)]));
	}
}

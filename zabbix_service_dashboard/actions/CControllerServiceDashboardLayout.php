<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Actions;

use CController;
use CControllerResponseData;
use Modules\ServiceDashboard\Includes\CCache;
use Modules\ServiceDashboard\Includes\CI18n;
use Modules\ServiceDashboard\Includes\CTopology;
use Throwable;

/**
 * POST JSON {"order": [ids…], "_csrf_token": "..."} → guarda a ordem dos cards da visão geral (o "Save"
 * do modo de edição), na mesma linha do módulo da tabela `module`. Permitido a Admin e Super admin.
 */
class CControllerServiceDashboardLayout extends CController {

	protected function init(): void {
		$this->setInputValidationMethod(self::INPUT_VALIDATION_FORM);
		$this->setPostContentType(self::POST_CONTENT_TYPE_JSON);
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput(['object', 'fields' => [
			'order' => ['array', 'required', 'field' => ['string', 'required', 'not_empty', 'length' => 255]]
		]]);

		if (!$ret) {
			$this->json(['error' => CI18n::t('Nothing to save')]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN;
	}

	protected function doAction(): void {
		$order = array_values(array_unique(array_map('strval', $this->getInput('order', []))));

		try {
			CCache::exclusive(static function () use ($order): void {
				(new CTopology())->setOrder($order);
			});
			CCache::invalidateAll();
			$this->json(['saved' => count($order)]);
		}
		catch (Throwable $e) {
			$this->json(['error' => $e->getMessage()]);
		}
	}

	private function json(array $out): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($out)]));
	}
}

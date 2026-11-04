<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Actions;

use CController;
use CControllerResponseData;
use CWebUser;
use Modules\ServiceDashboard\Includes\CCache;
use Modules\ServiceDashboard\Includes\CCollector;
use Modules\ServiceDashboard\Includes\CI18n;
use Modules\ServiceDashboard\Includes\CSpanFilter;
use Throwable;

/**
 * GET zabbix.php?action=servicedashboard.data&minutes=15[&filter_*…] → JSON com o grafo pronto e os
 * dados do Zabbix (hosts, itens, histórico, triggers). Coleta no máximo uma vez a cada 30 s por janela,
 * por filtro e por "visão" (Super admins compartilham; os demais usuários têm cache próprio, porque a
 * API filtra os spans pelas permissões de cada um). Erros voltam como {"error": "..."} com HTTP 200.
 */
class CControllerServiceDashboardData extends CController {

	protected function init(): void {
		$this->setInputValidationMethod(self::INPUT_VALIDATION_FORM);
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput(['object', 'fields' => [
			'minutes' => ['integer', 'required', 'in' => CControllerServiceDashboardView::WINDOWS]
		] + CSpanFilter::rules()]);

		if (!$ret) {
			$this->json(['error' => CI18n::t('Invalid time range or filter')]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
	}

	protected function doAction(): void {
		$minutes = (int) $this->getInput('minutes');
		$filter = CSpanFilter::normalize($this->getInputAll());
		$signature = ($this->getUserType() == USER_TYPE_SUPER_ADMIN ? 'sa' : 'u'.CWebUser::$data['userid'])
			.CSpanFilter::signature($filter);

		try {
			$json = CCache::get($signature, $minutes, static fn(): array => CCollector::snapshot($minutes, $filter));
		}
		catch (Throwable $e) {
			$json = json_encode(['error' => $e->getMessage()]);
		}

		$this->setResponse(new CControllerResponseData(['main_block' => $json]));
	}

	private function json(array $out): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($out)]));
	}
}

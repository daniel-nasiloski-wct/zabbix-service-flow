<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Actions;

use APP;
use CController;
use CControllerResponseData;
use CControllerResponseFatal;
use CCsrfTokenHelper;
use CProfile;
use CSettingsHelper;
use CWebUser;
use Modules\ServiceDashboard\Includes\CI18n;
use Modules\ServiceDashboard\Includes\CSpanFilter;

/**
 * Página APM → APM dashboard: só entrega o HTML com o ponto de montagem e o bootstrap do JS;
 * os dados vêm por servicedashboard.data. O filtro por atributos (igual ao de APM → Traces) é
 * aplicado com filter_set=1 e guardado no perfil do usuário; filter_rst=1 limpa.
 */
class CControllerServiceDashboardView extends CController {

	public const WINDOWS = [5, 15, 30, 60];

	protected function init(): void {
		$this->setInputValidationMethod(self::INPUT_VALIDATION_FORM);
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput(['object', 'fields' => [
			'service' => ['string', 'length' => 255],
			'minutes' => ['integer', 'in' => self::WINDOWS],
			'filter_set' => ['integer', 'in' => [1]],
			'filter_rst' => ['integer', 'in' => [1]]
		] + CSpanFilter::rules()]);

		if (!$ret) {
			$this->setResponse(new CControllerResponseFatal());
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
	}

	protected function doAction(): void {
		$module = APP::ModuleManager()->getModule('zabbix_service_dashboard');
		$version = $module !== null ? $module->getVersion() : '0';

		if ($this->hasInput('filter_set')) {
			CSpanFilter::save(CSpanFilter::normalize($this->getInputAll()));
		}
		elseif ($this->hasInput('filter_rst')) {
			CSpanFilter::reset();
		}
		$filter = CSpanFilter::load();

		$data = [
			'version' => $version,
			'action' => $this->getAction(),
			'filter' => $filter,
			'filter_idx' => CSpanFilter::PROFILE,
			// Recolhido até o usuário abrir (o Zabbix lembra a escolha em .active); Apply deixa aberto.
			'active_tab' => (int) CProfile::get(CSpanFilter::PROFILE.'.active', 0),
			'bootstrap' => [
				'viewUrl' => 'zabbix.php?action=servicedashboard.view',
				'dataUrl' => 'zabbix.php?action=servicedashboard.data',
				'removeUrl' => 'zabbix.php?action=servicedashboard.remove',
				'layoutUrl' => 'zabbix.php?action=servicedashboard.layout',
				'csrf' => CCsrfTokenHelper::get('servicedashboard.remove'),
				'csrfLayout' => CCsrfTokenHelper::get('servicedashboard.layout'),
				'canRemove' => $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN,
				// Idioma do usuário (pt_BR, de_DE…; "default" = o do sistema) para números/horas, e o
				// dicionário dos textos do mapa já traduzidos pelo gettext do módulo.
				'lang' => (CWebUser::$data['lang'] ?? 'default') !== 'default'
					? CWebUser::$data['lang']
					: CSettingsHelper::get(CSettingsHelper::DEFAULT_LANG),
				'i18n' => CI18n::strings(),
				'minutes' => (int) $this->getInput('minutes', 15),
				'service' => (string) $this->getInput('service', ''),
				'windows' => self::WINDOWS,
				'refreshMs' => 30000,
				'frontend' => '',
				'filter' => $filter,
				'filtered' => CSpanFilter::isActive($filter),
				'version' => $version
			]
		];

		$response = new CControllerResponseData($data);
		$response->setTitle(CI18n::t('APM dashboard'));
		$this->setResponse($response);
	}
}

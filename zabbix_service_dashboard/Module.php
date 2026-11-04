<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard;

use APP;
use CMenuItem;
use CRoleHelper;
use CWebUser;
use Modules\ServiceDashboard\Includes\CI18n;
use Throwable;
use Zabbix\Core\CModule as CModuleBase;

/**
 * Módulo "APM dashboard": acrescenta APM → APM dashboard ao menu principal.
 * Tudo roda no frontend com a sessão do usuário logado; nada é alterado no Zabbix.
 */
class Module extends CModuleBase {

	public function init(): void {
		try {
			$this->addMenuItem();
		}
		catch (Throwable $e) {
			// O menu nunca pode derrubar as outras páginas do frontend.
			error_log('zabbix_service_dashboard: menu not added: '.$e->getMessage());
		}
	}

	private function addMenuItem(): void {
		// Textos do módulo saem do gettext do próprio módulo (locale/), no idioma do usuário; os do
		// Zabbix (APM, Logs, Monitoring) continuam no _() do core.
		$item = (new CMenuItem(CI18n::t('APM dashboard')))->setAction('servicedashboard.view');
		$menu = APP::Component()->get('menu.main');

		// A seção APM só existe para quem tem acesso a Traces, Metrics ou Logs; para os demais, Monitoring.
		if ($this->hasApmMenu()) {
			$submenu = $menu->findOrAdd(_('APM'))->getSubMenu();
			if ($submenu->find(_('Logs')) !== null) {
				$submenu->insertAfter(_('Logs'), $item);
			}
			else {
				$submenu->add($item);
			}
		}
		else {
			$menu->findOrAdd(_('Monitoring'))->getSubMenu()->add($item);
		}
	}

	private function hasApmMenu(): bool {
		foreach (['UI_APM_TRACES', 'UI_APM_METRICS', 'UI_APM_LOGS'] as $rule) {
			if (defined(CRoleHelper::class.'::'.$rule) && CWebUser::checkAccess(constant(CRoleHelper::class.'::'.$rule))) {
				return true;
			}
		}

		return false;
	}
}

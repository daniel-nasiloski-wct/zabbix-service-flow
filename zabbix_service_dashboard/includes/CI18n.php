<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

/**
 * Tradução do módulo nas regras do Zabbix: gettext, no idioma que o usuário escolheu no perfil (o core
 * já fez o setlocale), com um domínio próprio (locale/<idioma>/LC_MESSAGES/zabbix_service_dashboard.mo)
 * ao lado do domínio "frontend" do Zabbix. Os textos do mapa (React) são traduzidos aqui e entregues ao
 * navegador no bootstrap, como um dicionário {inglês: traduzido}.
 */
class CI18n {

	public const DOMAIN = 'zabbix_service_dashboard';

	private static bool $bound = false;

	public static function bind(): void {
		if (self::$bound) {
			return;
		}
		self::$bound = true;
		if (function_exists('bindtextdomain')) {
			bindtextdomain(self::DOMAIN, dirname(__DIR__).'/locale');
			if (function_exists('bind_textdomain_codeset')) {
				bind_textdomain_codeset(self::DOMAIN, 'UTF-8');
			}
		}
	}

	/** Traduz um texto do módulo (o inglês é a chave, como no _() do Zabbix). */
	public static function t(string $text): string {
		self::bind();

		return function_exists('dgettext') ? dgettext(self::DOMAIN, $text) : $text;
	}

	/** Dicionário {inglês: traduzido} com todos os textos usados pelo JavaScript do mapa. */
	public static function strings(): array {
		$out = [];
		foreach (self::JS_STRINGS as $text) {
			$translated = self::t($text);
			if ($translated !== $text) {
				$out[$text] = $translated;
			}
		}

		return $out;
	}

	/** Todos os textos do JavaScript (src/). Manter em dia com t('…') no código e com o .pot. */
	private const JS_STRINGS = [
		// Dashboard.jsx
		'Application',
		'Time range',
		'All applications (overview)',
		'Last %1$s minutes',
		'Overview',
		'Back to %1$s',
		'Actions',
		'Edit',
		'Remove application',
		'Remove service',
		'Remove application "%1$s" from the map?',
		'Remove service "%1$s" from the map?',
		'Its services, databases and external calls leave the map. Services shared with other applications stay.',
		'The service, its connections, databases and external calls leave the map.',
		'If the application is discovered again in new traces, it is recreated automatically, with all its entities.',
		'If the service is discovered again in new traces, it is recreated automatically, with all its entities.',
		'Hosts, items and triggers in Zabbix are not changed.',
		'Cancel',
		'Remove',
		'Remove %1$s',
		'No data found',
		'No APM span matches the attribute filter in the selected time range. Change the filter above or press Reset to see everything.',
		'No APM traces in the selected time range and no host with the apm.requests item. Services appear here as soon as the applications send traces to the Zabbix proxy.',
		'Could not save the layout: %1$s',
		// FlowMap.jsx / graph.js
		'Service',
		'Database',
		'External service',
		'Application · %1$s services',
		'No traffic in the window',
		'last span %1$s',
		'no spans seen yet',
		'%1$s req/min',
		'%1$s calls/min',
		'p95 %1$s',
		'%1$s errors/min',
		'%1$s errors',
		// Tooltip.jsx
		'Traces (errors and slowest)',
		'Requests/min',
		'Calls/min',
		'Average',
		'Errors',
		'p95 latency',
		'Logs ERROR/min',
		'No traffic in the selected time range.',
		'Last span %1$s (%2$s).',
		'No spans seen yet.',
		'Zabbix problems',
		'Zabbix items (host %1$s, last 30 min)',
		'Inbound spans (traces)',
		'Incoming calls (traces)',
		'Endpoints',
		'Operation',
		'req/min',
		'p95',
		'errors',
		'Operations',
		'%1$s/min',
		'Open host problems in Zabbix',
		// format.js
		'%1$s ms',
		'%1$s s',
		'%1$s s ago',
		'%1$s min ago',
		'%1$s h ago',
		'%1$s d ago',
		'Not classified',
		'Information',
		'Warning',
		'High',
		'Disaster',
		'OK',
		'Incident',
		'No Zabbix host'
	];
}

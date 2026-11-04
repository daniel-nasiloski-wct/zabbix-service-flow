<?php
/**
 * Página APM → APM dashboard. Só o ponto de montagem do mapa e o bootstrap; o bundle React
 * (assets/js) e o CSS (assets/css) são carregados aqui, e não pelo manifest, para não pesarem nas
 * outras páginas do Zabbix. O filtro por atributos é o mesmo componente de APM → Traces (CFilter +
 * CTagFilterFieldHelper), com o JS do próprio Zabbix (dynamicRows e CApmAttrFilterItem já vêm
 * carregados em todas as páginas; incluir class.apm.attrfilteritem.js de novo dá "already declared").
 *
 * @var CView $this
 * @var array $data
 */

use Modules\ServiceDashboard\Includes\CI18n;

$assets = $this->getAssetsPath();
// Versão + data do bundle no ?v=: qualquer atualização fura o cache do navegador sem hard refresh.
$built = @filemtime(__DIR__.'/../assets/js/service-dashboard.js') ?: 0;
$version = rawurlencode($data['version'].'-'.$built);

$this->addCssFile($assets.'/css/service-dashboard.css?v='.$version);
// Modo kiosk como nas páginas de dashboard do core: enableLayoutModes() faz o layout (ZBase lê
// $view->getLayoutMode()) esconder barra lateral, cabeçalho e rodapé; sem isso só o título some.
// O botão de get_icon('kioskmode') é só HTML; quem trata o clique (grava web.layout.mode e recarrega)
// é o layout.mode.js do core, que cada página precisa pedir.
$this->enableLayoutModes();
$web_layout_mode = $this->getLayoutMode();
$this->addJsFile('layout.mode.js');

// O filtro por atributos só existe a partir do 8.0.0rc3 (constante, JS e parâmetros da API); em
// frontends anteriores a página sai sem ele (CSpanFilter::supported()), em vez de erro fatal.
$filter = null;
$filter_fields = (new CFormGrid())->addClass(CFormGrid::ZBX_STYLE_FORM_GRID_LABEL_WIDTH_TRUE);
foreach ($data['filter_supported'] ? ['resource' => _('Resource attributes'), 'span' => _('Span attributes')] : [] as $type => $label) {
	$filter_fields->addItem([
		new CLabel($label, 'filter_'.$type.'_attributes'),
		new CFormField(
			CTagFilterFieldHelper::getTagFilterField([
				'evaltype' => $data['filter'][$type.'_attributes_evaltype'],
				'tags' => $data['filter'][$type.'_attributes'] ?: [
					['key' => '', 'value' => '', 'operator' => TAG_OPERATOR_LIKE]
				]
			], [
				'tag_field_name' => 'filter_'.$type.'_attributes',
				'evaltype_field_name' => 'filter_'.$type.'_attributes_evaltype',
				'filter_type' => CTagFilterFieldHelper::FILTER_TYPE_APM_ATTRIBUTE
			])->setId('filter-'.$type.'-attributes')
		)
	]);
}

// service/minutes viajam escondidos no formulário para o Apply não perder a aplicação e a janela
// escolhidas; o JS abaixo copia os valores atuais da URL antes de enviar.
if ($data['filter_supported']) {
	$filter = (new CFilter())
		->setId('servicedashboard_filter')
		->setResetUrl((new CUrl('zabbix.php'))->setArgument('action', $data['action']))
		->setProfile($data['filter_idx'])
		->setActiveTab($data['active_tab'])
		->addVar('action', $data['action'], 'filter_action')
		->addVar('service', $data['bootstrap']['service'], 'filter_service')
		->addVar('minutes', (string) $data['bootstrap']['minutes'], 'filter_minutes')
		->addFilterTab(_('Filter'), [$filter_fields]);

	// No kiosk o filtro fica escondido (CFilter::setHidden(), o JS do filtro não o mostra), como nas
	// páginas do core: senão o botão "Filter" fica embaixo do controle de sair do kiosk, que aparece
	// no canto quando o mouse se mexe.
	if ($web_layout_mode == ZBX_LAYOUT_KIOSKMODE) {
		$filter->setHidden();
	}
}

// Controles do cabeçalho como no dashboard: menu de ações (ZBX_STYLE_BTN_ACTION + ZBX_ICON_MENU; o
// React abre o menuPopup do Zabbix com "Edit") e o botão de kiosk. No modo de edição o React troca
// essa lista pela de baixo ("Save" + "Cancel"), como o dashboard troca para "Save changes".
$view_actions = new CList();
if ($data['bootstrap']['canRemove']) {
	$view_actions->addItem(
		(new CSimpleButton())
			->addClass(ZBX_STYLE_BTN_ACTION)
			->addClass(ZBX_ICON_MENU)
			->setId('service-dashboard-actions')
			->setHint(CI18n::t('Actions'), '', false)
			->setAttribute('aria-haspopup', true)
			->setAttribute('aria-label', CI18n::t('Actions'))
	);
}
$view_actions->addItem(get_icon('kioskmode', ['mode' => $web_layout_mode]));

$controls = (new CList())
	->setId('service-dashboard-control')
	->addItem(
		(new CListItem(
			(new CTag('nav', true, $view_actions))->setAttribute('aria-label', _('Content controls'))
		))->addClass('js-sd-view-actions')
	)
	->addItem(
		(new CListItem(
			(new CTag('nav', true, new CList([
				new CButton('service-dashboard-save', CI18n::t('Save')),
				(new CLink(CI18n::t('Cancel'), '#'))->setId('service-dashboard-cancel')
			])))->setAttribute('aria-label', _('Content controls'))
		))
			->addClass('js-sd-edit-actions')
			->addStyle('display: none')
	);

(new CHtmlPage())
	->setTitle(CI18n::t('APM dashboard'))
	->setWebLayoutMode($web_layout_mode)
	->setControls($controls)
	// Linha de navegação (a mesma da trilha "All dashboards / …" do dashboard, que divide a linha com
	// o botão do filtro): o React monta aqui os seletores de aplicação e janela e os contadores.
	->setNavigation(new CList([(new CDiv())->setId('service-dashboard-nav')->addClass('service-dashboard')]))
	->addItem($filter)
	->addItem(
		(new CDiv())
			->setId('service-dashboard-root')
			->addClass('service-dashboard')
	)
	->show();

foreach ($data['filter_supported'] ? ['resource', 'span'] : [] as $type) {
	(new CTemplateTag('filter-'.$type.'-attributes-row-tmpl'))
		->addItem(
			CTagFilterFieldHelper::getTemplate([
				'tag_field_name' => 'filter_'.$type.'_attributes',
				'filter_type' => CTagFilterFieldHelper::FILTER_TYPE_APM_ATTRIBUTE
			])
		)
		->show();
}

echo (new CScriptTag(
	'window.SERVICE_DASHBOARD = '.json_encode($data['bootstrap'],
		JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES
	).';'
));

(new CScriptTag('
	for (const type of '.json_encode($data['filter_supported'] ? ['resource', 'span'] : []).') {
		jQuery("#filter-" + type + "-attributes")
			.dynamicRows({template: "#filter-" + type + "-attributes-row-tmpl"})
			.on("afteradd.dynamicRows", function () {
				const rows = this.querySelectorAll(".form_row");
				new CApmAttrFilterItem(rows[rows.length - 1]);
			});
		document.querySelectorAll("#filter-" + type + "-attributes .form_row").forEach((row) => {
			new CApmAttrFilterItem(row);
		});
	}
	const form = document.forms["zbx_filter"];
	if (form) {
		form.addEventListener("submit", () => {
			const params = new URLSearchParams(location.search);
			form.querySelector("#filter_service").value = params.get("service") || "";
			form.querySelector("#filter_minutes").value = params.get("minutes") || "'.(int) $data['bootstrap']['minutes'].'";
		});
	}
'))
	->setOnDocumentReady()
	->show();

echo (new CTag('script', true))
	->setAttribute('type', 'module')
	->setAttribute('src', $assets.'/js/service-dashboard.js?v='.$version);

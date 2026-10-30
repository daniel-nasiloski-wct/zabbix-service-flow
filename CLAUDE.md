# zabbix-service-flow

Mapa de serviços estilo New Relic para o APM do Zabbix 8.0, no tema Dark blue. É um frontend React (Vite) à parte, que fala direto com a API do Zabbix; não é dashboard nem mapa do Zabbix. Criado em 2026-10-30 a pedido do usuário, junto com o lab de APM em `../` (projeto `Zabbix_telemetry`). Repo privado: https://github.com/daniel-nasiloski-wct/zabbix-service-flow

## Rodar

```bash
npm install
npm run dev        # http://localhost:5173 (escuta em 0.0.0.0)
npm run build      # gera dist/
```

- Login com usuário do Zabbix (`user.login`); no lab, `Admin`/`zabbix`. O token fica no `sessionStorage` (`zabbix-service-flow-session`), só na aba.
- `.env`: `VITE_ZABBIX_URL=http://192.168.128.100/api_jsonrpc.php` (a `.100` do lab, server + frontend 8.0.0rc3). Pode ser trocado na tela de login. O frontend do Zabbix é a mesma URL sem `api_jsonrpc.php` (usado nos links).
- A API do Zabbix já responde CORS (`Access-Control-Allow-Origin: *`): o navegador chama direto, sem proxy no Vite.
- Dependências fixas: React 18.3.1, Vite 5.4.11, `@vitejs/plugin-react` 4.3.4. Sem outras bibliotecas (nada de libs de grafo ou gráfico).
- Rodar em segundo plano só quando o usuário pedir.

## Dados de teste

Os dados vêm do `multi_app.py` (repo público `daniel-nasiloski-wct/zabbix-clickhouse`): 4 aplicações de clientes diferentes (`service.namespace`) e 17 serviços, enviando OTLP para o proxy na `.101`; os hosts ficam na `.100`, grupo `apps`.

```bash
.venv/bin/python zabbix-clickhouse/multi_app.py --iterations 300 --interval 2 [--incident]
```

Rodar da raiz do `Zabbix_telemetry`.

| Aplicação | Entrada | Serviços |
| --- | --- | --- |
| loja-online | `checkout-demo` | catalog-api, auth-service, payment-gateway, shipping-service |
| banco-digital | `bank-portal` | account-service, fraud-engine, notification-service |
| streaming | `stream-hub` | entitlement-service, media-service, recommendation-service |
| logistica | `fleet-tracker` | telemetry-ingest, routing-engine → traffic-service |

`--incident` sorteia um serviço e um modo (latência ou erros) para a execução inteira. As triggers disparam 2 a 3 min após o início e só fecham após 5 min no normal (regra do usuário: incidente não pode fechar na iteração seguinte). Os hosts, itens e triggers são criados pelo `apm_hosts.py` (raiz do `Zabbix_telemetry`, fora do git).

## Contrato com o Zabbix

- **Host = `service.name`.** Cada serviço é ligado ao host com exatamente o mesmo nome técnico (`host.get` com `filter.host`). Serviço sem host fica cinza ("No Zabbix host").
- Itens lidos por key: `apm.requests`, `apm.latency.p95`, `apm.errors`, `apm.logs.error` (`ITEM_KEYS` em `src/zabbix.js`). São os dependentes JSONPath dos itens Telemetry query do manual; o item bruto de erros tem key `apm.error.raw`.
- Triggers: `trigger.get` com `value=1`, `monitored`, `skipDependent`, `expandDescription`. Os nomes das triggers e dos problemas vêm do Zabbix e estão em português (ex.: "checkout-demo: latência p95 alta").
- Link de trace: `zabbix.php?action=apm.trace.list&filter_set=1&filter_traceid=<id>&from=now-1h&to=now`. Link de problemas do host: página de problemas filtrada pelo hostid.

## Código (`src/`)

| Arquivo | O que faz |
| --- | --- |
| `zabbix.js` | Cliente JSON-RPC mínimo (Bearer token) e `loadData`: `apmspan.get` (janela de 5 a 60 min, até 50000 spans), `host.get`, `item.get`, `history.get` (30 min, float) e `trigger.get` |
| `graph.js` | `buildGraph` (nós e ligações a partir dos spans), `applyHealth` (estado pelo Zabbix), `layout` (colunas), `tenants` (aplicações) e `overviewLayout` (grade da visão geral) |
| `App.jsx` | Topo (dropdown de aplicação/serviço, janela de tempo, contadores, sair), trilha, legenda; atualiza a cada 30 s; serviço selecionado vai no hash da URL |
| `FlowMap.jsx` | Desenho e animação do mapa, hover e foco |
| `Tooltip.jsx` | Detalhes no hover: itens do Zabbix com sparkline de 30 min, problemas, endpoints, traces (erro primeiro, depois os mais lentos) |
| `Login.jsx`, `format.js`, `styles.css`, `main.jsx` | Login, formatação `en-US` e rótulos de severidade/estado, tema |

### Regras do grafo

- Ligação entre serviços: span filho (`parent_spanid`) em outro serviço; a estatística (chamadas/min, p95, média, erros, operações) vem do span CLIENT do chamador.
- Bancos (`db.system`) e externos (`server.address`) viram um nó por chamador.
- Estado: serviço = pior severidade das triggers em problema do host (prioridade 2-3 amarelo `warn`, 4-5 vermelho `crit`). Ligação para serviço herda o estado do chamado. Ligação para banco/externo herda o estado do chamador quando ela é a suspeita (10% ou mais de erros ou p95 a partir de 500 ms), e o nó do banco/externo herda o da ligação.
- Layout em colunas: chamadores à esquerda, dependências à direita; com um serviço selecionado, quem chama à esquerda e o que ele chama à direita. Ordem dentro da coluna pela média da posição de quem chama.
- Aplicação (tenant) = serviço que nenhum outro serviço chama, mais tudo o que ele alcança. Estado da aplicação = pior estado entre os membros.

## Decisões do usuário (não desfazer sem pedir)

- **Interface em inglês** desde 2026-10-30 (números e horários em `en-US`). Comentários do código ficam em português. Os nomes vindos do Zabbix continuam como estão.
- **Visão geral ("All applications") só com os cards das aplicações**, simples e clicáveis, no mesmo `FlowMap`, em grade. Clicar abre o fluxo com animação (o card desliza para o início do fluxo). O usuário reprovou a versão com cards detalhados (KPIs, miniatura do fluxo, lista de problemas): "meio zuado".
- Animações nas trocas de tela e no hover (pedido do usuário: "tava muito duro").
- Ícone do Zabbix como favicon (`public/`), com `?v=2` nos links do `index.html` para furar o cache do Safari. Nada de emoji.
- O visual de dashboard/mapa nativo do Zabbix gerado por API (`apm_services.py`) foi reprovado ("ficou horrível"); este projeto existe no lugar dele.

## Safari (navegador do usuário)

- Não usar `foreignObject` para os cards: no Safari eles saem do lugar com opacidade/animação. Cards são divs HTML posicionadas sobre um SVG que só tem as ligações, dentro de uma `.scene` escalada.
- O Safari não anima o atributo `d` de path por CSS: as transições (posição, opacidade, tamanho da cena, 750 ms) são feitas com `requestAnimationFrame`.
- Testar no Safari; o Chrome esconde esses problemas.

## Regras de trabalho

- Nenhuma atribuição a IA em commits, README ou código: sem `Co-Authored-By`, sem rodapé "Generated with". A mensagem de commit termina na última linha de conteúdo.
- Não rodar nada na VM `.101` (proxy APM) sem pedido explícito; o usuário executa lá manualmente para os vídeos. A `.100` só é lida pela API.
- Screenshot sem abrir o navegador do usuário: Chrome headless com `--user-data-dir` próprio (o perfil normal pode estar em uso).

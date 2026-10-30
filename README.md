# zabbix-service-flow

Mapa de serviços em React, no tema Dark blue do Zabbix 8.0, montado sozinho a partir dos traces do APM.

- **Fluxo automático:** lê os spans recentes (`apmspan.get`) e descobre quem chama quem. Bancos (`db.system`) e serviços externos (`server.address`) viram nós próprios.
- **Incidentes:** cada serviço é ligado ao host do Zabbix com o mesmo nome do `service.name`. Triggers em problema pintam o serviço e as ligações para ele: verde OK, amarelo atenção/média, vermelho alta/desastre.
- **Hover:** num serviço, mostra os itens do Zabbix (com gráfico dos últimos 30 min), os problemas, os endpoints e os traces com erro ou mais lentos; numa ligação, mostra chamadas/min, p95, média, erros, operações e traces. Cada trace abre no Zabbix.
- **Visão geral:** cada serviço que ninguém chama é a entrada de uma aplicação (um cliente). A visão geral mostra um card por aplicação, com o pior estado dela; clicar abre o fluxo.
- **Dropdown e trilha:** o dropdown agrupa os serviços por aplicação (`service.name`). Ao escolher um, mostra quem o chama à esquerda e as dependências à direita. Clicar num serviço também foca nele, e a trilha no topo volta para a aplicação ou para a visão geral.

Atualiza a cada 30 s. A interface é em inglês.

## Rodar

Requer Node 18 ou mais recente.

```bash
cd zabbix-service-flow
npm install
npm run dev
```

Abra http://localhost:5173 e entre com um usuário do Zabbix. O endereço da API vem do `.env` (`VITE_ZABBIX_URL`) e pode ser trocado na tela de login. A API do Zabbix já libera CORS, então não precisa de proxy.

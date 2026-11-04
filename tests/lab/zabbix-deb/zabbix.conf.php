<?php
// Configuração do frontend do lab (pula o assistente de instalação).
$DB['TYPE']     = 'POSTGRESQL';
$DB['SERVER']   = 'db';
$DB['PORT']     = '0';
$DB['DATABASE'] = 'zabbix';
$DB['USER']     = 'zabbix';
$DB['PASSWORD'] = 'zabbix';
$DB['SCHEMA']   = '';
$DB['ENCRYPTION']  = false;
$DB['KEY_FILE']    = '';
$DB['CERT_FILE']   = '';
$DB['CA_FILE']     = '';
$DB['VERIFY_HOST'] = false;
$DB['CIPHER_LIST'] = '';
$DB['VAULT']            = '';
$DB['VAULT_URL']        = '';
$DB['VAULT_PREFIX']     = '';
$DB['VAULT_DB_PATH']    = '';
$DB['VAULT_TOKEN']      = '';
$DB['VAULT_CERT_FILE']  = '';
$DB['VAULT_KEY_FILE']   = '';
$DB['VAULT_CACHE']      = false;
$DB['DOUBLE_IEEE754'] = true;

$ZBX_SERVER_NAME = 'sdlab';
$IMAGE_FORMAT = IMAGE_FORMAT_PNG;

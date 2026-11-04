# Zabbix 8.0 server + frontend (PostgreSQL) a partir dos pacotes oficiais .deb, em Ubuntu ou Debian.
# Não há imagem Docker oficial do 8.0 rc; este container imita uma instalação por pacote
# (frontend em /usr/share/zabbix/ui, Apache com mod-php, configuração em /etc/zabbix).
#
# Padrão: Ubuntu 24.04. Para Debian 12, passar os build args no docker-compose.yml:
#   BASE=debian:12
#   ZABBIX_RELEASE_DEB=https://repo.zabbix.com/zabbix/8.0/release/debian/pool/main/z/zabbix-release/zabbix-release_latest_8.0%2Bdebian12_all.deb
ARG BASE=ubuntu:24.04
FROM ${BASE}

ARG ZABBIX_RELEASE_DEB=https://repo.zabbix.com/zabbix/8.0/release/ubuntu/pool/main/z/zabbix-release/zabbix-release_latest_8.0%2Bubuntu24.04_all.deb
ENV DEBIAN_FRONTEND=noninteractive

# php-pgsql explícito (o zabbix-frontend-php puxa php-mysql por padrão); locales porque sem en_US.UTF-8
# o frontend mostra "Locale for language en_US is not found on the web server".
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL -o /tmp/zabbix-release.deb "${ZABBIX_RELEASE_DEB}" \
 && dpkg -i /tmp/zabbix-release.deb && rm -f /tmp/zabbix-release.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        zabbix-server-pgsql zabbix-frontend-php zabbix-apache-conf zabbix-sql-scripts \
        apache2 libapache2-mod-php php-pgsql postgresql-client procps locales \
 && sed -i -E 's/^# *((en_US|pt_BR|es_ES|de_DE|fr_FR|it_IT|ru_RU|ja_JP|zh_CN).UTF-8 UTF-8)/\1/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

COPY zabbix.conf.php /etc/zabbix/web/zabbix.conf.php
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh && chown root:www-data /etc/zabbix/web/zabbix.conf.php && chmod 0640 /etc/zabbix/web/zabbix.conf.php

EXPOSE 80 10051
CMD ["/entrypoint.sh"]

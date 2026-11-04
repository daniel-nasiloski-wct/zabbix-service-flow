# Zabbix 8.0 server + frontend (PostgreSQL) a partir dos RPMs oficiais, em Oracle Linux ou AlmaLinux
# (família RHEL 10). Não há imagem Docker oficial do 8.0 rc; este container imita uma instalação por
# pacote (frontend em /usr/share/zabbix/ui, httpd + php-fpm, configuração em /etc/zabbix).
#
# Padrão: Oracle Linux 10 (mesma base da VM .100). Para AlmaLinux 10, build args no docker-compose.yml:
#   BASE=almalinux:10
#   ZABBIX_RELEASE_RPM=https://repo.zabbix.com/zabbix/8.0/release/alma/10/noarch/zabbix-release-latest-8.0.el10.noarch.rpm
ARG BASE=oraclelinux:10
FROM ${BASE}

ARG ZABBIX_RELEASE_RPM=https://repo.zabbix.com/zabbix/8.0/release/oracle/10/noarch/zabbix-release-latest-8.0.el10.noarch.rpm

# EPEL (fping, dependência do zabbix-server) e CodeReady Builder: os nomes mudam entre Oracle e Alma/Rocky.
RUN . /etc/os-release \
 && case "$ID" in \
      ol) dnf install -y oracle-epel-release-el10 && dnf config-manager --enable ol10_codeready_builder ;; \
      *)  dnf install -y epel-release && dnf config-manager --set-enabled crb ;; \
    esac \
 && dnf install -y "${ZABBIX_RELEASE_RPM}" \
 && dnf clean all

# glibc-langpack-*: a imagem mínima do Alma vem sem en_US e o frontend avisa "Locale for language en_US
# is not found on the web server" (a do Oracle já traz). Os outros idiomas servem para testar as
# traduções do módulo (o Zabbix só troca de idioma se o locale existir no sistema).
RUN dnf install -y zabbix-server-pgsql zabbix-web-pgsql zabbix-apache-conf zabbix-sql-scripts \
        httpd php-fpm postgresql gzip procps-ng \
        glibc-langpack-en glibc-langpack-pt glibc-langpack-es glibc-langpack-de glibc-langpack-fr \
        glibc-langpack-it glibc-langpack-ru glibc-langpack-ja glibc-langpack-zh \
 && dnf clean all

COPY zabbix.conf.php /etc/zabbix/web/zabbix.conf.php
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh && chown root:apache /etc/zabbix/web/zabbix.conf.php && chmod 0640 /etc/zabbix/web/zabbix.conf.php

EXPOSE 80 10051
CMD ["/entrypoint.sh"]

# Zabbix proxy 8.0 com coletor APM (zabbix-proxy-sqlite3-apm): recebe OTLP na 4317 e grava no ClickHouse.
FROM oraclelinux:10

ARG ZABBIX_RELEASE_RPM=https://repo.zabbix.com/zabbix/8.0/release/oracle/10/noarch/zabbix-release-latest-8.0.el10.noarch.rpm

# O pacote -apm precisa de EPEL e CodeReady Builder (abseil, gRPC, protobuf).
RUN dnf install -y oracle-epel-release-el10 \
 && dnf config-manager --enable ol10_codeready_builder \
 && dnf install -y "${ZABBIX_RELEASE_RPM}" \
 && dnf install -y zabbix-proxy-sqlite3-apm procps-ng \
 && dnf clean all

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

EXPOSE 4317 10051
CMD ["/entrypoint.sh"]

#!/bin/sh
# APM dashboard for Zabbix 8.0 - installer
#
# Installs (or upgrades/removes) the "APM dashboard" frontend module. It only creates the directory
# <frontend>/modules/zabbix_service_dashboard: no core file, configuration, database table or service is
# touched, and nothing is restarted. After installing, enable the module in the frontend:
# Administration -> General -> Modules -> Scan directory -> Enable.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/daniel-nasiloski-wct/zabbix-service-flow/main/install.sh | sh
#   sh install.sh [install|uninstall|status] [--ref <branch|tag>] [--archive <file.tar.gz|URL>] [--dry-run]
#
# Environment:
#   ZABBIX_FRONTEND_DIR   frontend directory, when auto-detection fails (e.g. /usr/share/zabbix/ui)
#   GITHUB_TOKEN          token for downloading from a private repository
#   ZABBIX_URL + ZABBIX_TOKEN   optional: register and enable the module through the Zabbix API
#                         (URL ending in api_jsonrpc.php; ZABBIX_INSECURE=1 skips TLS verification)
#
# Works on every Linux supported by the Zabbix 8.0 packages (RHEL/Alma/Rocky/Oracle/CentOS Stream,
# Amazon Linux, Debian, Ubuntu, Raspberry Pi OS, SLES/openSUSE). Needs only curl and tar.
set -eu

REPO=${SERVICE_DASHBOARD_REPO:-daniel-nasiloski-wct/zabbix-service-flow}
REF=${SERVICE_DASHBOARD_REF:-main}
ARCHIVE=${SERVICE_DASHBOARD_ARCHIVE:-}
MODULE=zabbix_service_dashboard
CMD=install
DRY_RUN=0

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required"; }

usage() {
	sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case $1 in
		install|uninstall|status) CMD=$1 ;;
		--ref) REF=$2; shift ;;
		--archive) ARCHIVE=$2; shift ;;
		--dry-run) DRY_RUN=1 ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option: $1 (try --help)" ;;
	esac
	shift
done

# --- Frontend detection -----------------------------------------------------------------------------

valid_frontend() {
	[ -n "$1" ] && [ -f "$1/zabbix.php" ] && [ -f "$1/include/defines.inc.php" ] && [ -d "$1/include/classes" ]
}

# Diretórios citados nos arquivos de configuração do Apache/Nginx (Alias /zabbix <dir> ou root <dir>;).
conf_candidates() {
	for f in /etc/httpd/conf.d/zabbix.conf /etc/zabbix/apache.conf /etc/apache2/conf-available/zabbix.conf \
			/etc/apache2/conf.d/zabbix.conf /etc/apache2/sites-enabled/*zabbix* /etc/zabbix/nginx.conf \
			/etc/nginx/conf.d/zabbix.conf /etc/nginx/sites-enabled/*zabbix*; do
		[ -f "$f" ] || continue
		sed -n 's/^[[:space:]]*Alias[[:space:]]\{1,\}\/zabbix[[:space:]]\{1,\}"\{0,1\}\([^";]*\)"\{0,1\}.*/\1/p;
			s/^[[:space:]]*root[[:space:]]\{1,\}\([^;]*\);.*/\1/p' "$f"
	done
}

find_frontend() {
	if [ -n "${ZABBIX_FRONTEND_DIR:-}" ]; then
		valid_frontend "$ZABBIX_FRONTEND_DIR" || die "ZABBIX_FRONTEND_DIR=$ZABBIX_FRONTEND_DIR is not a Zabbix frontend directory"
		printf '%s\n' "$ZABBIX_FRONTEND_DIR"
		return
	fi
	for d in /usr/share/zabbix/ui /usr/share/zabbix /srv/www/htdocs/zabbix /var/www/html/zabbix /var/www/zabbix \
			/usr/share/zabbix-frontend $(conf_candidates); do
		d=$(printf '%s' "$d" | sed 's:/*$::')
		if valid_frontend "$d"; then printf '%s\n' "$d"; return; fi
		if valid_frontend "$d/ui"; then printf '%s\n' "$d/ui"; return; fi
	done
	die "Zabbix frontend not found. Set ZABBIX_FRONTEND_DIR (e.g. /usr/share/zabbix/ui) and run again."
}

frontend_version() {
	sed -n "s/.*define('ZABBIX_VERSION',[[:space:]]*'\([^']*\)').*/\1/p" "$1/include/defines.inc.php" | head -n 1
}

check_version() {
	major=$(printf '%s' "$1" | cut -d. -f1)
	case $major in
		''|*[!0-9]*) warn "could not read the frontend version; continuing" ;;
		*) [ "$major" -ge 8 ] || die "Zabbix $1 found; this module needs Zabbix 8.0 or newer" ;;
	esac
}

module_version() {
	[ -f "$1/manifest.json" ] && sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/manifest.json" | head -n 1
}

# --- Download -----------------------------------------------------------------------------------------

fetch() { # url destino
	if [ -n "${GITHUB_TOKEN:-}" ]; then
		curl -fsSL --retry 3 -H "Authorization: Bearer $GITHUB_TOKEN" -o "$2" "$1"
	else
		curl -fsSL --retry 3 -o "$2" "$1"
	fi
}

download_archive() { # destino
	if [ -n "$ARCHIVE" ]; then
		case $ARCHIVE in
			http://*|https://*) say "Downloading $ARCHIVE"; fetch "$ARCHIVE" "$1" ;;
			*) [ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"; cp "$ARCHIVE" "$1" ;;
		esac
		return
	fi
	if [ -n "${GITHUB_TOKEN:-}" ]; then
		say "Downloading $REPO@$REF (GitHub API)"
		fetch "https://api.github.com/repos/$REPO/tarball/$REF" "$1"
	else
		say "Downloading $REPO@$REF"
		fetch "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" "$1" 2>/dev/null \
			|| fetch "https://github.com/$REPO/archive/refs/tags/$REF.tar.gz" "$1" \
			|| die "could not download $REPO@$REF from GitHub"
	fi
}

# --- Optional: enable through the API ---------------------------------------------------------------

api() { # método params
	curl -fsS -m 30 ${ZABBIX_INSECURE:+-k} -H 'Content-Type: application/json-rpc' \
		-H "Authorization: Bearer $ZABBIX_TOKEN" \
		-d "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":$2,\"id\":1}" "$ZABBIX_URL"
}

api_enable() {
	[ -n "${ZABBIX_URL:-}" ] && [ -n "${ZABBIX_TOKEN:-}" ] || return 0
	say "Registering the module through the Zabbix API ($ZABBIX_URL)"
	out=$(api module.get "{\"output\":[\"moduleid\",\"status\"],\"filter\":{\"id\":\"$MODULE\"}}") || { warn "API call failed"; return 0; }
	case $out in
		*'"error"'*) warn "API error: $out"; return 0 ;;
	esac
	moduleid=$(printf '%s' "$out" | sed -n 's/.*"moduleid":"\([0-9]*\)".*/\1/p')
	if [ -n "$moduleid" ]; then
		out=$(api module.update "[{\"moduleid\":\"$moduleid\",\"status\":1}]")
	else
		out=$(api module.create "[{\"id\":\"$MODULE\",\"relative_path\":\"modules/$MODULE\",\"status\":1}]")
	fi
	case $out in
		*'"error"'*) warn "could not enable the module: $out" ;;
		*) say "Module enabled (moduleid ${moduleid:-new})." ;;
	esac
}

api_disable() {
	[ -n "${ZABBIX_URL:-}" ] && [ -n "${ZABBIX_TOKEN:-}" ] || return 0
	out=$(api module.get "{\"output\":[\"moduleid\"],\"filter\":{\"id\":\"$MODULE\"}}") || return 0
	moduleid=$(printf '%s' "$out" | sed -n 's/.*"moduleid":"\([0-9]*\)".*/\1/p')
	[ -n "$moduleid" ] && api module.delete "[\"$moduleid\"]" >/dev/null 2>&1 && say "Module unregistered through the API."
}

# --- Commands -----------------------------------------------------------------------------------------

need sed
FRONTEND=$(find_frontend)
VERSION=$(frontend_version "$FRONTEND")
TARGET="$FRONTEND/modules/$MODULE"
say "Zabbix frontend: $FRONTEND (version ${VERSION:-unknown})"

case $CMD in
	status)
		if v=$(module_version "$TARGET") && [ -n "$v" ]; then
			say "APM dashboard $v installed in $TARGET"
		else
			say "APM dashboard is not installed"
		fi
		exit 0
		;;
	uninstall)
		[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
		if [ -d "$TARGET" ]; then
			[ "$DRY_RUN" -eq 1 ] && { say "dry run: would remove $TARGET"; exit 0; }
			rm -rf "$TARGET"
			say "Removed $TARGET"
		else
			say "Nothing to remove: $TARGET does not exist"
		fi
		api_disable
		say "Finish in the frontend: Administration -> General -> Modules -> Scan directory (removes the module entry)."
		exit 0
		;;
esac

# install
check_version "${VERSION:-0}"
need curl
need tar
[ "$DRY_RUN" -eq 1 ] || [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -d "$FRONTEND/modules" ] || [ "$DRY_RUN" -eq 1 ] || mkdir -p "$FRONTEND/modules"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

download_archive "$TMP/src.tar.gz"
mkdir -p "$TMP/x"
tar -xzf "$TMP/src.tar.gz" -C "$TMP/x"
SRC=$(find "$TMP/x" -maxdepth 3 -type d -name "$MODULE" | head -n 1)
[ -n "$SRC" ] && [ -f "$SRC/manifest.json" ] || die "the archive does not contain $MODULE/manifest.json"
NEW=$(module_version "$SRC")
OLD=$(module_version "$TARGET" || true)

if [ "$DRY_RUN" -eq 1 ]; then
	say "dry run: would install APM dashboard ${NEW:-?} into $TARGET${OLD:+ (replacing $OLD)}"
	exit 0
fi

# Instala numa pasta ao lado e troca no fim: o upgrade é quase atômico e um download pela metade não
# deixa o módulo quebrado.
STAGE="$FRONTEND/modules/.$MODULE.new"
rm -rf "$STAGE"
cp -R "$SRC" "$STAGE"
chown -R root:root "$STAGE"
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
rm -rf "$TARGET"
mv "$STAGE" "$TARGET"
if command -v restorecon >/dev/null 2>&1 && command -v getenforce >/dev/null 2>&1 \
		&& [ "$(getenforce 2>/dev/null)" != "Disabled" ]; then
	restorecon -R "$TARGET" 2>/dev/null || true
fi

if [ -n "$OLD" ]; then
	say "APM dashboard upgraded: $OLD -> ${NEW:-?} ($TARGET)"
else
	say "APM dashboard ${NEW:-?} installed in $TARGET"
fi

api_enable

cat <<EOF

Next steps
  1. In the Zabbix frontend, as a Super admin: Administration -> General -> Modules -> Scan directory,
     then enable "APM dashboard".
  2. Open APM -> APM dashboard (zabbix.php?action=servicedashboard.view).
  3. Roles that must not see it: Users -> User roles -> Access to modules.

Upgrading replaces only $TARGET. If the browser keeps an old version after an upgrade, clear the
PHP opcache (for example: systemctl restart php-fpm) and reload the page.
EOF

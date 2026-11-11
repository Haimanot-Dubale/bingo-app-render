#!/usr/bin/env bash
# =====================================================================================
#  One-step installer for an Ubuntu EC2 server (22.04 / 24.04)
#  Installs Node.js 22, nginx, HTTPS (Let's Encrypt), PM2, creates the database tables,
#  writes a secure .env and starts the bingo platform.
#
#  Usage (as the normal "ubuntu" user, NOT root):
#       unzip bingo-app-multiagent.zip && cd bingo-app-updated
#       bash install-aws.sh
#
#  Safe to run again: it backs up the old .env, keeps the same login secret and restarts the app.
#  Database: by default MySQL is installed on THIS server (LOCAL_DB=1). Use LOCAL_DB=0 with DB_HOST/DB_USER/DB_PASSWORD for RDS.
#  AUTO=1 : no questions, no domain, local MySQL, generated admin password (printed at the end):  AUTO=1 bash install-aws.sh
#  No questions at all: put every answer in front of the command, e.g.
#       DOMAIN='bingo.example.com' LE_EMAIL='me@example.com' DB_HOST='xxx.rds.amazonaws.com' DB_USER='admin' \
#       DB_PASSWORD='...' ADMIN_PASSWORD='...' ... bash install-aws.sh
#     (names: DOMAIN LE_EMAIL DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME ADMIN_USERNAME ADMIN_EMAIL ADMIN_PASSWORD
#             SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_FROM TZ_OFFSET PROTECT=Y|N ; an empty value = skip)
#  Test mode (changes nothing on the server):  DRY_RUN=1 ENV_FILE=/tmp/test.env bash install-aws.sh
# =====================================================================================
set -Eeuo pipefail
trap 'echo; echo "❌ The installer stopped at line $LINENO. Read the message above, fix it and run:  bash install-aws.sh  (it is safe to run again)."' ERR

DRY_RUN="${DRY_RUN:-0}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
ENV_FILE="${ENV_FILE:-.env}"
APP_NAME="bingo"
APP_PORT=3000

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $*"; else "$@"; fi; }

# ---------------------------------------------------------------- input helpers
# ask VAR "Question" "default" "flags"   flags: s = secret (hidden), o = optional (may stay empty)
ask() {
    local var="$1" q="$2" def="${3:-}" flags="${4:-}" val=""
    if [ "${!var+x}" = "x" ]; then return 0; fi          # answer supplied up front (may be empty = skip)
    while true; do
        if [[ "$flags" == *s* ]]; then read -r -s -p "  $q: " val; echo; else read -r -p "  $q${def:+ [$def]}: " val; fi
        val="${val:-$def}"
        if [ -n "$val" ] || [[ "$flags" == *o* ]]; then break; fi
        echo "    This value is required."
    done
    printf -v "$var" '%s' "$val"
}
# ask_valid VAR "Question" "default" "flags" validator_function "error text"
# A value already present in the environment is used as-is (and must be valid).
ask_valid() {
    local var="$1" q="$2" def="$3" flags="$4" fn="$5" msg="$6" preset
    while true; do
        preset=0
        if [ "${!var+x}" = "x" ]; then preset=1; else ask "$var" "$q" "$def" "$flags"; fi
        if [ -z "${!var:-}" ] && [[ "$flags" == *o* ]]; then return 0; fi
        if "$fn" "${!var}"; then return 0; fi
        echo "    $msg"
        if [ "$preset" = 1 ]; then
            if [[ "$flags" == *s* ]]; then die "The value given for $var is not valid (see the message above)."; fi
            die "The value given for $var ('${!var}') is not valid. If it is a placeholder like REAL_DOMAIN, replace it with your real value - or leave it empty ($var='') to skip it."
        fi
        unset "$var"
    done
}
v_domain()   { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }
v_email()    { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$ ]]; }
v_host()     { [[ "$1" =~ ^[A-Za-z0-9.-]+$ ]]; }
v_port()     { [[ "$1" =~ ^[0-9]{2,5}$ ]]; }
v_dbname()   { [[ "$1" =~ ^[A-Za-z0-9_]{1,64}$ ]]; }
v_user()     { [[ "$1" =~ ^[A-Za-z0-9_.-]{3,50}$ ]]; }
v_dbuser()   { [[ "$1" =~ ^[A-Za-z0-9_.-]{1,32}$ ]]; }
v_tz()       { [[ "$1" =~ ^-?[0-9]{1,4}$ ]]; }
v_nonempty() { [ -n "$1" ]; }
v_strong()   { local p="$1"; [ "${#p}" -ge 8 ] && [ "${#p}" -le 128 ] && [[ "$p" =~ [A-Za-z] ]] && [[ "$p" =~ [0-9] ]]; }
v_quotes()   { [[ "$1" != *$'\n'* ]] && ! { [[ "$1" == *"'"* ]] && [[ "$1" == *'"'* ]]; } && [[ "$1" != *'`'* ]]; }
yesno() { local a; read -r -p "  $1 [$2]: " a; a="${a:-$2}"; [[ "$a" =~ ^[Yy] ]]; }

# value for the .env file: wrapped in quotes so #, spaces and $ are kept exactly
envq() { if [[ "$1" == *"'"* ]]; then printf '"%s"' "$1"; else printf "'%s'" "$1"; fi; }

public_ip() {
    local t ip
    t="$(curl -sf -m 3 -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
    ip="$(curl -sf -m 3 -H "X-aws-ec2-metadata-token: $t" 'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null || true)"
    # only a real IPv4 address is accepted
    printf '%s' "$ip" | grep -Eo '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true
}

# ---------------------------------------------------------------- 0. checks
bold "Bingo platform installer"
[ -f server.js ] && [ -f package.json ] || die "Run this script from inside the 'bingo-app-updated' folder (server.js not found)."
if [ "$DRY_RUN" != "1" ]; then
    [ "$(id -u)" -ne 0 ] || die "Do not run as root. Log in as 'ubuntu' and run:  bash install-aws.sh"
    command -v sudo >/dev/null || die "sudo is required."
    . /etc/os-release 2>/dev/null || true
    [ "${ID:-}" = "ubuntu" ] || warn "This script is made for Ubuntu (found: ${ID:-unknown}). Continuing anyway."
    sudo true || die "sudo needs a password here. On a standard Ubuntu EC2 server it should not - run the installer as the \"ubuntu\" user."
else
    warn "DRY RUN: nothing will be installed or changed on this machine."
fi

# ---------------------------------------------------------------- 1. questions
bold "1/7  Your settings (press Enter to accept a default)"
GENERATED_ADMIN_PW=0
if [ "${AUTO:-0}" = "1" ]; then
    # No questions: everything not given on the command line gets a sensible default.
    : "${LOCAL_DB:=1}"; : "${ADMIN_USERNAME:=boss}"; : "${TZ_OFFSET:=180}"; : "${PROTECT:=Y}"
    [ -n "${DOMAIN+x}" ] || DOMAIN=""
    [ -n "${SMTP_HOST+x}" ] || SMTP_HOST=""
    if [ -n "$DOMAIN" ] && [ -z "${LE_EMAIL:-}" ]; then die "DOMAIN needs LE_EMAIL too (your e-mail for the HTTPS certificate)."; fi
    : "${ADMIN_EMAIL:=${LE_EMAIL:-admin@example.com}}"
    if [ -z "${ADMIN_PASSWORD:-}" ]; then ADMIN_PASSWORD="$(openssl rand -hex 8)Ab1"; GENERATED_ADMIN_PW=1; fi
    ok "Automatic mode: using defaults (domain: ${DOMAIN:-none}, local MySQL, admin user: $ADMIN_USERNAME)"
fi
echo "  Domain: the address players will type, e.g. bingo.yourdomain.com. Its DNS 'A' record must already point to this server."
echo "  Leave it empty to run without a domain (plain http - fine for a test, NOT for real use)."
ask_valid DOMAIN "Domain name" "" "o" v_domain "Enter a valid domain like bingo.example.com (or leave empty)."
if [ -n "${DOMAIN:-}" ]; then
    ask_valid LE_EMAIL "E-mail for the HTTPS certificate (expiry notices)" "" "" v_email "Enter a valid e-mail."
fi
echo
USE_LOCAL=1
if [ -n "${LOCAL_DB+x}" ]; then
    [[ "$LOCAL_DB" =~ ^[Yy1] ]] || USE_LOCAL=0
elif ! yesno "Install the MySQL database on THIS server? (N = use an existing RDS / remote MySQL)" "Y"; then USE_LOCAL=0; fi

if [ "$USE_LOCAL" = "1" ]; then
    DB_HOST="127.0.0.1"; DB_PORT=3306
    : "${DB_USER:=bingo_app}"; : "${DB_NAME:=bingo}"
    v_dbuser "$DB_USER" || die "DB_USER is not valid (letters, digits, _ . - only)."
    v_dbname "$DB_NAME" || die "DB_NAME is not valid (letters, digits, _ only)."
    if [ -z "${DB_PASSWORD+x}" ]; then
        DB_PASSWORD=""
        # re-runs keep the existing database password so the app keeps working
        if [ -f "$ENV_FILE" ] && grep -q "^DB_HOST='127.0.0.1'" "$ENV_FILE"; then
            DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]\$//")"
        fi
        [ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(openssl rand -hex 16)"
    fi
    case "$DB_PASSWORD" in *"'"*|*'\\'*) die "For the local database the password may not contain ' or a backslash." ;; esac
    echo "  Database: MySQL on this server (database '$DB_NAME', user '$DB_USER', random password, reachable only from this machine)."
else
  echo "  Database (your RDS / remote MySQL):"
ask_valid DB_HOST "RDS endpoint (xxxx.rds.amazonaws.com)" "" "" v_host "Letters, digits, dots and dashes only."
ask_valid DB_PORT "Database port" "3306" "" v_port "Enter a port number."
ask_valid DB_USER "Database user" "" "" v_dbuser "Letters, digits, _ . - only."
ask_valid DB_PASSWORD "Database password (hidden)" "" "s" v_quotes "That password contains characters that cannot be stored safely (newline, backtick, or both ' and \")."
ask_valid DB_NAME "Database name" "bingo" "" v_dbname "Letters, digits and _ only."
fi
echo
echo "  First administrator account (you will log in at /admin):"
ask_valid ADMIN_USERNAME "Admin username" "boss" "" v_user "3-50 letters/digits/_ . -"
ask_valid ADMIN_EMAIL "Admin e-mail (password resets are sent here)" "${LE_EMAIL:-}" "" v_email "Enter a valid e-mail."
PRESET_ADMINPW="${ADMIN_PASSWORD:-}"
while true; do
    ask_valid ADMIN_PASSWORD "Admin password (hidden, 8+ chars, letter + number)" "" "s" v_strong "Too weak: use 8+ characters with at least one letter and one number."
    if ! v_quotes "$ADMIN_PASSWORD"; then echo "    Avoid backticks, new lines, or using both ' and \" together."; unset ADMIN_PASSWORD; continue; fi
    [ -n "$PRESET_ADMINPW" ] && break
    read -r -s -p "  Repeat the password: " ADMIN_PASSWORD2; echo
    [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD2" ] && break
    echo "    The two passwords are different."
    unset ADMIN_PASSWORD
done
echo
echo "  E-mail sending for password resets (Amazon SES / Gmail / any SMTP). Leave the host empty to set it up later."
ask SMTP_HOST "SMTP host (e.g. email-smtp.eu-central-1.amazonaws.com)" "" "o"
if [ -n "${SMTP_HOST:-}" ]; then
    ask_valid SMTP_PORT "SMTP port" "587" "" v_port "Enter a port number."
    ask SMTP_USER "SMTP user" "" "o"
    ask_valid SMTP_PASS "SMTP password (hidden)" "" "so" v_quotes "Unsupported characters in that password."
    ask MAIL_FROM "Send e-mails from (e.g. no-reply@yourdomain.com)" "${ADMIN_EMAIL}" ""
fi
ask_valid TZ_OFFSET "Time zone: minutes from UTC (Ethiopia = 180)" "180" "" v_tz "Enter a number like 180."
BUILD_PROTECTED=0
if [ -n "${PROTECT+x}" ]; then
    [[ "$PROTECT" =~ ^[Yy1] ]] && BUILD_PROTECTED=1
elif yesno "Protect the web pages (minify + obfuscate the JavaScript so view-source is unreadable)?" "Y"; then BUILD_PROTECTED=1; fi

# ---------------------------------------------------------------- 2. packages
bold "2/7  Installing system packages (nginx, Node.js 22, PM2, certbot) ..."
if [ "$DRY_RUN" != "1" ]; then
    MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
    if [ "$MEM_MB" -lt 3000 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
        sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile \
            && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null && ok "Added 2 GB swap (small servers need it for MySQL + Node)"
    fi
    sudo apt-get update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg unzip nginx certbot python3-certbot-nginx unattended-upgrades
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-client || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mariadb-client
    NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//' || true)"
    if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
    fi
    if [ "$USE_LOCAL" = "1" ]; then sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server; fi
    sudo npm install -g pm2 >/dev/null
    sudo systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
    ok "Node $(node -v), npm $(npm -v), nginx, PM2 $(pm2 -v)"
else
    echo "  [dry-run] apt-get install nginx certbot mysql-client nodejs(22) pm2 ..."
fi

# ---------------------------------------------------------------- 3. database
bold "3/7  Database ..."
if [ "$USE_LOCAL" = "1" ]; then
  if [ "$DRY_RUN" != "1" ]; then
    sudo tee /etc/mysql/mysql.conf.d/zz-bingo.cnf >/dev/null <<CNF
[mysqld]
bind-address = 127.0.0.1
mysqlx = OFF
performance_schema = OFF
innodb_buffer_pool_size = 256M
max_connections = 120
CNF
    sudo systemctl enable mysql >/dev/null 2>&1 || true
    sudo systemctl restart mysql
    for i in $(seq 1 40); do sudo mysql -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
    sudo mysql -e 'SELECT 1' >/dev/null 2>&1 || die "MySQL did not start. Look at:  sudo journalctl -u mysql -n 50"
    sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
    MYSQL_PWD="$DB_PASSWORD" mysql -h 127.0.0.1 -u "$DB_USER" "$DB_NAME" -e 'SELECT 1' >/dev/null 2>&1 || die "The database user could not log in. Run the installer again; if it still fails send me:  sudo journalctl -u mysql -n 50"
    ok "MySQL is running on this server; database '$DB_NAME' and user '$DB_USER' are ready (only reachable from this machine)"

    # the money lives in this database and there is no RDS to back it up: back it up every 6 hours
    sudo tee /usr/local/bin/bingo-backup.sh >/dev/null <<BKP
#!/bin/bash
set -euo pipefail
DIR=/var/backups/bingo
mkdir -p "\$DIR"; chmod 700 "\$DIR"
mysqldump --single-transaction --routines --triggers "$DB_NAME" | gzip > "\$DIR/bingo-\$(date +%F-%H%M).sql.gz"
find "\$DIR" -name 'bingo-*.sql.gz' -mtime +14 -delete
BKP
    sudo chmod 700 /usr/local/bin/bingo-backup.sh
    echo '0 */6 * * * root /usr/local/bin/bingo-backup.sh' | sudo tee /etc/cron.d/bingo-backup >/dev/null
    sudo /usr/local/bin/bingo-backup.sh && ok "Automatic backups every 6 hours -> /var/backups/bingo (kept 14 days)"
  else
    echo "  [dry-run] apt install mysql-server ; create database '$DB_NAME' + user '$DB_USER'@localhost ; backup cron every 6 hours"
  fi
else
if [ "$DRY_RUN" != "1" ]; then
    MYSQL_BASE=(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --connect-timeout=10)
    if ! MYSQL_PWD="$DB_PASSWORD" "${MYSQL_BASE[@]}" -e 'SELECT 1' >/dev/null 2>&1; then
        MYSQL_PWD="$DB_PASSWORD" "${MYSQL_BASE[@]}" -e 'SELECT 1' || true
        die "Cannot reach the database. Check: (1) endpoint/user/password, (2) the RDS security group allows port 3306 FROM this server's security group, (3) RDS 'Public access' is fine either way if both are in the same VPC."
    fi
    MYSQL_PWD="$DB_PASSWORD" "${MYSQL_BASE[@]}" -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    ok "Connected to $DB_HOST, database '$DB_NAME' is ready"
else
    echo "  [dry-run] mysql -h $DB_HOST ... CREATE DATABASE IF NOT EXISTS $DB_NAME"
fi

fi

# ---------------------------------------------------------------- 4. .env
bold "4/7  Writing the configuration ($ENV_FILE) ..."
SESSION_SECRET=""
if [ -f "$ENV_FILE" ]; then
    old="$(grep -E '^SESSION_SECRET=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]$//" || true)"
    if [ "${#old}" -ge 32 ] && [[ ! "$old" =~ ^change-this ]]; then SESSION_SECRET="$old"; ok "Keeping the existing login secret (nobody is logged out)"; fi
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"; ok "Old file saved as a .bak copy"
fi
if [ -z "$SESSION_SECRET" ]; then SESSION_SECRET="$(openssl rand -hex 32)"; fi
if [ -n "${DOMAIN:-}" ]; then PUBLIC_URL="https://$DOMAIN"; else
    IP="$(public_ip)"; PUBLIC_URL="http://${IP:-YOUR_SERVER_IP}"
    [ -n "$IP" ] || warn "Could not detect the server IP. Edit PUBLIC_URL in $ENV_FILE later (used in password-reset e-mails)."
fi
umask 077
{
    echo "# Generated by install-aws.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "NODE_ENV=production"
    echo "PORT=$APP_PORT"
    echo "DB_HOST=$(envq "$DB_HOST")"
    echo "DB_PORT=$DB_PORT"
    echo "DB_USER=$(envq "$DB_USER")"
    echo "DB_PASSWORD=$(envq "$DB_PASSWORD")"
    echo "DB_NAME=$(envq "$DB_NAME")"
    echo "DB_CONNECTION_LIMIT=30"
    echo "SESSION_SECRET=$SESSION_SECRET"
    echo "TOKEN_TTL_HOURS=24"
    echo "ALLOW_AGENT_SIGNUP=false"
    echo "PUBLIC_URL=$PUBLIC_URL"
    echo "TZ_OFFSET_MINUTES=$TZ_OFFSET"
    echo "DRAW_INTERVAL=3"
    echo "JACKPOT_MIN_LIMIT=1000"
    echo "AUDIO_PATH=./audio"
    echo "ENABLE_SOUND=true"
    echo "ADMIN_USERNAME=$(envq "$ADMIN_USERNAME")"
    echo "ADMIN_EMAIL=$(envq "$ADMIN_EMAIL")"
    echo "ADMIN_PASSWORD=$(envq "$ADMIN_PASSWORD")"
    if [ -n "${SMTP_HOST:-}" ]; then
        echo "SMTP_HOST=$(envq "$SMTP_HOST")"
        echo "SMTP_PORT=$SMTP_PORT"
        echo "SMTP_USER=$(envq "${SMTP_USER:-}")"
        echo "SMTP_PASS=$(envq "${SMTP_PASS:-}")"
        echo "MAIL_FROM=$(envq "${MAIL_FROM:-$ADMIN_EMAIL}")"
    fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "Configuration written (readable only by you)"

# ---------------------------------------------------------------- 5. app install
bold "5/7  Installing the application ..."
if [ "$DRY_RUN" != "1" ]; then
    npm install --omit=dev --no-audit --no-fund
    npm run setup-db
    # on a re-run the admin already exists: do not announce a new (non-existent) password
    EXISTING_ADMINS="$(MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -N -B "$DB_NAME" -e 'SELECT COUNT(*) FROM admins' 2>/dev/null || echo 0)"
    if [ "${EXISTING_ADMINS:-0}" -ge 1 ] && [ "$GENERATED_ADMIN_PW" = "1" ]; then
        GENERATED_ADMIN_PW=0
        ok "An admin account already exists - your existing admin password keeps working"
    fi
    if [ "$BUILD_PROTECTED" = "1" ]; then
        echo "  Building the protected web pages ..."
        if npm install --no-save --no-audit --no-fund terser javascript-obfuscator >/dev/null 2>&1 && npm run build; then
            bad=0
            while IFS= read -r f; do node --check "$f" 2>/dev/null || { warn "Syntax problem in $f"; bad=1; }; done < <(find dist -name '*.js' ! -name 'socket.io*')
            if [ "$bad" = "1" ]; then rm -rf dist; warn "The protected build looked broken, so it was removed. The normal (readable) pages are used."; else ok "Protected pages built (served automatically)"; fi
        else
            rm -rf dist; warn "Could not build the protected pages. The normal pages are used. You can retry later with:  npm run build"
        fi
    fi
else
    echo "  [dry-run] npm install --omit=dev ; npm run setup-db ; (build protected = $BUILD_PROTECTED)"
fi

# ---------------------------------------------------------------- 6. pm2
bold "6/7  Starting the application (PM2) ..."
if [ "$DRY_RUN" != "1" ]; then
    # secrets stay in the .env file only - never in PM2's saved environment
    CLEAN=(env -u DB_PASSWORD -u ADMIN_PASSWORD -u SMTP_PASS -u MYSQL_PWD -u SESSION_SECRET)
    if pm2 describe "$APP_NAME" >/dev/null 2>&1; then "${CLEAN[@]}" pm2 restart "$APP_NAME" --update-env; else "${CLEAN[@]}" pm2 start server.js --name "$APP_NAME" --time; fi
    pm2 save >/dev/null
    STARTUP_CMD="$(pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep -E '^sudo ' | tail -n1 || true)"
    [ -n "$STARTUP_CMD" ] && eval "$STARTUP_CMD" >/dev/null 2>&1 || true
    pm2 install pm2-logrotate >/dev/null 2>&1 || true
    for i in $(seq 1 30); do
        if curl -fs "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1; then HEALTH=1; break; fi; sleep 1
    done
    [ "${HEALTH:-0}" = "1" ] || { pm2 logs "$APP_NAME" --lines 40 --nostream || true; die "The app did not start. The last log lines are shown above."; }
    ok "App is running on port $APP_PORT and restarts automatically after a reboot"
    # the first admin is created on start; then the password no longer needs to sit in the file
    sleep 2
    N="$(MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -N -B "$DB_NAME" -e 'SELECT COUNT(*) FROM admins' 2>/dev/null || echo 0)"
    if [ "${N:-0}" -ge 1 ]; then sed -i '/^ADMIN_PASSWORD=/d' "$ENV_FILE"; ok "Admin account exists; admin password removed from $ENV_FILE"; else warn "Admin account not found yet - check:  pm2 logs $APP_NAME"; fi
else
    echo "  [dry-run] pm2 start server.js --name $APP_NAME ; pm2 save ; pm2 startup"
fi

# ---------------------------------------------------------------- 7. nginx + https
bold "7/7  Web server and HTTPS ..."
SERVER_NAME="${DOMAIN:-_}"
NGINX_LIMITS='# Flood protection (per visitor IP). A whole bingo hall shares one IP and live games keep websockets open, so limits are generous.
server_tokens off;
limit_req_zone $binary_remote_addr zone=bingo_req:10m rate=100r/s;
limit_conn_zone $binary_remote_addr zone=bingo_conn:10m;
limit_req_status 429;
limit_conn_status 429;'
NGINX_SITE="server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    client_max_body_size 1m;
    client_header_timeout 15s;
    client_body_timeout 15s;
    send_timeout 30s;
    keepalive_timeout 30s;

    location / {
        limit_req zone=bingo_req burst=300 nodelay;
        limit_conn bingo_conn 400;
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}"
if [ "$DRY_RUN" != "1" ]; then
    echo "$NGINX_LIMITS" | sudo tee /etc/nginx/conf.d/bingo-limits.conf >/dev/null
    echo "$NGINX_SITE" | sudo tee /etc/nginx/sites-available/bingo >/dev/null
    sudo ln -sf /etc/nginx/sites-available/bingo /etc/nginx/sites-enabled/bingo
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl enable nginx >/dev/null 2>&1 || true
    sudo systemctl reload nginx || sudo systemctl restart nginx
    ok "nginx is proxying port 80 to the app"
    if [ -n "${DOMAIN:-}" ]; then
        MYIP="$(public_ip)"; DNSIP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
        if [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then
            warn "$DOMAIN points to '${DNSIP:-nothing}', but this server is $MYIP. Fix the DNS A record, then run:"
            echo "      sudo certbot --nginx -d $DOMAIN --agree-tos -m $LE_EMAIL --redirect"
            sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=http://$DOMAIN#" "$ENV_FILE"
        elif sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect; then
            ok "HTTPS certificate installed (renews automatically)"
        else
            warn "Could not get the certificate (is port 80 open in the security group?). Retry later with:"
            echo "      sudo certbot --nginx -d $DOMAIN --agree-tos -m $LE_EMAIL --redirect"
            sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=http://$DOMAIN#" "$ENV_FILE"
            pm2 restart "$APP_NAME" --update-env >/dev/null 2>&1 || true
        fi
    else
        warn "No domain: the site runs on plain http. Do not use real passwords/money without HTTPS."
    fi
else
    echo "$NGINX_SITE" | head -5; echo "  [dry-run] nginx -t ; certbot --nginx -d ${DOMAIN:-<none>}"
fi

# ---------------------------------------------------------------- done
BASE="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2-)"
if [ "$GENERATED_ADMIN_PW" = "1" ]; then
    FIRST_LOGIN_FILE="${FIRST_LOGIN_FILE:-$HOME/bingo-first-login.txt}"
    ( umask 077; printf 'Admin panel: %s/admin\nusername: %s\npassword: %s\n' "$BASE" "$ADMIN_USERNAME" "$ADMIN_PASSWORD" > "$FIRST_LOGIN_FILE" )
fi
bold "✅ Finished"
cat <<MSG

  Admin panel : $BASE/admin        (user: $ADMIN_USERNAME)
  Agents      : $BASE/cashier      (deposits)   and   $BASE/   (bingo hall console)
  Players     : $BASE/player.html
  Health check: $BASE/health

  Next: log in to the admin panel, add your agents, check Settings, then make a small test
  (deposit -> 2 players -> 1 game -> 1 withdrawal).

$( [ "$GENERATED_ADMIN_PW" = "1" ] && echo "  >>> FIRST LOGIN (write it down, then change it in Admin -> Admins -> Change my password):
      username: $ADMIN_USERNAME
      password: $ADMIN_PASSWORD
      (also saved in ${FIRST_LOGIN_FILE:-$HOME/bingo-first-login.txt} - delete that file after you saved the password)
" )
  Useful commands:   pm2 status      pm2 logs $APP_NAME      pm2 restart $APP_NAME
  $( [ "$USE_LOCAL" = "1" ] && echo "Backups:           /var/backups/bingo (every 6 h, 14 days).  ALSO enable EBS snapshots of this server in AWS (Data Lifecycle Manager) -
                     a copy on the same disk does not protect you if the server is lost." )
  Update later:      upload the new zip, unzip over this folder (keep .env), then run:  bash update.sh
MSG

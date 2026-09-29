#!/bin/sh
# Prepares deploy/.env for the compose bundle:
#   - creates it from .env.example when it does not exist;
#   - generates every secret that is missing or blank;
#   - never overwrites a value that is already set (safe to re-run);
#   - never prints a secret value.
#
# Usage: deploy/init.sh [path/to/.env]     (default: deploy/.env)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
env_file=${1:-"$here/.env"}
example="$here/.env.example"

umask 077

if [ ! -f "$env_file" ]; then
  cp "$example" "$env_file"
  echo "Created $env_file from .env.example"
fi
chmod 600 "$env_file"

# Random bytes, base64-encoded on one line (openssl when present, /dev/urandom otherwise).
random_base64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr -d '\n'
  else
    head -c "$1" /dev/urandom | base64 | tr -d '\n'
  fi
}
# URL- and shell-safe variants.
random_base64url() { random_base64 "$1" | tr '+/' '-_' | tr -d '='; }
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Current value of NAME (last assignment wins, as in compose), without surrounding quotes.
current_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$env_file" | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//' -e 's/[[:space:]]*$//'
}

# Sets NAME=VALUE: fills blank assignments in place, or appends when NAME is absent.
set_value() {
  tmp=$(mktemp "$env_file.XXXXXX")
  if grep -q "^[[:space:]]*$1[[:space:]]*=" "$env_file"; then
    awk -v name="$1" -v value="$2" '
      { line = $0; sub(/^[ \t]*/, "", line) }
      line ~ ("^" name "[ \t]*=[ \t\"'\'']*$") { print name "=" value; next }
      { print }
    ' "$env_file" >"$tmp"
  else
    cat "$env_file" >"$tmp"
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
  fi
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

ensure_secret() {
  name=$1
  if [ -n "$(current_value "$name")" ]; then
    echo "  kept      $name"
  else
    set_value "$name" "$2"
    echo "  generated $name"
  fi
}

echo "Secrets in $env_file:"
# Hex: goes into DATABASE_URL, so it must be URL-safe.
ensure_secret POSTGRES_PASSWORD "$(random_hex 32)"
ensure_secret OPENWA_WEBHOOK_SECRET "$(random_base64url 48)"
ensure_secret SETUP_BOOTSTRAP_TOKEN "$(random_base64url 32)"
# Exactly 32 bytes, as APP_ENCRYPTION_KEY requires.
ensure_secret APP_ENCRYPTION_KEY "$(random_base64 32)"
ensure_secret OPENWA_API_MASTER_KEY "$(random_base64url 36)"
ensure_secret OPENWA_API_KEY_PEPPER "$(random_base64url 32)"

# The complete up command, global options first: -f, --env-file (only for a non-default path), then
# the profiles unless COMPOSE_PROFILES in the env file already selects them.
compose="docker compose -f $here/docker-compose.yml"
if [ "$env_file" != "$here/.env" ]; then
  compose="$compose --env-file $env_file"
fi
profiles=$(current_value COMPOSE_PROFILES)
if [ -n "$profiles" ]; then
  start="Start WABrain (profiles from COMPOSE_PROFILES=$profiles):
       $compose up -d --build"
else
  start="Start WABrain with push (ntfy) and HTTPS (Caddy):
       $compose --profile push --profile https up -d --build
     Or only the core services (your own TLS proxy, no push):
       $compose up -d --build"
fi

cat <<EOF

Next steps:
  1. Edit $env_file: BRAIN_DOMAIN (or PUBLIC_BASE_URL), SELF_JID, SELF_ALIASES, VAPID_SUBJECT.
  2. Start OpenWA first:  $compose up -d openwa
  3. Pair WhatsApp in the OpenWA dashboard (http://127.0.0.1:2785, admin key: OPENWA_API_MASTER_KEY),
     then set OPENWA_SESSION_ID (the session UUID) and OPENWA_READ_API_KEY (role "viewer",
     only that session, no chat allowlist).
  4. $start
  5. Register the signed webhook once:  $here/register-webhook.sh
  6. Open the setup page and create the owner account with SETUP_BOOTSTRAP_TOKEN.
EOF

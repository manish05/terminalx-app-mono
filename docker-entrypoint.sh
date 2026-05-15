#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/data
chmod 700 /app/data

if [ -z "${TERMINALX_JWT_SECRET:-}" ]; then
  secret_file="/app/data/.terminalx-docker-jwt-secret"
  if [ ! -f "$secret_file" ]; then
    openssl rand -base64 48 > "$secret_file"
    chmod 600 "$secret_file"
  fi
  export TERMINALX_JWT_SECRET
  TERMINALX_JWT_SECRET="$(cat "$secret_file")"
fi

if [ "${TERMINALX_AUTH_MODE:-local}" = "local" ] &&
  [ -z "${TERMINALX_ADMIN_PASSWORD:-}" ] &&
  [ ! -s /app/data/users.json ]; then
  password_file="/app/data/.terminalx-docker-admin-password"
  if [ ! -f "$password_file" ]; then
    openssl rand -base64 24 | tr -d '/+=' | head -c 24 > "$password_file"
    chmod 600 "$password_file"
  fi
  export TERMINALX_ADMIN_PASSWORD
  TERMINALX_ADMIN_PASSWORD="$(cat "$password_file")"
  echo "Generated TerminalX admin password for '${TERMINALX_ADMIN_USERNAME:-admin}': $TERMINALX_ADMIN_PASSWORD"
fi

exec "$@"

#!/bin/sh
set -eu

if [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_PATH+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while Node preload settings are present." >&2
  exit 1
fi
if [ "${CLOUDFLARE_API_BASE_URL+x}" = x ] || [ "${CF_API_BASE_URL+x}" = x ] || \
   [ "${WRANGLER_API_ENVIRONMENT+x}" = x ] || [ "${CLOUDFLARE_COMPLIANCE_REGION+x}" = x ] || \
   [ "${WRANGLER_AUTH_DOMAIN+x}" = x ] || [ "${WRANGLER_AUTH_URL+x}" = x ] || \
   [ "${WRANGLER_TOKEN_URL+x}" = x ] || [ "${WRANGLER_REVOKE_URL+x}" = x ] || \
   [ "${CLOUDFLARE_ACCOUNT_ID+x}" = x ] || [ "${CF_ACCOUNT_ID+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while a Cloudflare endpoint or account override is present." >&2
  exit 1
fi
if [ "${WRANGLER_LOG+x}" = x ] || [ "${WRANGLER_LOG_SANITIZE+x}" = x ] || \
   [ "${WRANGLER_LOG_PATH+x}" = x ] || [ "${WRANGLER_WRITE_LOGS+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while Wrangler logging overrides are present." >&2
  exit 1
fi
if [ "${HTTP_PROXY+x}" = x ] || [ "${HTTPS_PROXY+x}" = x ] || [ "${ALL_PROXY+x}" = x ] || \
   [ "${http_proxy+x}" = x ] || [ "${https_proxy+x}" = x ] || [ "${all_proxy+x}" = x ] || \
   [ "${NO_PROXY+x}" = x ] || [ "${no_proxy+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while proxy settings are present." >&2
  exit 1
fi
if [ "${NODE_EXTRA_CA_CERTS+x}" = x ] || [ "${NODE_TLS_REJECT_UNAUTHORIZED+x}" = x ] || \
   [ "${OPENSSL_CONF+x}" = x ] || [ "${SSL_CERT_FILE+x}" = x ] || \
   [ "${SSL_CERT_DIR+x}" = x ] || [ "${CURL_CA_BUNDLE+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while TLS overrides are present." >&2
  exit 1
fi

if [ "$#" -ne 1 ]; then
  printf '%s\n' "Usage: scripts/put-staging-secret.sh <approved-secret-name>" >&2
  exit 1
fi
secret_name=$1
LC_ALL=C
export LC_ALL
case "$secret_name" in
  ENTRA_CLIENT_SECRET|OAUTH_STATE_SECRET|IDENTITY_PROFILE_MAP) ;;
  CW_PROFILE_*)
    profile_alias=${secret_name#CW_PROFILE_}
    case "$profile_alias" in
      ""|[!A-Z]*|*[!A-Z0-9_]*)
        printf '%s\n' "Secret name is not approved for staging entry." >&2
        exit 1
        ;;
    esac
    if [ "${#profile_alias}" -gt 32 ]; then
      printf '%s\n' "Secret name is not approved for staging entry." >&2
      exit 1
    fi
    ;;
  *)
    printf '%s\n' "Secret name is not approved for staging entry." >&2
    exit 1
    ;;
esac

if [ -z "${DEPLOY_NODE_PATH:-}" ]; then
  printf '%s\n' "DEPLOY_NODE_PATH must name the approved absolute Node executable." >&2
  exit 1
fi
case "$DEPLOY_NODE_PATH" in
  /*) ;;
  *)
    printf '%s\n' "DEPLOY_NODE_PATH must name the approved absolute Node executable." >&2
    exit 1
    ;;
esac
if [ -L "$DEPLOY_NODE_PATH" ] || [ ! -f "$DEPLOY_NODE_PATH" ] || [ ! -x "$DEPLOY_NODE_PATH" ]; then
  printf '%s\n' "DEPLOY_NODE_PATH must be a regular, non-symlink executable." >&2
  exit 1
fi
node_parent=${DEPLOY_NODE_PATH%/*}
node_name=${DEPLOY_NODE_PATH##*/}
if ! physical_node_parent=$(CDPATH= cd -- "$node_parent" && pwd -P); then
  printf '%s\n' "DEPLOY_NODE_PATH parent directory is unavailable." >&2
  exit 1
fi
if [ "$DEPLOY_NODE_PATH" != "$physical_node_parent/$node_name" ]; then
  printf '%s\n' "DEPLOY_NODE_PATH must not contain symlinked or non-canonical path components." >&2
  exit 1
fi

case "$0" in
  scripts/put-staging-secret.sh|./scripts/put-staging-secret.sh) ;;
  *)
    printf '%s\n' "Invoke the reviewed launcher from the repository root." >&2
    exit 1
    ;;
esac
repository=$(pwd -P)
scripts_directory=$repository/scripts
launcher_path=$scripts_directory/put-staging-secret.sh
wrangler_config=$repository/wrangler.jsonc
wrangler_package=$repository/node_modules/wrangler
wrangler_bin=$wrangler_package/bin
wrangler_entrypoint=$wrangler_bin/wrangler.js
if [ -L "$scripts_directory" ] || [ ! -d "$scripts_directory" ] || \
   [ -L "$launcher_path" ] || [ ! -f "$launcher_path" ] || [ ! -x "$launcher_path" ] || \
   [ -L "$wrangler_config" ] || [ ! -f "$wrangler_config" ] || \
   [ -L "$repository/node_modules" ] || [ ! -d "$repository/node_modules" ] || \
   [ -L "$wrangler_package" ] || [ ! -d "$wrangler_package" ] || \
   [ -L "$wrangler_bin" ] || [ ! -d "$wrangler_bin" ] || \
   [ -L "$wrangler_entrypoint" ] || [ ! -f "$wrangler_entrypoint" ]; then
  printf '%s\n' "The reviewed launcher or lock-installed Wrangler entry point is unavailable or unsafe." >&2
  exit 1
fi

unset NODE_OPTIONS NODE_PATH CLOUDFLARE_API_BASE_URL CF_API_BASE_URL
unset WRANGLER_API_ENVIRONMENT CLOUDFLARE_COMPLIANCE_REGION
unset WRANGLER_AUTH_DOMAIN WRANGLER_AUTH_URL WRANGLER_TOKEN_URL WRANGLER_REVOKE_URL
unset CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID
unset WRANGLER_LOG WRANGLER_LOG_SANITIZE WRANGLER_LOG_PATH WRANGLER_WRITE_LOGS
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
unset NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE
cd "$repository"
exec "$DEPLOY_NODE_PATH" "$wrangler_entrypoint" secret put "$secret_name" --env staging --config "$wrangler_config"

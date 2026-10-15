#!/bin/sh
set -eu

if [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_PATH+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while Node preload settings are present." >&2
  exit 1
fi
if [ "${CLOUDFLARE_API_BASE_URL+x}" = x ] || [ "${CF_API_BASE_URL+x}" = x ] || \
   [ "${CLOUDFLARE_BASE_URL+x}" = x ] || [ "${CLOUDFLARE_CONTAINER_REGISTRY+x}" = x ] || \
   [ "${WRANGLER_API_ENVIRONMENT+x}" = x ] || [ "${CLOUDFLARE_COMPLIANCE_REGION+x}" = x ] || \
   [ "${WRANGLER_AUTH_DOMAIN+x}" = x ] || [ "${WRANGLER_AUTH_URL+x}" = x ] || \
   [ "${WRANGLER_TOKEN_URL+x}" = x ] || [ "${WRANGLER_REVOKE_URL+x}" = x ] || \
   [ "${CLOUDFLARE_ACCOUNT_ID+x}" = x ] || [ "${CF_ACCOUNT_ID+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while a Cloudflare endpoint or account override is present." >&2
  exit 1
fi
if [ "${WRANGLER_LOG+x}" = x ] || [ "${WRANGLER_LOG_SANITIZE+x}" = x ] || \
   [ "${WRANGLER_LOG_PATH+x}" = x ] || [ "${WRANGLER_WRITE_LOGS+x}" = x ] || \
   [ "${WRANGLER_OUTPUT_FILE_PATH+x}" = x ] || [ "${WRANGLER_OUTPUT_FILE_DIRECTORY+x}" = x ]; then
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
case "$DEPLOY_NODE_PATH" in
  //*)
    printf '%s\n' "DEPLOY_NODE_PATH must not contain symlinked or non-canonical path components." >&2
    exit 1
    ;;
esac
if [ -L "$DEPLOY_NODE_PATH" ] || [ ! -f "$DEPLOY_NODE_PATH" ] || [ ! -x "$DEPLOY_NODE_PATH" ]; then
  printf '%s\n' "DEPLOY_NODE_PATH must be a regular, non-symlink executable." >&2
  exit 1
fi
node_parent=${DEPLOY_NODE_PATH%/*}
node_name=${DEPLOY_NODE_PATH##*/}
if [ -z "$node_parent" ]; then
  node_parent=/
fi
if ! physical_node_parent=$(CDPATH=; cd "$node_parent" && pwd -P); then
  printf '%s\n' "DEPLOY_NODE_PATH parent directory is unavailable." >&2
  exit 1
fi
if [ "$physical_node_parent" = / ]; then
  physical_node_path=/$node_name
else
  physical_node_path=$physical_node_parent/$node_name
fi
if [ "$DEPLOY_NODE_PATH" != "$physical_node_path" ]; then
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
integrity_path=$scripts_directory/staging-bundle-integrity.mjs
if [ -L "$scripts_directory" ] || [ ! -d "$scripts_directory" ] || \
   [ -L "$launcher_path" ] || [ ! -f "$launcher_path" ] || [ ! -x "$launcher_path" ] || \
   [ -L "$integrity_path" ] || [ ! -f "$integrity_path" ]; then
  printf '%s\n' "The reviewed secret launcher files are unavailable or unsafe." >&2
  exit 1
fi
if [ -z "${STAGING_INTEGRITY_SHA256:-}" ] || [ "${#STAGING_INTEGRITY_SHA256}" -ne 64 ]; then
  printf '%s\n' "STAGING_INTEGRITY_SHA256 must be the retained lowercase SHA-256 of the reviewed integrity entrypoint." >&2
  exit 1
fi
case "$STAGING_INTEGRITY_SHA256" in
  *[!0-9a-f]*)
    printf '%s\n' "STAGING_INTEGRITY_SHA256 must be the retained lowercase SHA-256 of the reviewed integrity entrypoint." >&2
    exit 1
    ;;
esac

unset NODE_OPTIONS NODE_PATH CLOUDFLARE_API_BASE_URL CF_API_BASE_URL CLOUDFLARE_BASE_URL
unset CLOUDFLARE_CONTAINER_REGISTRY WRANGLER_API_ENVIRONMENT CLOUDFLARE_COMPLIANCE_REGION
unset WRANGLER_AUTH_DOMAIN WRANGLER_AUTH_URL WRANGLER_TOKEN_URL WRANGLER_REVOKE_URL
unset CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID
unset WRANGLER_LOG WRANGLER_LOG_SANITIZE WRANGLER_LOG_PATH WRANGLER_WRITE_LOGS
unset WRANGLER_OUTPUT_FILE_PATH WRANGLER_OUTPUT_FILE_DIRECTORY
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
unset NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE
unset TMPDIR TMP TEMP
cd "$repository"

# Authenticate the entrypoint bytes and execute those exact bytes in the same
# approved Node process. Reopening the repository path after verification would
# permit a replacement race before credential-bearing execution.
exec "$DEPLOY_NODE_PATH" -e '
  const { createHash } = require("node:crypto");
  const { lstatSync, readFileSync } = require("node:fs");
  const [launcher, entrypoint, expected, secretName] = process.argv.slice(1);
  function inspect(path) {
    const value = lstatSync(path);
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
      throw new Error("unsafe-file");
    }
    return value;
  }
  let bytes;
  try {
    inspect(launcher);
    const before = inspect(entrypoint);
    bytes = readFileSync(entrypoint);
    const after = inspect(entrypoint);
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("changed-file");
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error("digest-mismatch");
  } catch {
    process.stderr.write("The integrity entrypoint does not match the retained reviewed digest or has an unsafe file type.\n");
    process.exit(1);
  }
  process.argv = [process.execPath, entrypoint, "secret", secretName];
  import(`data:text/javascript;base64,${bytes.toString("base64")}`).catch(() => {
    process.stderr.write("The authenticated integrity entrypoint could not be executed.\n");
    process.exit(1);
  });
' "$launcher_path" "$integrity_path" "$STAGING_INTEGRITY_SHA256" "$secret_name"

#!/bin/sh
set -eu

if [ "${NODE_OPTIONS+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while NODE_OPTIONS is set." >&2
  exit 1
fi
if [ "${NODE_PATH+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while NODE_PATH is set." >&2
  exit 1
fi
if [ "${CLOUDFLARE_API_BASE_URL+x}" = x ] || [ "${CF_API_BASE_URL+x}" = x ] || \
   [ "${CLOUDFLARE_BASE_URL+x}" = x ] || [ "${CLOUDFLARE_CONTAINER_REGISTRY+x}" = x ] || \
   [ "${WRANGLER_API_ENVIRONMENT+x}" = x ] || [ "${CLOUDFLARE_COMPLIANCE_REGION+x}" = x ] || \
   [ "${WRANGLER_AUTH_DOMAIN+x}" = x ] || [ "${WRANGLER_AUTH_URL+x}" = x ] || \
   [ "${WRANGLER_TOKEN_URL+x}" = x ] || [ "${WRANGLER_REVOKE_URL+x}" = x ] || \
   [ "${CLOUDFLARE_ACCOUNT_ID+x}" = x ] || [ "${CF_ACCOUNT_ID+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while a Cloudflare endpoint or account override is present." >&2
  exit 1
fi
if [ "${WRANGLER_LOG+x}" = x ] || [ "${WRANGLER_LOG_SANITIZE+x}" = x ] || \
   [ "${WRANGLER_LOG_PATH+x}" = x ] || [ "${WRANGLER_WRITE_LOGS+x}" = x ] || \
   [ "${WRANGLER_OUTPUT_FILE_PATH+x}" = x ] || [ "${WRANGLER_OUTPUT_FILE_DIRECTORY+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while Wrangler logging overrides are present." >&2
  exit 1
fi
if [ "${HTTP_PROXY+x}" = x ] || [ "${HTTPS_PROXY+x}" = x ] || [ "${ALL_PROXY+x}" = x ] || \
   [ "${http_proxy+x}" = x ] || [ "${https_proxy+x}" = x ] || [ "${all_proxy+x}" = x ] || \
   [ "${NO_PROXY+x}" = x ] || [ "${no_proxy+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while proxy settings are present." >&2
  exit 1
fi
if [ "${NODE_EXTRA_CA_CERTS+x}" = x ] || [ "${NODE_TLS_REJECT_UNAUTHORIZED+x}" = x ] || \
   [ "${OPENSSL_CONF+x}" = x ] || [ "${SSL_CERT_FILE+x}" = x ] || \
   [ "${SSL_CERT_DIR+x}" = x ] || [ "${CURL_CA_BUNDLE+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while TLS overrides are present." >&2
  exit 1
fi

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

case "$0" in
  scripts/deploy-verified-bundle.sh | ./scripts/deploy-verified-bundle.sh) ;;
  *)
    printf '%s\n' "Run the deployment launcher directly from the reviewed repository root." >&2
    exit 1
    ;;
esac
repository_root=$(pwd -P)
if [ "${PWD:-}" != "$repository_root" ]; then
  printf '%s\n' "Run the deployment launcher directly from the reviewed repository root." >&2
  exit 1
fi
launcher_path="$repository_root/scripts/deploy-verified-bundle.sh"
integrity_path="$repository_root/scripts/staging-bundle-integrity.mjs"
if [ -L "$launcher_path" ] || [ ! -f "$launcher_path" ] || \
   [ -L "$integrity_path" ] || [ ! -f "$integrity_path" ]; then
  printf '%s\n' "Deployment launcher files must be regular, non-symlink files in the reviewed repository root." >&2
  exit 1
fi
if [ -z "${STAGING_INTEGRITY_SHA256:-}" ] || [ "${#STAGING_INTEGRITY_SHA256}" -ne 64 ]; then
  printf '%s\n' "STAGING_INTEGRITY_SHA256 must be the retained lowercase SHA-256 of the reviewed deployment entrypoint." >&2
  exit 1
fi
case "$STAGING_INTEGRITY_SHA256" in
  *[!0-9a-f]*)
    printf '%s\n' "STAGING_INTEGRITY_SHA256 must be the retained lowercase SHA-256 of the reviewed deployment entrypoint." >&2
    exit 1
    ;;
esac

# Hash the entrypoint with the already approved Node executable. Inline code is used
# here so no unverified repository JavaScript receives deployment credentials first.
"$DEPLOY_NODE_PATH" -e '
  const { createHash } = require("node:crypto");
  const { lstatSync, readFileSync } = require("node:fs");
  const [launcher, entrypoint, expected] = process.argv.slice(1);
  function inspect(path) {
    const value = lstatSync(path);
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
      throw new Error("unsafe-file");
    }
    return value;
  }
  try {
    inspect(launcher);
    const before = inspect(entrypoint);
    const bytes = readFileSync(entrypoint);
    const after = inspect(entrypoint);
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("changed-file");
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error("digest-mismatch");
  } catch {
    process.exit(1);
  }
' "$launcher_path" "$integrity_path" "$STAGING_INTEGRITY_SHA256" || {
  printf '%s\n' "The deployment entrypoint does not match the retained reviewed digest or has an unsafe file type." >&2
  exit 1
}

unset NODE_OPTIONS NODE_PATH CLOUDFLARE_API_BASE_URL CF_API_BASE_URL CLOUDFLARE_BASE_URL
unset CLOUDFLARE_CONTAINER_REGISTRY WRANGLER_API_ENVIRONMENT CLOUDFLARE_COMPLIANCE_REGION
unset WRANGLER_AUTH_DOMAIN WRANGLER_AUTH_URL WRANGLER_TOKEN_URL WRANGLER_REVOKE_URL
unset CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID
unset WRANGLER_LOG WRANGLER_LOG_SANITIZE WRANGLER_LOG_PATH WRANGLER_WRITE_LOGS
unset WRANGLER_OUTPUT_FILE_PATH WRANGLER_OUTPUT_FILE_DIRECTORY
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
unset NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE
unset TMPDIR TMP TEMP
exec "$DEPLOY_NODE_PATH" "$integrity_path" deploy "$@"

#!/bin/bash -p
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' "Usage: bootstrap-verified-secret-entry.sh <approved-secret-name>" >&2
  exit 1
fi
secret_name=$1
if [ "${BASH_ENV+x}" = x ] || [ "${ENV+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while shell startup overrides are present." >&2
  exit 1
fi
if [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_PATH+x}" = x ] || [ "${NODE_DEBUG+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while Node injection or debug settings are present." >&2
  exit 1
fi
loader_override=
for loader_name in ${!LD_@} ${!DYLD_@}; do
  loader_override=1
  break
done
if [ -n "$loader_override" ] || [ "${GLIBC_TUNABLES+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing secret entry while dynamic-loader overrides are present." >&2
  exit 1
fi
if [ "${CLOUDFLARE_API_BASE_URL+x}" = x ] || [ "${CF_API_BASE_URL+x}" = x ] || \
   [ "${CLOUDFLARE_BASE_URL+x}" = x ] || [ "${CLOUDFLARE_CONTAINER_REGISTRY+x}" = x ] || \
   [ "${WRANGLER_API_ENVIRONMENT+x}" = x ] || [ "${CLOUDFLARE_COMPLIANCE_REGION+x}" = x ] || \
   [ "${WRANGLER_AUTH_DOMAIN+x}" = x ] || [ "${WRANGLER_AUTH_URL+x}" = x ] || \
   [ "${WRANGLER_TOKEN_URL+x}" = x ] || [ "${WRANGLER_REVOKE_URL+x}" = x ] || \
   [ "${WRANGLER_CLIENT_ID+x}" = x ] || [ "${CLOUDFLARE_CLIENT_ID+x}" = x ] || \
   [ "${CLOUDFLARE_ACCESS_CLIENT_ID+x}" = x ] || [ "${CLOUDFLARE_ACCESS_CLIENT_SECRET+x}" = x ] || \
   [ "${CLOUDFLARE_AUTH_USE_KEYRING+x}" = x ] || \
   [ "${WRANGLER_CF_AUTHORIZATION_TOKEN+x}" = x ] || \
   [ "${CLOUDFLARE_INCLUDE_PROCESS_ENV+x}" = x ] || \
   [ "${CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV+x}" = x ] || \
   [ "${CLOUDFLARE_ACCOUNT_ID+x}" = x ] || [ "${CF_ACCOUNT_ID+x}" = x ] || \
   [ "${WRANGLER_CI_OVERRIDE_NAME+x}" = x ]; then
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
if [ -z "$node_parent" ]; then node_parent=/; fi
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
if [ -w "$DEPLOY_NODE_PATH" ] || [ -w "$node_parent" ]; then
  printf '%s\n' "DEPLOY_NODE_PATH and its parent directory must not be writable during secret entry." >&2
  exit 1
fi
if [ -z "${DEPLOY_NODE_SHA256:-}" ] || [ "${#DEPLOY_NODE_SHA256}" -ne 64 ]; then
  printf '%s\n' "DEPLOY_NODE_SHA256 must be the retained lowercase SHA-256 of the reviewed Node executable." >&2
  exit 1
fi
case "$DEPLOY_NODE_SHA256" in
  *[!0-9a-f]*)
    printf '%s\n' "DEPLOY_NODE_SHA256 must be the retained lowercase SHA-256 of the reviewed Node executable." >&2
    exit 1
    ;;
esac

repository_root=$(pwd -P)
if [ "${PWD:-}" != "$repository_root" ]; then
  printf '%s\n' "Run the independently retained secret-entry bootstrap from the physical reviewed repository root." >&2
  exit 1
fi
launcher_path="$repository_root/scripts/put-staging-secret.sh"
if [ -L "$launcher_path" ] || [ ! -f "$launcher_path" ] || [ -x "$launcher_path" ]; then
  printf '%s\n' "The secret-entry launcher must remain a regular, non-symlink, non-executable file in the reviewed repository root." >&2
  exit 1
fi
if [ -z "${STAGING_SECRET_LAUNCHER_SHA256:-}" ] || [ "${#STAGING_SECRET_LAUNCHER_SHA256}" -ne 64 ]; then
  printf '%s\n' "STAGING_SECRET_LAUNCHER_SHA256 must be the retained lowercase SHA-256 of the reviewed secret-entry launcher." >&2
  exit 1
fi
case "$STAGING_SECRET_LAUNCHER_SHA256" in
  *[!0-9a-f]*)
    printf '%s\n' "STAGING_SECRET_LAUNCHER_SHA256 must be the retained lowercase SHA-256 of the reviewed secret-entry launcher." >&2
    exit 1
    ;;
esac

# Copy this bootstrap to an independently controlled absolute path before
# authentication is made available. Authenticate the repository launcher through
# one descriptor, then execute only those exact bytes over standard input.
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH NODE_DEBUG
for loader_name in ${!LD_@} ${!DYLD_@}; do
  unset "$loader_name"
done
unset GLIBC_TUNABLES
unset CLOUDFLARE_API_BASE_URL CF_API_BASE_URL CLOUDFLARE_BASE_URL
unset CLOUDFLARE_CONTAINER_REGISTRY WRANGLER_API_ENVIRONMENT CLOUDFLARE_COMPLIANCE_REGION
unset WRANGLER_AUTH_DOMAIN WRANGLER_AUTH_URL WRANGLER_TOKEN_URL WRANGLER_REVOKE_URL
unset CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID WRANGLER_CI_OVERRIDE_NAME
unset WRANGLER_LOG WRANGLER_LOG_SANITIZE WRANGLER_LOG_PATH WRANGLER_WRITE_LOGS
unset WRANGLER_OUTPUT_FILE_PATH WRANGLER_OUTPUT_FILE_DIRECTORY
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
unset NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE
unset PERL5OPT PERL5LIB PERLLIB PERL_LOCAL_LIB_ROOT PERL_MB_OPT PERL_MM_OPT
unset TMPDIR TMP TEMP

# Re-authenticate the reviewed non-writable runtime immediately before execution.
# The operational procedure additionally forbids concurrent writers.
actual_node_sha256=$(
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/shasum -a 256 "$DEPLOY_NODE_PATH"
)
actual_node_sha256=${actual_node_sha256%% *}
if [ "$actual_node_sha256" != "$DEPLOY_NODE_SHA256" ]; then
  printf '%s\n' "The approved Node executable does not match its retained reviewed digest." >&2
  exit 1
fi

exec "$DEPLOY_NODE_PATH" -e '
  const { spawnSync } = require("node:child_process");
  const { createHash, timingSafeEqual } = require("node:crypto");
  const { closeSync, constants, fstatSync, openSync, readFileSync } = require("node:fs");
  const [launcher, expected, secretName] = process.argv.slice(1);
  let descriptor;
  let bytes;
  try {
    descriptor = openSync(launcher, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o111n) !== 0n) {
      throw new Error("unsafe-file");
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (after.nlink !== before.nlink || after.dev !== before.dev ||
        after.ino !== before.ino || after.mode !== before.mode ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs) {
      throw new Error("changed-file");
    }
    const actual = createHash("sha256").update(bytes).digest();
    const approved = Buffer.from(expected, "hex");
    if (approved.length !== actual.length || !timingSafeEqual(actual, approved)) {
      throw new Error("digest-mismatch");
    }
  } catch {
    process.stderr.write("The secret-entry launcher does not match the retained reviewed digest or has an unsafe file type.\n");
    process.exit(1);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^BASH_FUNC_.*%%$/u.test(name)),
  );
  for (const name of ["BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS"]) {
    delete childEnvironment[name];
  }
  const result = spawnSync("/bin/sh", ["-s", "--", secretName], {
    cwd: process.cwd(),
    env: childEnvironment,
    input: bytes,
    // fd 0 carries authenticated script bytes. fd 3 preserves original
    // operator stdin so the launcher can restore it before Wrangler prompts.
    stdio: ["pipe", "inherit", "inherit", 0],
  });
  if (result.error || result.signal || result.status !== 0) process.exit(1);
' "$launcher_path" "$STAGING_SECRET_LAUNCHER_SHA256" "$secret_name"

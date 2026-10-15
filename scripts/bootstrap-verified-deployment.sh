#!/bin/bash -p
set -eu

if [ "$#" -ne 0 ]; then
  printf '%s\n' "The verified deployment bootstrap does not accept arguments." >&2
  exit 1
fi
if [ "${BASH_ENV+x}" = x ] || [ "${ENV+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while shell startup overrides are present." >&2
  exit 1
fi
if [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_PATH+x}" = x ] || [ "${NODE_DEBUG+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while Node injection or debug settings are present." >&2
  exit 1
fi
if [ "${LD_PRELOAD+x}" = x ] || [ "${LD_LIBRARY_PATH+x}" = x ] || \
   [ "${DYLD_INSERT_LIBRARIES+x}" = x ] || [ "${DYLD_LIBRARY_PATH+x}" = x ] || \
   [ "${DYLD_FRAMEWORK_PATH+x}" = x ] || [ "${DYLD_FALLBACK_LIBRARY_PATH+x}" = x ] || \
   [ "${DYLD_FALLBACK_FRAMEWORK_PATH+x}" = x ]; then
  printf '%s\n' "Refusing credential-bearing deployment while dynamic-loader overrides are present." >&2
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

repository_root=$(pwd -P)
if [ "${PWD:-}" != "$repository_root" ]; then
  printf '%s\n' "Run the independently retained deployment bootstrap from the physical reviewed repository root." >&2
  exit 1
fi
launcher_path="$repository_root/scripts/deploy-verified-bundle.sh"
if [ -L "$launcher_path" ] || [ ! -f "$launcher_path" ] || [ -x "$launcher_path" ]; then
  printf '%s\n' "The deployment launcher must remain a regular, non-symlink, non-executable file in the reviewed repository root." >&2
  exit 1
fi
if [ -z "${STAGING_LAUNCHER_SHA256:-}" ] || [ "${#STAGING_LAUNCHER_SHA256}" -ne 64 ]; then
  printf '%s\n' "STAGING_LAUNCHER_SHA256 must be the retained lowercase SHA-256 of the reviewed deployment launcher." >&2
  exit 1
fi
case "$STAGING_LAUNCHER_SHA256" in
  *[!0-9a-f]*)
    printf '%s\n' "STAGING_LAUNCHER_SHA256 must be the retained lowercase SHA-256 of the reviewed deployment launcher." >&2
    exit 1
    ;;
esac

# This bootstrap must be copied to and invoked from an independently controlled
# path before credentials are made available. Its inline verifier opens the
# repository launcher once, authenticates that descriptor, and gives the exact
# authenticated bytes to /bin/sh over stdin; it never executes the mutable path.
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH NODE_DEBUG LD_PRELOAD LD_LIBRARY_PATH
unset DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
unset CLOUDFLARE_API_BASE_URL CF_API_BASE_URL CLOUDFLARE_BASE_URL
unset CLOUDFLARE_CONTAINER_REGISTRY WRANGLER_API_ENVIRONMENT CLOUDFLARE_COMPLIANCE_REGION
unset WRANGLER_AUTH_DOMAIN WRANGLER_AUTH_URL WRANGLER_TOKEN_URL WRANGLER_REVOKE_URL
unset CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID
unset WRANGLER_LOG WRANGLER_LOG_SANITIZE WRANGLER_LOG_PATH WRANGLER_WRITE_LOGS
unset WRANGLER_OUTPUT_FILE_PATH WRANGLER_OUTPUT_FILE_DIRECTORY
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
unset NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE
unset TMPDIR TMP TEMP
exec "$DEPLOY_NODE_PATH" -e '
  const { spawnSync } = require("node:child_process");
  const { createHash, timingSafeEqual } = require("node:crypto");
  const { closeSync, constants, fstatSync, openSync, readFileSync } = require("node:fs");
  const [launcher, expected] = process.argv.slice(1);
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
    process.stderr.write("The deployment launcher does not match the retained reviewed digest or has an unsafe file type.\n");
    process.exit(1);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^BASH_FUNC_.*%%$/u.test(name),
    ),
  );
  for (const name of ["BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS"]) {
    delete childEnvironment[name];
  }
  const result = spawnSync("/bin/sh", ["-s"], {
    cwd: process.cwd(),
    env: childEnvironment,
    input: bytes,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error || result.signal || result.status !== 0) process.exit(1);
' "$launcher_path" "$STAGING_LAUNCHER_SHA256"

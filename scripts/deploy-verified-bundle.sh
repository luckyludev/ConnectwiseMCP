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

unset NODE_OPTIONS NODE_PATH
exec node scripts/staging-bundle-integrity.mjs deploy "$@"

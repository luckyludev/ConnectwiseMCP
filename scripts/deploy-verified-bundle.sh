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

unset NODE_OPTIONS NODE_PATH
exec "$DEPLOY_NODE_PATH" scripts/staging-bundle-integrity.mjs deploy "$@"

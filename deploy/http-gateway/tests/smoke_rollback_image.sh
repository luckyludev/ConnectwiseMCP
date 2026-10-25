#!/usr/bin/env bash
set -euo pipefail

image="${1:-connectwise-legacy-rollback-ci}"
container="legacy-rollback-smoke-${GITHUB_RUN_ID:-local}-$$"
invalid_static_container="${container}-missing-static"
invalid_jwt_container="${container}-missing-jwt"
health_body="$(mktemp)"
unauthorized_body="$(mktemp)"
invalid_log="$(mktemp)"

cleanup() {
  docker rm -f \
    "$container" \
    "$invalid_static_container" \
    "$invalid_jwt_container" >/dev/null 2>&1 || true
  rm -f "$health_body" "$unauthorized_body" "$invalid_log"
}
trap cleanup EXIT

fail_with_logs() {
  local failed_container="$1"
  local message="$2"
  printf '%s\n' "$message" >&2
  docker logs "$failed_container" >&2 || true
  exit 1
}

common_env=(
  --env SERVER_URL=http://127.0.0.1:8000
  --env MCP_RESOURCE_URL=http://127.0.0.1:8000
  --env CONNECTWISE_API_URL=https://connectwise.invalid/apis/3.0
  --env CONNECTWISE_COMPANY_ID=ci-only-company
  --env CONNECTWISE_PUBLIC_KEY=ci-only-public-key
  --env CONNECTWISE_PRIVATE_KEY=ci-only-private-key
  --env CONNECTWISE_AUTH_PREFIX=ci-only-prefix+
)
runtime_security=(
  --user 10001:10001
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --read-only
  --pids-limit 128
  --tmpfs /run/connectwise-memory:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700
)

runtime_uid="$(docker run --rm "${runtime_security[@]}" --entrypoint python "$image" -c 'import os; print(os.geteuid())')"
if [[ "$runtime_uid" != "10001" ]]; then
  printf '%s\n' "Rollback image must run as the exact numeric non-root user 10001:10001." >&2
  exit 1
fi

if docker run --rm "${runtime_security[@]}" --entrypoint python "$image" \
  -c 'from pathlib import Path; Path("/app/unexpected-write").write_text("must fail", encoding="utf-8")'
then
  printf '%s\n' "Rollback image root filesystem unexpectedly accepted a write." >&2
  exit 1
fi

docker run --rm "${runtime_security[@]}" --entrypoint python "$image" -c \
  'from api_gateway.fast_memory_db import FastMemoryDB; db = FastMemoryDB("/run/connectwise-memory/fast_memory_api.db"); db.save_query("ephemeral-canary", "/ephemeral-canary", "GET"); db.close()'
docker run --rm "${runtime_security[@]}" --entrypoint python "$image" -c \
  'from pathlib import Path; assert not Path("/run/connectwise-memory/fast_memory_api.db").exists()'

docker run --detach --name "$container" \
  "${runtime_security[@]}" \
  --publish 127.0.0.1::8000 \
  --health-interval 1s \
  --health-timeout 3s \
  --health-start-period 1s \
  --health-retries 20 \
  --env MCP_STATIC_TOKEN=ci-only-static-token-000000000000000000000000 \
  --env JWT_SECRET_KEY=ci-only-jwt-secret-00000000000000000000000000 \
  "${common_env[@]}" \
  "$image" >/dev/null

if [[ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")" != "128" ]]; then
  fail_with_logs "$container" "Rollback image did not run with the exact 128-process PID ceiling."
fi

healthy=false
for ((attempt = 1; attempt <= 45; attempt += 1)); do
  state="$(docker inspect --format '{{.State.Status}}' "$container")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")"
  if [[ "$state" == "exited" || "$state" == "dead" ]]; then
    fail_with_logs "$container" "Rollback image exited before becoming healthy."
  fi
  if [[ "$health" == "healthy" ]]; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != "true" ]]; then
  fail_with_logs "$container" "Rollback image did not become healthy within 45 seconds."
fi

host_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort}}' "$container")"
base_url="http://127.0.0.1:${host_port}"

health_status="$(curl --connect-timeout 3 --max-time 10 --silent --show-error --output "$health_body" --write-out '%{http_code}' "${base_url}/health")" || \
  fail_with_logs "$container" "Rollback image health request failed."
if [[ "$health_status" != "200" || "$(<"$health_body")" != '{"status":"healthy"}' ]]; then
  fail_with_logs "$container" "Rollback image health response was not the exact expected status and body."
fi

status="$(curl --connect-timeout 3 --max-time 10 --silent --show-error --output "$unauthorized_body" --write-out '%{http_code}' "${base_url}/mcp")" || \
  fail_with_logs "$container" "Rollback image unauthenticated MCP request failed."
if [[ "$status" != "401" ]]; then
  fail_with_logs "$container" "Rollback image did not enforce authentication on the MCP endpoint."
fi

check_missing_secret() {
  local name="$1"
  local expected_diagnostic="$2"
  local exit_code
  local stopped=false
  shift 2

  docker run --detach --name "$name" \
    "${runtime_security[@]}" \
    "${common_env[@]}" \
    "$@" \
    "$image" >/dev/null

  for ((attempt = 1; attempt <= 15; attempt += 1)); do
    state="$(docker inspect --format '{{.State.Status}}' "$name")"
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      stopped=true
      break
    fi
    sleep 1
  done
  if [[ "$stopped" != "true" ]]; then
    fail_with_logs "$name" "Rollback image did not fail fast when a required secret was absent."
  fi

  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
  if [[ ! "$exit_code" =~ ^[0-9]+$ || "$exit_code" -eq 0 ]]; then
    fail_with_logs "$name" "Rollback image unexpectedly started without a required secret."
  fi

  docker logs "$name" >"$invalid_log" 2>&1 || true
  if ! grep -Fxq "$expected_diagnostic" "$invalid_log"; then
    fail_with_logs "$name" "Rollback image failed for an unexpected reason during required-secret validation."
  fi
}

check_missing_secret \
  "$invalid_static_container" \
  "RuntimeError: Missing required environment variable: MCP_STATIC_TOKEN" \
  --env JWT_SECRET_KEY=ci-only-jwt-secret-00000000000000000000000000

check_missing_secret \
  "$invalid_jwt_container" \
  "RuntimeError: Missing required environment variable: JWT_SECRET_KEY" \
  --env MCP_STATIC_TOKEN=ci-only-static-token-000000000000000000000000

printf '%s\n' "Rollback image startup, health, auth boundary, and fail-fast checks passed."

#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke_cloudflared_read_only.sh IMAGE}"
container="legacy-cloudflared-read-only-smoke-${GITHUB_RUN_ID:-local}-$$"
log_file="$(mktemp)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$log_file"
}
trap cleanup EXIT

test_tunnel_token="$(python3 -c 'import base64, json; payload = {"a": "00000000000000000000000000000001", "t": "00000000-0000-4000-8000-000000000001", "s": "Y2ktb25seS1ub3QtYS1zZWNyZXQ="}; print(base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode())')"

docker run --detach --name "$container" \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --read-only \
  --env TUNNEL_TOKEN="$test_tunnel_token" \
  "$image" tunnel run >/dev/null

for ((attempt = 1; attempt <= 10; attempt += 1)); do
  state="$(docker inspect --format '{{.State.Status}}' "$container")"
  if [[ "$state" == "exited" || "$state" == "dead" ]]; then
    docker logs "$container" >"$log_file" 2>&1 || true
    printf '%s\n' "cloudflared exited during the read-only tunnel startup smoke test." >&2
    printf '%s\n' "--- sanitized cloudflared test logs ---" >&2
    sed -E 's/[A-Za-z0-9_-]{24,}/[redacted]/g' "$log_file" >&2
    exit 1
  fi
  sleep 1
done

docker logs "$container" >"$log_file" 2>&1 || true
if grep -Eiq 'read-only file system|permission denied' "$log_file"; then
  printf '%s\n' "cloudflared attempted a forbidden filesystem write." >&2
  sed -E 's/[A-Za-z0-9_-]{24,}/[redacted]/g' "$log_file" >&2
  exit 1
fi

printf '%s\n' "cloudflared tunnel command remained running with a read-only root filesystem."

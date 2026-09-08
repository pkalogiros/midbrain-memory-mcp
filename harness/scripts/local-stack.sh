#!/bin/bash
# Run the MidBrain API locally for the harness: up | seed | status | down
# Uses the `memory` repo's docker-compose stack and its dev seed script. Keys are never echoed.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEM="${MIDBRAIN_MEMORY_REPO:-$HERE/../memory}"
API="${MIDBRAIN_HARNESS_API_URL:-http://127.0.0.1:8000}"
ENV_FILE="$HERE/harness/.env"
cmd="${1:-status}"

need_repo() { [ -f "$MEM/docker-compose.yml" ] || { echo "memory repo not found at $MEM (set MIDBRAIN_MEMORY_REPO)"; exit 1; }; }
wait_health() {
  local i=0
  until curl -sf -m 3 "$API/health" >/dev/null 2>&1; do
    i=$((i+5)); if [ $i -ge 300 ]; then echo "API not healthy after 300s"; (cd "$MEM" && docker compose ps && docker compose logs --tail=40 memory-api); exit 1; fi
    sleep 5
  done
  echo "API healthy: $(curl -s -m 5 "$API/health")"
}
seed_one() { (cd "$MEM" && docker compose exec -T memory-api python -m memory.scripts.dev_seed_agent "$1" 2>/dev/null) | awk -F': *' '/^agent_id/{a=$2} /^API key/{k=$2} END{print a" "k}'; }
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true; }
env_set() {
  local k="$1" v="$2"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -qE "^$k=" "$ENV_FILE"; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "$k=$v" >> "$ENV_FILE"
  fi
}

case "$cmd" in
  up)
    need_repo
    if ! docker info >/dev/null 2>&1; then echo "starting Docker Desktop…"; open -a Docker || true; i=0; until docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 120 ] && { echo "docker did not start"; exit 1; }; sleep 1; done; fi
    (cd "$MEM" && docker compose up -d --build)
    wait_health
    ;;
  seed)
    need_repo
    read -r A1 K1 <<<"$(seed_one midbrain-harness)"
    read -r A2 K2 <<<"$(seed_one midbrain-harness-project)"
    [ -n "${K1:-}" ] && [ -n "${K2:-}" ] || { echo "seeding failed (is the stack up?)"; exit 1; }
    env_set MIDBRAIN_HARNESS_API_URL "$API"
    env_set MIDBRAIN_HARNESS_API_KEY "$K1"
    env_set MIDBRAIN_HARNESS_PROJECT_API_KEY "$K2"
    grep -qE '^ANTHROPIC_API_KEY=' "$ENV_FILE" || echo "ANTHROPIC_API_KEY=" >> "$ENV_FILE"
    grep -qE '^OPENAI_API_KEY=' "$ENV_FILE" || echo "OPENAI_API_KEY=" >> "$ENV_FILE"
    echo "seeded agents $A1 (harness) and $A2 (project); keys written to $ENV_FILE"
    echo "probe: HTTP $(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $K1" "$API/api/v1/memories/episodic?page=1&limit=1")"
    ;;
  status)
    need_repo
    (cd "$MEM" && docker compose ps --format '{{.Name}} {{.Status}}') || true
    K="$(env_get MIDBRAIN_HARNESS_API_KEY)"
    if [ -n "$K" ]; then echo "probe with harness key: HTTP $(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $K" "$API/api/v1/memories/episodic?page=1&limit=1")"; else echo "no MIDBRAIN_HARNESS_API_KEY in $ENV_FILE yet (run: $0 seed)"; fi
    ;;
  down)
    need_repo
    (cd "$MEM" && docker compose down)
    ;;
  *) echo "usage: $0 up|seed|status|down"; exit 2 ;;
esac

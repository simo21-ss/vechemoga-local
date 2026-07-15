#!/usr/bin/env bash
# Run the VecheMoga local stack in Docker. Everything lives under one Compose
# project ("vechemoga-local"), so Docker Desktop shows a single group. The stack is
# automation-ready by default (admin seeded, outgoing email captured).
#
# Interactive:   ./run.sh
# Non-interactive:
#   ./run.sh up        build + start the full stack (postgres + api + web + provider-proxy)
#   ./run.sh infra     postgres + provider-proxy only  (run api and/or web yourself)
#   ./run.sh no-api    everything except the API  (run the API from your IDE on :8080)
#   ./run.sh no-web    everything except the web  (run the web from the host: npm run dev:compose)
#   ./run.sh stop      stop containers, keep the data
#   ./run.sh clean     remove containers, volumes, and the built local images
#   ./run.sh logs [svc]  follow logs (all, or one service)
#   ./run.sh ps        show container status
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

# Adopt .env's values for our own probes and printed URLs. Compose gets the same file via
# --env-file below, but that only feeds ITS interpolation - without this, a port overridden
# in .env would move the container while run.sh kept probing the default (a silent 3-minute
# wait_for timeout against the wrong port). An already-exported var wins, matching Compose's
# precedence (shell env > --env-file).
if [[ -f "$ROOT_DIR/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    [[ -n "${!key:-}" ]] && continue      # already set in the shell -> that wins
    export "$key=${BASH_REMATCH[2]}"
  done < "$ROOT_DIR/.env"
fi

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-8080}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
PROXY_PORT="${PROXY_PORT:-1080}"

# Prefer the Compose v2 plugin; fall back to the legacy binary.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "ERROR: Docker Compose is not installed (need 'docker compose' or 'docker-compose')." >&2
  exit 1
fi

# Optional hub-level overrides (ports, credentials). Copy .env.example -> .env to use.
# ${ENV_ARGS[@]+"..."} keeps the empty-array expansion safe under `set -u` on the
# bash 3.2 that ships with macOS.
ENV_ARGS=()
[[ -f "$ROOT_DIR/.env" ]] && ENV_ARGS=(--env-file "$ROOT_DIR/.env")

dc() { "${COMPOSE[@]}" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} -f "$COMPOSE_FILE" "$@"; }

wait_for() { # name url
  local name="$1" url="$2" i
  printf 'Waiting for %s (%s) ' "$name" "$url"
  for i in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null 2>&1; then echo " up."; return 0; fi
    printf '.'; sleep 2
  done
  echo " timed out (still starting - check ./run.sh logs)."; return 0
}

urls() {
  echo
  echo "  web       → http://localhost:${WEB_PORT}   (admin.localhost:${WEB_PORT} · kid.localhost:${WEB_PORT})"
  echo "  api       → http://localhost:${API_PORT}   (health: /actuator/health · ping: /api/ping)"
  echo "  postgres  → localhost:${POSTGRES_PORT}      (db/user/pass: vechemoga · admin: admin@vechemoga.bg / admin)"
  echo "  proxy     → http://localhost:${PROXY_PORT}/__proxy/requests  (control plane: /__proxy/*)"
}

# --remove-orphans on every `up`: it drops containers whose service no longer exists in the
# compose file, so a renamed service (mailserver -> provider-proxy) doesn't leave the old
# container behind holding :1080. Services that are merely not part of this subset are still
# defined in the file, so they are untouched.
start_all() {
  dc up -d --build --remove-orphans
  wait_for api "http://localhost:${API_PORT}/actuator/health"
  urls
  echo
  echo "Automation-ready. Run the suite against it:"
  echo "  cd ../../VecheMogaAutomation && cp -n .env.example .env && npm ci && npm run test:smoke"
}

start_infra() {
  dc up -d --remove-orphans postgres provider-proxy
  wait_for provider-proxy "http://localhost:${PROXY_PORT}/__proxy/health"
  echo
  echo "  postgres  → localhost:${POSTGRES_PORT}   ·   provider-proxy → http://localhost:${PROXY_PORT}"
  echo "Now run the apps yourself (API from the IDE, web via 'npm run dev:compose')."
}

start_no_api() {
  # Web + provider-proxy in containers, API from your IDE on the host. Point the web's
  # SSR at the host so server-rendered pages still reach the IDE-run API.
  API_INTERNAL_BASE_URL="http://host.docker.internal:${API_PORT}" dc up -d --build --remove-orphans --scale api=0
  urls
  echo "API is NOT running - start it from your IDE (bootRun) on :${API_PORT}."
}

start_no_web() {
  dc up -d --build --remove-orphans --scale web=0
  wait_for api "http://localhost:${API_PORT}/actuator/health"
  urls
  echo "Web is NOT running - start it from the host:  cd ../../VecheMogaWeb && npm run dev:compose"
}

do_stop()  { dc stop; echo "Stopped. Data kept - start again with ./run.sh up."; }
do_clean() { dc down -v --rmi local --remove-orphans; echo "Removed containers, volumes, and the vechemoga-*:local images."; }
do_logs()  { if [[ $# -gt 0 ]]; then dc logs -f "$1"; else dc logs -f; fi; }
do_ps()    { dc ps; }

dispatch() {
  case "${1:-}" in
    up)      start_all ;;
    infra)   start_infra ;;
    no-api)  start_no_api ;;
    no-web)  start_no_web ;;
    stop)    do_stop ;;
    clean)   do_clean ;;
    logs)    shift || true; do_logs "$@" ;;
    ps)      do_ps ;;
    q|quit)  echo "Bye."; exit 0 ;;
    *)       echo "Unknown command: ${1:-}"; return 1 ;;
  esac
}

# Non-interactive.
if [[ $# -gt 0 ]]; then
  dispatch "$@"
  exit $?
fi

# Interactive menu.
while true; do
  echo
  echo "===== vechemoga-local · Docker ====="
  echo "  1) Start full stack   (postgres + api + web + provider-proxy — automation-ready)"
  echo "  2) Infra only         (postgres + provider-proxy — run the apps yourself)"
  echo "  3) All except api     (run the API from the IDE)"
  echo "  4) All except web     (run the web from the host)"
  echo "  5) Stop               (keep data)"
  echo "  6) Clean              (remove containers, volumes, images)"
  echo "  7) Follow logs"
  echo "  8) Status (ps)"
  echo "  0) Quit"
  read -r -p "Choose: " choice
  case "$choice" in
    1) dispatch up ;;
    2) dispatch infra ;;
    3) dispatch no-api ;;
    4) dispatch no-web ;;
    5) dispatch stop ;;
    6) dispatch clean ;;
    7) dispatch logs ;;
    8) dispatch ps ;;
    0|q|quit) echo "Bye."; exit 0 ;;
    *) echo "Invalid choice." ;;
  esac
done

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

# Read ONE key out of .env, or nothing if it isn't there. Compose gets the whole file
# via --env-file below and owns everything in it; this only recovers the handful of values
# run.sh needs for its own probes and printed URLs, so a key like COMPOSE_PROJECT_NAME can
# never reach Compose through our environment. Nothing is exported for the same reason.
#
# The stripping mirrors Compose's own .env rules: surrounding quotes are removed, and an
# unquoted trailing `# comment` is dropped. Anything fancier (escapes, multi-line values)
# is Compose's business - `dc port` below is what we actually trust once containers exist,
# so this only has to be right enough to name a port before then.
env_val() { # key -> value from .env, else empty
  local key="$1" line value
  [[ -f "$ROOT_DIR/.env" ]] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ROOT_DIR/.env" | tail -1)" || return 0
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  if [[ "$value" =~ ^[[:space:]]*\"(.*)\"[[:space:]]*$ || "$value" =~ ^[[:space:]]*\'(.*)\'[[:space:]]*$ ]]; then
    value="${BASH_REMATCH[1]}"                       # quoted: take it verbatim
  else
    value="${value%%#*}"                             # unquoted: a # starts a comment
  fi
  value="${value#"${value%%[![:space:]]*}"}"         # trim leading space
  value="${value%"${value##*[![:space:]]}"}"         # trim trailing space
  printf '%s' "$value"
}

# Shell env wins over .env, matching Compose's precedence (shell env > --env-file).
WEB_PORT="${WEB_PORT:-$(env_val WEB_PORT)}";           WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-$(env_val API_PORT)}";           API_PORT="${API_PORT:-8080}"
POSTGRES_PORT="${POSTGRES_PORT:-$(env_val POSTGRES_PORT)}"; POSTGRES_PORT="${POSTGRES_PORT:-5432}"
PROXY_PORT="${PROXY_PORT:-$(env_val PROXY_PORT)}";     PROXY_PORT="${PROXY_PORT:-1080}"

# The provider-proxy is a pulled release image (see docker-compose.yml). These mirror the
# compose defaults only so the ECR hint below can name the exact image `up` tried to get.
PROVIDER_PROXY_IMAGE="${PROVIDER_PROXY_IMAGE:-$(env_val PROVIDER_PROXY_IMAGE)}"
PROVIDER_PROXY_IMAGE="${PROVIDER_PROXY_IMAGE:-776051122865.dkr.ecr.eu-central-1.amazonaws.com/vechemoga/provider-proxy}"
PROVIDER_PROXY_TAG="${PROVIDER_PROXY_TAG:-$(env_val PROVIDER_PROXY_TAG)}"
PROVIDER_PROXY_TAG="${PROVIDER_PROXY_TAG:-latest}"

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

# Re-read the ports from Compose once the containers exist. Compose resolved .env itself, so
# what it published is the truth - asking it cannot drift from it, which is the failure this
# whole dance exists to prevent. Only a service that is actually running can answer: `no-api`
# scales the API to 0 (it's a host process there), so that one keeps its .env/default value.
sync_ports_from_compose() {
  local hostport
  for spec in "web:3000:WEB_PORT" "api:8080:API_PORT" "postgres:5432:POSTGRES_PORT" "provider-proxy:1080:PROXY_PORT"; do
    local svc="${spec%%:*}" rest="${spec#*:}"
    local cport="${rest%%:*}" var="${rest#*:}"
    # `dc port` prints e.g. "0.0.0.0:1090"; take the last line's port, ignore IPv6 duplicates.
    hostport="$(dc port "$svc" "$cport" 2>/dev/null | tail -1)" || continue
    [[ "$hostport" =~ :([0-9]+)[[:space:]]*$ ]] && printf -v "$var" '%s' "${BASH_REMATCH[1]}"
  done
}

# When `up` fails AND the proxy image is not in the local cache, the likeliest cause is an
# unauthenticated ECR pull (the image is private; login is needed once, and again for tag
# updates). Point at the one-liner instead of leaving a bare compose error. Deliberately no
# automatic `aws` call: once the image is cached, the whole stack must keep working offline.
up_or_hint() {
  "$@" && return 0
  local status=$?
  if ! docker image inspect "${PROVIDER_PROXY_IMAGE}:${PROVIDER_PROXY_TAG}" >/dev/null 2>&1; then
    cat >&2 <<EOF

If the failure above is the provider-proxy pull (401/403/no basic auth credentials):
the image is private ECR and needs a one-time login (also after 'clean' or a tag change):

  aws ecr get-login-password --region eu-central-1 --profile vechemoga-ops \\
    | docker login --username AWS --password-stdin 776051122865.dkr.ecr.eu-central-1.amazonaws.com

Then re-run this command. Once the image is cached locally, the stack runs fully offline.
EOF
  fi
  return "$status"
}

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
  up_or_hint dc up -d --build --remove-orphans
  sync_ports_from_compose
  wait_for api "http://localhost:${API_PORT}/actuator/health"
  urls
  echo
  echo "Automation-ready. Run the suite against it:"
  echo "  cd ../../VecheMogaAutomation && cp -n .env.example .env && npm ci && npm run test:smoke"
}

start_infra() {
  up_or_hint dc up -d --remove-orphans postgres provider-proxy
  sync_ports_from_compose
  wait_for provider-proxy "http://localhost:${PROXY_PORT}/__proxy/health"
  echo
  echo "  postgres  → localhost:${POSTGRES_PORT}   ·   provider-proxy → http://localhost:${PROXY_PORT}"
  echo "Now run the apps yourself (API from the IDE, web via 'npm run dev:compose')."
}

start_no_api() {
  # Web + provider-proxy in containers, API from your IDE on the host. Point the web's
  # SSR at the host so server-rendered pages still reach the IDE-run API.
  API_INTERNAL_BASE_URL="http://host.docker.internal:${API_PORT}" \
    up_or_hint dc up -d --build --remove-orphans --scale api=0
  sync_ports_from_compose
  urls
  echo "API is NOT running - start it from your IDE (bootRun) on :${API_PORT}."
}

start_no_web() {
  up_or_hint dc up -d --build --remove-orphans --scale web=0
  sync_ports_from_compose
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

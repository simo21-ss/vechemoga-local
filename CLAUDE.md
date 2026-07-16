# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The local-development hub for **Veche Moga** (vechemoga.bg): one Docker Compose stack that runs the whole
product on a developer's machine, plus the provider proxy-mock the automation suite needs. Docker Compose ·
Bash · Node 20 (the proxy only). **No application code lives here** — the app Dockerfiles live in their own
repos and this repo only *composes* them.

## Layout on disk (required)

All repos must sit side-by-side under one parent directory. The compose reaches out to `../../VecheMogaApi`
and `../../VecheMogaWeb` for their build contexts, so a nested or renamed checkout breaks `./run.sh up`.

```
VecheMoga/
├── VecheMogaApi          Spring Boot API  (its own Dockerfile)
├── VecheMogaWeb          Next.js web app  (its own Dockerfile)
├── VecheMogaAutomation   Cucumber + Playwright suite (runs on the host)
└── VecheMogaLocal        ← this repo
```

## Commands

Requires **Docker Desktop** (Compose v2). Node 20+ only to run the proxy or its tests outside Docker.

```bash
cd docker
./run.sh                 # interactive menu; same options as below
./run.sh up              # full stack: postgres + api + web + provider-proxy (automation-ready)
./run.sh infra           # postgres + provider-proxy only — run the apps yourself
./run.sh no-api          # everything except the API  (run it from the IDE on :8080)
./run.sh no-web          # everything except the web  (run it from the host)
./run.sh stop            # stop, keep data          ./run.sh clean   # remove containers, volumes, images
./run.sh logs [svc]      # follow logs              ./run.sh ps      # status
```

Checks (there is no build or test suite for the stack itself):

```bash
docker compose -f docker/docker-compose.yml config -q   # compose parses + interpolates
bash -n docker/run.sh                                   # run.sh syntax
cd provider-proxy && node --test test/                  # the proxy's contract test (no install)
```

The real check is behavioural: `./run.sh up`, then run the suite against it
(`cd ../VecheMogaAutomation && npm run test:smoke`). A change to the compose or the proxy is not verified
until the API has actually reached the proxy and a mailbox scenario has captured a token.

## Architecture

**This repo only composes.** The app Dockerfiles live in `VecheMogaApi/` and `VecheMogaWeb/`; nothing here
builds application code. Everything runs under the single Compose project `vechemoga-local`, so Docker Desktop
shows one group. `pgdata` persists across restarts; `clean` wipes it.

**The API's providers are configured in its profile, not here.** `application-local.yml` turns transactional
email *and* ESP on and points both Loops base-urls at `http://provider-proxy:1080`; `application-local-ide.yml`
does the same at `http://localhost:1080` for a host-run API. The compose overrides nothing — its `JAVA_OPTS` is
just `-XX:MaxRAMPercentage=75`. If a provider needs redirecting, change the profile in `VecheMogaApi`; that keeps
one description of the stack rather than two that can disagree. (Should you ever need an override here anyway,
use the **`-D` form, not env vars**: relaxed binding mangles `base-url` into `..._BASEURL` silently.)

**Off-prod runs the real provider clients, not no-op ones.** The point is to exercise the real code path — real
HTTP, real serialization, real error handling — and have the proxy absorb the last hop. A logging no-op exercises
none of that and defers every provider bug to production. This is why the proxy stubs unmatched traffic instead of
erroring: the ESP poller sweeps every contact every 60s with no expectation registered, and it must be absorbed,
not retried into `esp_sync_error`.

**The browser never calls the API directly.** `VecheMogaWeb/env.local` leaves `NEXT_PUBLIC_API_BASE_URL`
**empty**, so client calls go same-origin to `/api/*` on whichever host the page is on and Next's rewrite
proxies them to the server-only `API_INTERNAL_BASE_URL` (the compose sets `http://api:8080`). This is what lets
the `admin.`/`kid.localhost` subdomains authenticate: each `*.localhost` is its own site, so a direct call to
`localhost:8080` would be cross-site and the API's `SameSite=Lax` cookies would be dropped. `run.sh no-api`
overrides `API_INTERNAL_BASE_URL` to `host.docker.internal:8080` so a containerised web still reaches an
IDE-run API.

**[`provider-proxy/`](provider-proxy/README.md) is this repo's only source code** — a zero-dependency proxy-mock
(Node built-ins only) for the API's outbound HTTP providers: Loops, for both transactional mail and ESP contact
sync. It runs as the `provider-proxy` service and is the API's provider base URL for the whole stack, tests or
not. A client registers an expectation over the HTTP control plane (`/__proxy/*`) and reads the captured send back
out. Its contract is documented in [provider-proxy/README.md](provider-proxy/README.md) and pinned by
`node --test test/`.

- **`PROXY_UPSTREAM_URL` is unset by default, deliberately** — with no upstream there is *no code path* from a
  dev machine to a real inbox, which is what lets the profile point the real Loops clients here. Unmatched
  traffic is stubbed `200 {"success":true}` and journaled instead of forwarded. `.env.example` documents
  `https://app.loops.so/api` as the opt-in. The dummy `LOOPS_API_KEY` is **not** a safety net; it only makes a
  leaked send 401.
- **Unmatched traffic is journaled too**, which is what retires the register-the-expectation-first footgun: a
  suite can read a send back by `bodyPath` after the fact. Those entries carry no `matchedExpectationId`, so
  disposing an expectation can't prune them — `PROXY_JOURNAL_MAX` (a ring buffer) and `DELETE /__proxy/requests`
  are their only bounds.
- **`PROXY_PORT` means the host port only.** The container keeps the script's own 1080 default (no port var is
  passed in), so one name never means two things.
- Mounted **read-only into stock `node:20-alpine`**: the script needs no install, so the stack builds no image.
  `provider-proxy/Dockerfile` exists only for deploying it where this source isn't checked out; the compose
  doesn't use it.

**Test suites are clients, not owners.** `VecheMogaAutomation` talks to the proxy over HTTP and depends on
nothing here but `MAIL_MOCK_URL`. Its CI checks this repo out to run the proxy, so **a change to the proxy or
the compose can break that repo's pipeline** — check whether a change needs a companion PR there.

**`run.sh` reads `.env` itself.** Compose gets the same file via `--env-file`, but that only feeds *its*
interpolation; without run.sh reading it too, a port overridden in `.env` would move the container while
run.sh probed the default. An already-exported shell var wins, matching Compose's precedence. Every `up`/`clean`
passes `--remove-orphans` so a renamed service can't leave its old container holding a port.

## Conventions

- Do not add `Co-Authored-By` trailers or any Claude/Anthropic references to commit messages.
- **Keep `provider-proxy/` dependency-free** — no `package.json`, no npm install, Node built-ins only. That is
  what lets the stock node image run it from a read-only bind mount and the tests run with no setup.
- Keep the docs in sync with the stack in the same change: [README.md](README.md), [.env.example](.env.example),
  and [provider-proxy/README.md](provider-proxy/README.md) (the control-plane contract other repos code against).
- This is **local only**. Production deployment lives in `VecheMogaApi/deploy/` (API) and Amplify (web).

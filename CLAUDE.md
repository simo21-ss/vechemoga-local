# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The local-development hub for **Veche Moga** (vechemoga.bg): one Docker Compose stack that runs the whole
product on a developer's machine, plus the provider proxy-mock the automation suite needs. Docker Compose ·
Bash. **No source code lives here at all** — the app Dockerfiles live in their own repos, the provider-proxy
is a released image from its own repo, and this repo only *composes* them.

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

Requires **Docker Desktop** (Compose v2), plus a one-time ECR login for the provider-proxy image pull
(the `vechemoga-ops` CLI profile; `run.sh` prints the one-liner if the pull fails — cached image = offline).

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
```

The real check is behavioural: `./run.sh up`, then run the suite against it
(`cd ../VecheMogaAutomation && npm run test:smoke`). A change to the compose or the proxy is not verified
until the API has actually reached the proxy and a mailbox scenario has captured a token.

## Architecture

**This repo only composes.** The app Dockerfiles live in `VecheMogaApi/` and `VecheMogaWeb/`; nothing here
builds application code. Everything runs under the single Compose project `vechemoga-local`, so Docker Desktop
shows one group. `pgdata` persists across restarts; `clean` wipes it.

**The API's providers are configured in its profile, not here.** `application-local.yml` turns transactional
email *and* ESP on and points both Loops base-urls **and the Stripe base-url** at `http://provider-proxy:1080`;
`application-local-ide.yml` does the same at `http://localhost:1080` for a host-run API. The compose overrides nothing — it sets
`SPRING_PROFILES_ACTIVE` and stops; even `JAVA_OPTS` is the API image's own. If a provider needs redirecting,
change the profile in `VecheMogaApi`; that keeps one description of the stack rather than two that can disagree.
(Should you ever need an override here anyway, use the **`-D` form, not env vars**: relaxed binding mangles
`base-url` into `..._BASEURL` silently.)

**Off-prod runs the real provider clients, not no-op ones.** The point is to exercise the real code path — real
HTTP, real serialization, real error handling — and have the mock absorb the last hop. A logging no-op exercises
none of that and defers every provider bug to production. The mock **fails closed**: anything no mapping claimed
is answered `404 no_matching_stub`, and it has no egress at all. That is a deliberate reversal of the retired Node
proxy, which stubbed unmatched traffic `200`. One consequence to know: the ESP poller sweeps every contact every
60s registering no mapping, so it now takes 404s rather than being silently absorbed.

**The browser never calls the API directly.** `VecheMogaWeb/env.local` leaves `NEXT_PUBLIC_API_BASE_URL`
**empty**, so client calls go same-origin to `/api/*` on whichever host the page is on and Next's rewrite
proxies them to the server-only `API_INTERNAL_BASE_URL` (the compose sets `http://api:8080`). This is what lets
the `admin.`/`kid.localhost` subdomains authenticate: each `*.localhost` is its own site, so a direct call to
`localhost:8080` would be cross-site and the API's `SameSite=Lax` cookies would be dropped. `run.sh no-api`
overrides `API_INTERNAL_BASE_URL` to `host.docker.internal:8080` so a containerised web still reaches an
IDE-run API.

**The provider-proxy is a pulled release image, not source in this repo.** It is **stock WireMock 3.13.2 plus
mapping JSON** — no custom server, no extension, no control plane of our own — running as the `provider-proxy`
service, and it is the API's base URL for *every* provider for the whole stack, tests or not: both Loops clients
(transactional mail + ESP contact sync) and Stripe point at the one process. Clients drive it through WireMock's
own Admin API (`/__admin/*`): `POST /__admin/mappings` to register, `POST /__admin/requests/find` to read a
capture back. `/__proxy/*` and `/__sim/*` are **gone**. Its mappings, contract tests and pipeline live in
[`vechemoga-provider-proxy`](https://github.com/simo21-ss/vechemoga-provider-proxy) — **proxy changes happen
there, never here**; its pipeline pushes `:<sha12>` (immutable) to ECR
(`776051122865.dkr.ecr.eu-central-1.amazonaws.com/vechemoga/provider-proxy`) on every merge to its main.

- **It fails closed, and takes no environment at all.** There is no upstream/passthrough knob to set — the
  lowest-priority catch-all 404s anything unmatched and the entrypoint runs
  `--deny-proxy-targets 0.0.0.0-255.255.255.255,*`, so no mapping and no webhook can reach the internet. That is
  what lets the profile point the *real* clients here: no code path from a dev machine to a real inbox or a real
  charge, online or offline. Live Stripe keys are refused `403` (Bearer *and* HTTP Basic) before anything can
  forward them. The dummy `LOOPS_API_KEY` is **not** the safety net; the fail-closed default is.
- **Register the mapping before driving the action.** Nothing is journaled for later recovery the way the old
  proxy's unmatched entries were — unmatched means 404, not "readable afterwards".
- **Never call a global reset** (`POST /__admin/reset`, `DELETE /__admin/mappings`). It deletes the image's own
  fail-closed catch-all and live-key guards, disarming the safety properties for everyone until restart. Scope
  disposal with `remove-by-metadata` against metadata the caller attached.
- **Stripe pass-through does not exist yet.** The pinned build is Loops-scope; Stripe `/v1/*` fails closed. When
  it lands it is a `/v1/*` mapping plus `--allow-proxy-targets api.stripe.com` **in the proxy repo** — so the
  only reachable target is Stripe, and holding credentials never on its own causes egress.
- **`PROXY_PORT` means the host port only**, and it is bound to **`127.0.0.1`** on purpose: the Admin API is
  unauthenticated and can read captured bodies, so it must not be LAN-reachable. Don't rebind it to `0.0.0.0`.
  The container keeps WireMock's own 1080 (no port var is passed in), so one name never means two things.
- **Pin the tag; never `latest`.** The proxy pipeline deliberately does *not* move `:latest` — it still resolves
  to the retired Node proxy, kept there so unmigrated stacks keep working. The compose default is an exact
  `<sha12>`; `PROVIDER_PROXY_IMAGE`/`PROVIDER_PROXY_TAG` in `.env` override it. `run.sh`'s TAG default mirrors
  the compose one so its ECR hint names the image `up` actually tried to pull — change both together.
- **The image is private ECR** — the first pull (and any tag bump) needs a one-time login with the
  `vechemoga-ops` CLI profile; `run.sh` prints the exact one-liner when an unauthenticated pull fails, and
  deliberately never runs `aws` itself: once the image is cached locally, the stack must work fully offline.

**Test suites are clients, not owners.** `VecheMogaAutomation` talks to the mock over the Admin API and depends
on nothing here but `MAIL_MOCK_URL`. Its CI builds the image from the `vechemoga-provider-proxy` checkout, not
from this repo — but **a change to the compose or `run.sh` can still break that repo's pipeline**; check whether
a change needs a companion PR there. (As of the WireMock cutover its migration off `/__proxy/*` is still
outstanding — see the companion-changes list in the proxy repo's README.)

**`run.sh` reads `.env` itself.** Compose gets the same file via `--env-file`, but that only feeds *its*
interpolation; without run.sh reading it too, a port overridden in `.env` would move the container while
run.sh probed the default. An already-exported shell var wins, matching Compose's precedence. Every `up`/`clean`
passes `--remove-orphans` so a renamed service can't leave its old container holding a port.

## Conventions

- Do not add `Co-Authored-By` trailers or any Claude/Anthropic references to commit messages.
- **This repo carries no proxy source or mappings.** The proxy is owned by
  [`vechemoga-provider-proxy`](https://github.com/simo21-ss/vechemoga-provider-proxy): changes to its behaviour,
  its mapping JSON, or its entrypoint flags happen there, its pipeline releases the image, and this repo only
  picks the tag. Never vendor mapping JSON or a Dockerfile for it here.
- Keep the docs in sync with the stack in the same change: [README.md](README.md) and
  [.env.example](.env.example). The control-plane contract other repos code against is documented in the
  `vechemoga-provider-proxy` repo.
- This is **local only**. Production deployment lives in `VecheMogaApi/deploy/` (API) and Amplify (web).

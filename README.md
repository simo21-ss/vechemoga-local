# VecheMoga Local Development

The local-development hub for VecheMoga — one Docker Compose stack that runs the
whole product (Postgres + the Spring **API** + the Next.js **web** app) on your
machine, plus the extras the automation suite needs. It is the analog of Sesame's
`Local-Development/backend-docker`: the app **Dockerfiles live in their own repos**
([`VecheMogaApi/Dockerfile`](../VecheMogaApi/Dockerfile),
[`VecheMogaWeb/Dockerfile`](../VecheMogaWeb/Dockerfile)); this repo only **composes**
them and gives you the scripts to drive the stack.

## Layout on disk

All four repos must sit side-by-side under one parent directory:

```
VecheMoga/
├── VecheMogaApi          Spring Boot API  (its own Dockerfile)
├── VecheMogaWeb          Next.js web app  (its own Dockerfile — new)
├── VecheMogaAutomation   Cucumber + Playwright suite (runs on the host)
└── VecheMogaLocal        ← you are here (compose + scripts)
    ├── docker/
    │   ├── docker-compose.yml   the stack: postgres, api, web, provider-proxy
    │   ├── run.sh               interactive menu + non-interactive commands
    │   ├── stop.sh / clean.sh / showServiceNames.sh
    └── .env.example             optional port/credential/proxy-version overrides
```

The `provider-proxy` service is **not** built from this repo: it is a released Docker image
pulled from ECR — stock **WireMock 3.13.2 plus mapping JSON**, owned by
[`vechemoga-provider-proxy`](https://github.com/simo21-ss/vechemoga-provider-proxy)
(mappings, contract tests, and the AWS pipeline that publishes the image). This repo pins
an exact `:<sha12>` of it and nothing more.

## Prerequisites

- **Docker Desktop** (Compose v2).
- For running the automation suite: **Node 20+** (it runs on the host, not in Docker).

## Quick start

```bash
# One-time: log in to ECR so the provider-proxy image can be pulled (needs the
# vechemoga-ops CLI profile; needed again only after `clean` or a tag change —
# once the image is cached locally, everything below works offline).
aws ecr get-login-password --region eu-central-1 --profile vechemoga-ops \
  | docker login --username AWS --password-stdin 776051122865.dkr.ecr.eu-central-1.amazonaws.com

cd docker
./run.sh up          # build + start postgres + api + web + provider-proxy (detached)
```

Then:

| Service | URL |
|---|---|
| Web (parent + public) | http://localhost:3000 |
| Web — admin host | http://admin.localhost:3000 |
| Web — kid host | http://kid.localhost:3000 |
| API | http://localhost:8080 (`/actuator/health`, `/api/ping`) |
| Postgres | `localhost:5432` (db/user/pass: `vechemoga`) |
| Provider mock ([`vechemoga-provider-proxy`](https://github.com/simo21-ss/vechemoga-provider-proxy)) | http://127.0.0.1:1080 — WireMock Admin API `/__admin/*` (**localhost only**) |

`admin.localhost` / `kid.localhost` resolve to 127.0.0.1 automatically in
Chrome/Safari/Edge — the Next app splits the hosts in `src/proxy.ts`.

The interactive menu (just `./run.sh`) offers the same options as the commands below.

## Commands

```bash
./run.sh up        # full stack: postgres + api + web + provider-proxy (automation-ready)
./run.sh infra     # postgres + provider-proxy only — run the apps yourself
./run.sh no-api    # everything except the API  (run it from your IDE on :8080)
./run.sh no-web    # everything except the web  (run it from the host: npm run dev:compose)
./run.sh stop      # stop, keep data
./run.sh clean     # remove containers, volumes, and the built local images
./run.sh logs [svc]# follow logs (all, or one service: api | web | postgres | provider-proxy)
./run.sh ps        # container status
```

Everything runs under the single Compose project **`vechemoga-local`**, so Docker
Desktop shows one group. DB data persists in the `pgdata` volume across restarts;
`clean` wipes it.

### Developing one app while the rest runs in Docker

- **Working on the API** → `./run.sh no-api`, then run the API from IntelliJ
  (`bootRun`) on :8080. The containerised web points its server-side rendering at
  `host.docker.internal:8080` automatically so SSR still reaches your IDE-run API.
- **Working on the web** → `./run.sh no-web`, then
  `cd ../../VecheMogaWeb && npm run dev:compose` on the host (:3000 → API on :8080).

## Running the automation suite against this stack

> **The suite does not pass against this stack yet.** It still drives the retired `/__proxy/*`
> control plane, which the WireMock mock answers `404 no_matching_stub`, so every mailbox
> scenario fails no matter what the stack does. Its migration to `/__admin/*` is the
> outstanding companion change; until it lands, verify captures by hand (see
> [Working with the provider mock](#working-with-the-provider-mock)). The rest of this
> section describes how the two fit together, and applies again once that migration ships.

The suite ([`VecheMogaAutomation`](../VecheMogaAutomation)) runs on the **host** and
targets the published ports. The API's `local` profile seeds the admin and the mock captures
outgoing email, so there is no special mode: `./run.sh up` is enough.

```bash
cd docker
./run.sh up                       # the stack is automation-ready as-is

cd ../../VecheMogaAutomation
cp -n .env.example .env           # local defaults already match this stack
npm ci
npm run test:smoke                # @smoke gate   (or: test:api | test:e2e | test)
```

`.env` defaults (`WEB_BASE_URL=http://localhost:3000`, `API_BASE_URL=http://localhost:8080`,
`MAIL_MOCK_URL=http://localhost:1080`, admin `admin@vechemoga.bg` / `admin`) line up
with the stack out of the box. The suite **never** targets production.

## How the pieces fit

- **API** runs the Spring `local` profile (`application-local.yml`): datasource →
  `postgres:5432`, admin **seeded** (`admin@vechemoga.bg` / `admin`), S3 off.
  Liquibase migrates the schema on boot — no SQL seed files to mount. Transactional
  email **and** ESP contact sync are **on**, with both Loops base-urls *and* the Stripe
  base-url pointed at `http://provider-proxy:1080` — one mock process fronts every
  provider, so the real provider clients run for real (real HTTP, real serialization, real
  error handling) and WireMock absorbs the last hop. The compose overrides none of it: the
  profile describes this stack.
- **Web** runs `next dev` with its committed `env.local` profile (same as
  `npm run dev:compose`). The **browser never calls the API directly**: `env.local`
  leaves `NEXT_PUBLIC_API_BASE_URL` empty, so client calls go same-origin to `/api/*`
  on whichever host the page is on and Next's rewrite proxies them to the server-only
  `API_INTERNAL_BASE_URL` (the compose sets `http://api:8080`). That is what lets the
  `admin.`/`kid.localhost` subdomains authenticate — each `*.localhost` is its own
  site, so a direct call to `localhost:8080` would be cross-site and the API's
  `SameSite=Lax` cookies would be dropped. Server-side rendering uses the same origin.
- **provider-proxy** is the released image of
  [`vechemoga-provider-proxy`](https://github.com/simo21-ss/vechemoga-provider-proxy):
  **stock WireMock 3.13.2 plus that repo's mapping JSON**, and nothing else — no custom
  server, no extension, no control plane of our own. One process fronts **both** Loops
  (transactional mail + ESP) and Stripe. Its AWS pipeline pushes `:<sha12>` per commit;
  this stack **pins an exact SHA** (`b52518d089bf`), and you should not change it to
  `latest` — see [Pinning](#pinning-and-why-not-latest) below.

  Drive it through **WireMock's own Admin API** at `http://127.0.0.1:1080/__admin/*`:
  `POST /__admin/mappings` registers a stub, `POST /__admin/requests/find` reads a captured
  send (e.g. a verification link) back out. There is no `/__proxy/*` and no `/__sim/*`.

  It **fails closed**. Anything no mapping claimed is answered `404 no_matching_stub` by a
  lowest-priority catch-all, and the entrypoint runs
  `--deny-proxy-targets 0.0.0.0-255.255.255.255,*` — so no mapping and no webhook can reach
  the internet from here. That is what makes it safe for the API's `local` profile to point
  the *real* Loops and Stripe clients at it: there is no code path from your machine to a
  real inbox or a real charge, online or offline. Live Stripe keys (`sk_live_`/`rk_live_`,
  Bearer or HTTP Basic) are refused `403` before anything can forward them.

  Two consequences worth internalising, both changed from the retired Node proxy:
  - **Unmatched traffic now 404s** rather than being stubbed `200` and journaled. The ESP
    poller's 60s sweep registers no mapping, so it gets 404s. That is intended.
  - **Register the mapping *before* driving the app action.** There is no after-the-fact
    journal read for traffic that matched nothing.

  The port is published on **127.0.0.1 only**, deliberately — see
  [Admin API trust boundary](#admin-api-trust-boundary).

## Working with the provider mock

All of these assume the mock is up (`./run.sh up` or `./run.sh infra`). `$PROXY` is
`http://127.0.0.1:1080` unless you moved `PROXY_PORT`.

### Register a temporary mapping

Register **before** driving the app action — the mock fails closed, so a send with no
mapping is a 404, not a journal entry you can read back later. Always attach `metadata`
so you can dispose of exactly your own mappings afterwards:

```bash
curl -sS -X POST "$PROXY/__admin/mappings" -H 'Content-Type: application/json' -d '{
  "metadata": { "scenarioId": "my-scenario", "provider": "loops" },
  "request":  { "method": "POST", "urlPath": "/api/v1/transactional" },
  "response": { "status": 200, "jsonBody": { "success": true } }
}'
```

### Inspect a captured request

`POST /__admin/requests/find` returns the matching requests. Bodies contain verification
links and tokens, so **extract the one field you need rather than dumping the response** —
a full body in your scrollback (or in CI logs) is a leaked credential:

```bash
# Pull just the verification link out; never echo the whole body.
curl -sS -X POST "$PROXY/__admin/requests/find" -H 'Content-Type: application/json' \
  -d '{ "method": "POST", "urlPath": "/api/v1/transactional" }' \
  | jq -r '.requests[-1].body' | jq -r '.dataVariables.verificationUrl'
```

The container itself never logs bodies: the image runs `--disable-request-logging`, so
`./run.sh logs provider-proxy` cannot leak an Authorization header or a token.

### Clean up only your own mappings

Never call `POST /__admin/reset` or `DELETE /__admin/mappings` — both are global and will
delete the image's own fail-closed catch-all and live-key guards, silently disarming the
safety properties for everyone until the container restarts. Scope the removal by metadata:

```bash
curl -sS -X POST "$PROXY/__admin/mappings/remove-by-metadata" \
  -H 'Content-Type: application/json' \
  -d '{ "matchesJsonPath": { "expression": "$.scenarioId", "equalTo": "my-scenario" } }'
```

### Running fully offline

Works with no special mode: pull the image once (the ECR login in
[Quick start](#quick-start)), and every later `./run.sh up` runs with no network. The mock
needs no upstream and has no egress — `--deny-proxy-targets 0.0.0.0-255.255.255.255,*`
refuses every proxy target and every webhook destination — so unmatched provider traffic
fails closed identically online and offline. There is nothing to switch off before a flight.

### Stripe

Stripe's base URL already points at this same mock, and **live keys are refused `403`** in
every local mode (both `Authorization: Bearer sk_live_…` and the HTTP Basic form Stripe
also accepts). Use a Sandbox/test key.

Sandbox **pass-through is not available yet.** The current image is Loops-scope: it has no
`/v1/*` forwarding mapping and denies all proxy targets, so Stripe calls fail closed at
`404 no_matching_stub` unless you register a mapping for them yourself. When forwarding
lands it will be an explicit opt-in owned by
[`vechemoga-provider-proxy`](https://github.com/simo21-ss/vechemoga-provider-proxy) — a
`/v1/*` mapping plus `--allow-proxy-targets api.stripe.com`, so the only reachable target
is Stripe itself and having credentials in your environment never on its own causes egress.
Until then, drive Stripe state, Checkout and webhooks against Stripe Sandbox directly.

### Troubleshooting

```bash
curl -sS "$PROXY/__admin/health"                 # {"status":"healthy"} — readiness
curl -sS "$PROXY/__admin/mappings" | jq '.meta'  # how many mappings are registered
curl -sS "$PROXY/__admin/requests/unmatched"     # what arrived that nothing claimed
./run.sh logs provider-proxy                     # container-level failures only
```

- **A provider call 404s with `no_matching_stub`.** Expected when no mapping claimed it.
  Check `/__admin/requests/unmatched` — WireMock reports *near misses*, which usually shows
  the mapping matched on method but not on path, or on a body pattern that didn't fit.
- **A call 403s with `live_credentials_refused`.** A live Stripe key reached the mock.
  Swap it for a Sandbox key; the mock will never forward it.
- **The API won't start, waiting on provider-proxy.** `depends_on` gates on the image's own
  healthcheck. `docker compose ps` shows the health state; a container stuck `starting`
  usually means the pinned tag isn't in the local cache and the pull failed — see the ECR
  login in [Quick start](#quick-start).
- **Everything 404s including things that used to work.** Someone called a global reset and
  wiped the built-in mappings, or `PROVIDER_PROXY_TAG` is pointing somewhere unexpected.
  `./run.sh stop && ./run.sh up` restores the image's own mappings.

### Pinning, and why not `latest`

`PROVIDER_PROXY_TAG` defaults to the exact build `b52518d089bf`. **Do not set it to
`latest`.** The proxy pipeline deliberately does not move that tag — it still resolves to
the *retired* Node proxy that served the removed `/__proxy/*` control plane, kept in place
so unmigrated stacks keep working. A stack on `:latest` comes up fine and then fails in
confusing ways. Bump the pin when the proxy repo releases a build you want.

### Admin API trust boundary

The Admin API is **unauthenticated** in this image, and `/__admin/*` can rewrite mappings
and read captured request bodies. Locally that is contained by binding the published port
to loopback (`127.0.0.1:1080:1080` in the compose), so it is reachable from this machine
only and not from the LAN — everything that needs it (the automation suite, `curl`) runs
here, and the API reaches the container over the compose network where the published port
plays no part. Do not change that binding to `0.0.0.0`.

The image does support auth if you ever need it —
`WIREMOCK_OPTIONS=--admin-api-basic-auth <user>:<secret>` — but note it also puts
`/__admin/health` behind auth, which the container's own healthcheck uses. On the dev box
the same port is loopback-bound and Caddy is the authorization boundary instead.

## Notes

- This is **local only**. Production deployment lives in
  [`VecheMogaApi/deploy/`](../VecheMogaApi/deploy/README.md) (API) and Amplify (web).
- Don't run `./run.sh up` (Dockerised app on :8080/:3000) and a host `bootRun` /
  `npm run dev` at the same time — they bind the same ports. Use the `no-api` /
  `no-web` subsets instead.

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
    ├── provider-proxy/          source of the `provider-proxy` service (zero-dependency)
    │   ├── provider-proxy.mjs   proxy-mock for the API's outbound providers (today: email)
    │   └── test/                its contract test (`node --test test/`)
    └── .env.example             optional port/credential/upstream overrides
```

## Prerequisites

- **Docker Desktop** (Compose v2).
- For running the automation suite: **Node 20+** (it runs on the host, not in Docker).

## Quick start

```bash
cd docker
./run.sh up          # build + start postgres + api + web (detached)
```

Then:

| Service | URL |
|---|---|
| Web (parent + public) | http://localhost:3000 |
| Web — admin host | http://admin.localhost:3000 |
| Web — kid host | http://kid.localhost:3000 |
| API | http://localhost:8080 (`/actuator/health`, `/api/ping`) |
| Postgres | `localhost:5432` (db/user/pass: `vechemoga`) |
| Provider proxy ([`provider-proxy/`](provider-proxy/README.md)) | http://localhost:1080 (control plane: `/__proxy/*`) |

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

The suite ([`VecheMogaAutomation`](../VecheMogaAutomation)) runs on the **host** and
targets the published ports. The default stack is already automation-ready — the API's
`local` profile seeds the admin and the provider-proxy captures outgoing email — so there
is no special mode: `./run.sh up` is enough.

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
  `postgres:5432`, admin **seeded** (`admin@vechemoga.bg` / `admin`), ESP/S3 off.
  Liquibase migrates the schema on boot — no SQL seed files to mount. The one thing
  that profile leaves off is transactional email (a bare host run has nowhere to send
  it), so — because this stack *does* run a capture server — the compose turns email
  on via `JAVA_OPTS` `-D` properties: `vechemoga.email.enabled=true` +
  `vechemoga.email.loops.base-url=http://provider-proxy:1080`.
- **Web** runs `next dev` with its committed `env.local` profile (same as
  `npm run dev:compose`). The **browser** calls the API at `localhost:8080` (baked
  into `env.local`); **server-side** rendering calls it at `api:8080` via the
  server-only `API_INTERNAL_BASE_URL` (see `VecheMogaWeb/src/lib/api/base.ts`).
- **provider-proxy** is this repo's own [`provider-proxy/provider-proxy.mjs`](provider-proxy/README.md) —
  a zero-dependency provider proxy-mock, mounted read-only into a `node:20-alpine`
  container (it needs no install). It sits in front of the API's transactional-email
  provider: a client registers an expectation over the control plane at
  `http://localhost:1080/__proxy/*` and reads the captured send (e.g. a verification
  link) back out of `GET /__proxy/requests`. Unmatched mail goes to `PROXY_UPSTREAM_URL`,
  which is **unset by default** so nothing can reach a real inbox — see
  [`.env.example`](.env.example) to opt into forwarding to the real provider.

## Notes

- This is **local only**. Production deployment lives in
  [`VecheMogaApi/deploy/`](../VecheMogaApi/deploy/README.md) (API) and Amplify (web).
- Don't run `./run.sh up` (Dockerised app on :8080/:3000) and a host `bootRun` /
  `npm run dev` at the same time — they bind the same ports. Use the `no-api` /
  `no-web` subsets instead.

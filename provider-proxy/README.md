# Provider proxy-mock

A tiny, dependency-free HTTP server (Node built-ins only) that sits in front of the
outbound providers the VecheMoga API calls — today Loops, for transactional email.

It belongs to the **local stack**, not to any test suite: the compose runs it as the
`provider-proxy` service and it is the API's provider base URL for the whole stack, whether
tests are running or not. Test suites are *clients* — they drive it over the HTTP control
plane below and need nothing from this repo but the port.

```
API ──POST /v1/transactional──▶ proxy ──┬─ expectation matches? ─▶ canned response + recorded
                                        └─ no match?            ─▶ PROXY_UPSTREAM_URL (or 502)
```

## Why it exists

A verification token is only ever stored **hashed** in the DB, so a test that needs to
click a verification link has no way to get the raw token out of the database. It has to
read the email. This proxy captures the outgoing send and lets the test read the link back
out — no mail server, no third-party mock, no app restart, no `application.yml` rewrite.

## Running it

Normally you don't — `../docker/run.sh up` starts it as the `provider-proxy` service on
:1080, and the compose points the API at it via
`-Dvechemoga.email.loops.base-url=http://provider-proxy:1080`.

Standalone on the host (e.g. against an API you run from the IDE):

```bash
node provider-proxy.mjs          # :1080
```

Then start the API with `-Dvechemoga.email.enabled=true
-Dvechemoga.email.loops.base-url=http://localhost:1080`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `1080` | Listen port. In the stack the container keeps this default and `PROXY_PORT` in [`../.env`](../.env.example) remaps the **host** side. |
| `PROXY_UPSTREAM_URL` | *(unset)* | Where **unmatched** traffic is forwarded. Unset ⇒ unmatched requests get a `502` explaining why. |
| `PROXY_JOURNAL_MAX` | `5000` | Safety cap on recorded requests. |

**On `PROXY_UPSTREAM_URL`:** the real provider is `https://app.loops.so/api`, documented
as a commented-out line in [`../.env.example`](../.env.example). It is deliberately **off
by default** in the local stack: an email nobody registered an expectation for is either a
test that forgot to call `expect()` first, or you hand-registering in the browser — and
neither should be able to send real mail to a real inbox. Leaving it unset turns both into
a loud `502` instead. Uncomment it in your `.env` when you specifically want passthrough
(note that real delivery also needs `LOOPS_API_KEY`, which is empty locally, so today a
forwarded send would `401` anyway — don't rely on that as the safety net).

## Control plane

Test-facing, all under `/__proxy`. This is the contract client code is written against —
`VecheMogaAutomation`'s `MailboxClient` is one such client, and
[`test/provider-proxy.contract.mjs`](test/provider-proxy.contract.mjs) pins it.

| Route | Purpose |
|---|---|
| `POST /__proxy/expectations` | Register one. Body `{ method?, path?, bodyMatch?, respond? }` → `201 { id }`. |
| `DELETE /__proxy/expectations/:id` | Remove one, and prune its captures. |
| `DELETE /__proxy/expectations` | Remove all, and clear the journal. |
| `GET /__proxy/requests` | Recorded (matched) requests, newest last. |
| `DELETE /__proxy/requests` | Clear the journal. |
| `GET /__proxy/health` | `{ status, upstream }`. |

`GET /__proxy/requests` takes `?expectationId=` and/or `?bodyPath=&bodyValue=` (dotted
path, case-insensitive compare) to scope reads. **Prefer `expectationId`** — it is what
keeps parallel Cucumber workers from reading each other's mail regardless of whether
recipients happen to be unique.

Only **matched** requests are journaled, so real proxied mail is never recorded.

### Capturing one email

```bash
# 1. Register BEFORE the app sends, or it passes through and nothing is captured.
curl -sX POST localhost:1080/__proxy/expectations \
  -H 'content-type: application/json' \
  -d '{"method":"POST","path":"/v1/transactional","bodyMatch":{"email":"bob@test.local"}}'
# -> {"id":"exp_1"}

# 2. App sends. 3. Read it back, scoped to that id.
curl -s 'localhost:1080/__proxy/requests?expectationId=exp_1'

# 4. Clean up (prunes its captures too).
curl -sX DELETE localhost:1080/__proxy/expectations/exp_1
```

Matching: `method` and `path` (prefix) and every `bodyMatch` dotted-path equality must
hold. The **newest** matching expectation wins, so a re-registration supersedes an older
one. Unspecified fields match anything. `respond` defaults to `200 {"success": true}`,
which is enough for the API's send to succeed.

## Tests

```bash
node --test test/     # no install, no dependencies
```

Spawns the real binary against a fake upstream on ephemeral ports. Covers passthrough,
capture, scoping, cleanup, and 50 concurrent distinct-key scenarios not
cross-contaminating — the property parallel test runs depend on.

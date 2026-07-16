# Provider proxy-mock

A tiny, dependency-free HTTP server (Node built-ins only) that sits in front of the
outbound providers the VecheMoga API calls — today Loops, for transactional email.

It belongs to the **local stack**, not to any test suite: the compose runs it as the
`provider-proxy` service and it is the API's provider base URL for the whole stack, whether
tests are running or not. Test suites are *clients* — they drive it over the HTTP control
plane below and need nothing from this repo but the port.

```
API ──POST /v1/transactional──▶ proxy ──┬─ an expectation matches?  ─▶ its canned response + recorded
                                        ├─ PROXY_UPSTREAM_URL set?  ─▶ the real provider's response
                                        └─ otherwise                ─▶ stubbed 200 + recorded
```

## Why it exists

Two reasons, and the second is why it runs even when no test does.

**Tests need to read the mail.** A verification token is only ever stored **hashed** in the
DB, so a test that needs to click a verification link cannot get the raw token out of the
database. It has to read the email. This proxy captures the outgoing send and lets the test
read the link back out — no mail server, no third-party mock, no app restart, no
`application.yml` rewrite.

**Off-prod has to exercise the real provider code path without reaching the provider.** The
alternative — a no-op implementation swapped in by a flag — exercises nothing: no HTTP, no
serialization, no error handling, and the first time any of that runs for real is in
production. So off-prod points the *real* Loops clients at this proxy and the whole pipeline
runs for real, with the proxy absorbing the call at the last hop. That is what unmatched
stubbing is for: a caller that registered no expectation (the ESP poller sweeping every
contact every 60s) gets a plain success rather than an error it would retry into
abandonment.

## Running it

Normally you don't — `../docker/run.sh up` starts it as the `provider-proxy` service on
:1080, and the API's `local` profile already points both of its Loops base-urls at
`http://provider-proxy:1080`.

Standalone on the host (e.g. against an API you run from the IDE):

```bash
node provider-proxy.mjs          # :1080
```

The API's `local-ide` profile already points at `http://localhost:1080` for exactly this.

There is also a [`Dockerfile`](Dockerfile) for building a deployable image. The local stack
does **not** use it (the compose bind-mounts the script into a stock node image instead); it
exists so the proxy can be run where this repo's source isn't checked out.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `1080` | Listen port. In the stack the container keeps this default and `PROXY_PORT` in [`../.env`](../.env.example) remaps the **host** side. |
| `PROXY_UPSTREAM_URL` | *(unset)* | Where **unmatched** traffic is forwarded. Unset ⇒ unmatched is stubbed `200 {"success":true}` and recorded, and nothing leaves the machine. |
| `PROXY_JOURNAL_MAX` | `5000` | Ring-buffer bound on recorded requests; past it, the oldest are dropped. |

**On `PROXY_UPSTREAM_URL`:** the real provider is `https://app.loops.so/api`, documented as
a commented-out line in [`../.env.example`](../.env.example). It is deliberately **off by
default**, and unset is the whole safety property: with no upstream there is no code path
from here to a real inbox, whatever the API sends. Set it only when you specifically want
passthrough. `LOOPS_API_KEY` is **not** a second line of defence — off-prod now sets a dummy
one so the ESP client can start at all, so a forwarded send would `401` rather than deliver,
but that is a happy accident of the key being fake, not a guarantee.

**On `PROXY_JOURNAL_MAX`:** stubbed captures are tagged with no expectation id, so
`DELETE /__proxy/expectations/:id` cannot prune them — a long-running stack's poller appends
to the journal with no client disposing anything. This cap and `DELETE /__proxy/requests` are
their only bounds. The cap is enforced on every append, so the journal is a ring buffer of
the most recent `PROXY_JOURNAL_MAX` requests rather than something a tidy client has to
maintain.

## Control plane

Test-facing, all under `/__proxy`. This is the contract client code is written against —
`VecheMogaAutomation`'s `MailboxClient` is one such client, and
[`test/provider-proxy.contract.mjs`](test/provider-proxy.contract.mjs) pins it.

| Route | Purpose |
|---|---|
| `POST /__proxy/expectations` | Register one. Body `{ method?, path?, bodyMatch?, respond? }` → `201 { id }`. |
| `DELETE /__proxy/expectations/:id` | Remove one, and prune **its** captures (never a stubbed one — those carry no id). |
| `DELETE /__proxy/expectations` | Remove all, and clear the journal. |
| `GET /__proxy/requests` | Recorded requests, newest last. Each carries `matchedExpectationId`, `null` if it was stubbed. |
| `DELETE /__proxy/requests` | Clear the journal. |
| `GET /__proxy/health` | `{ status, upstream }`. |

`GET /__proxy/requests` takes `?expectationId=` and/or `?bodyPath=&bodyValue=` (dotted
path, case-insensitive compare) to scope reads. **Prefer `expectationId`** — it is what
keeps parallel Cucumber workers from reading each other's mail regardless of whether
recipients happen to be unique. `bodyPath` and `bodyValue` are one filter and must be sent
together; either one alone is a `400` rather than a misleading empty result.

Requests are journaled **except** when they are proxied to an upstream — a forwarded request
is a real user's, not a capture. So with no upstream (the off-prod default) everything the
API sends is readable back out.

### Capturing one email

An expectation is only needed to *scope* a read (and to give a canned response other than
the stub). Registering one before the send is still the right default for a parallel suite,
because `expectationId` is the only filter that can't collide:

```bash
# 1. Register before the app sends.
curl -sX POST localhost:1080/__proxy/expectations \
  -H 'content-type: application/json' \
  -d '{"method":"POST","path":"/v1/transactional","bodyMatch":{"email":"bob@test.local"}}'
# -> {"id":"exp_1"}

# 2. App sends. 3. Read it back, scoped to that id.
curl -s 'localhost:1080/__proxy/requests?expectationId=exp_1'

# 4. Clean up (prunes its captures too).
curl -sX DELETE localhost:1080/__proxy/expectations/exp_1
```

Forgetting step 1 is no longer fatal, though: with no upstream the send is stubbed **and
journaled**, so it is still readable after the fact by body field — which is what makes
"register the expectation before triggering the flow" a preference rather than a footgun.

```bash
# The app already sent. Find it anyway.
curl -s 'localhost:1080/__proxy/requests?bodyPath=email&bodyValue=bob@test.local'
```

Matching: `method` and `path` (prefix) and every `bodyMatch` dotted-path equality must
hold. The **newest** matching expectation wins, so a re-registration supersedes an older
one. Unspecified fields match anything. `respond` defaults to `200 {"success": true}`,
which is enough for the API's send to succeed.

## Tests

```bash
node --test test/     # no install, no dependencies
```

Spawns the real binary on ephemeral ports, in both modes: one instance with a fake upstream
(so passthrough is proven without sending real email) and one without (the off-prod shape).
Covers passthrough, capture, scoping, cleanup, unmatched stubbing and its journal cap, and
50 concurrent distinct-key scenarios not cross-contaminating — the property parallel test
runs depend on.

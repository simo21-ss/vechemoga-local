// Contract + concurrency regression test for the provider proxy-mock.
//
// Exercises the REAL binary (../provider-proxy.mjs) over the REAL control plane, which is
// the only surface test suites depend on — so this pins the contract VecheMogaAutomation's
// MailboxClient (and any future client) is written against. A fake upstream stands in for
// the real provider, so passthrough is proven without sending real email.
//
// Two instances, because PROXY_UPSTREAM_URL is read once at startup and the two modes are
// genuinely different contracts:
//   - the main proxy, WITH an upstream → unmatched is forwarded (opt-in passthrough);
//   - the stub proxy, WITHOUT one → unmatched is stubbed + journaled. This is the off-prod
//     shape, the one the real Loops clients point at.
//
// The property that matters most for parallel Cucumber runs: concurrent scenarios with
// DISTINCT unique keys never cross-contaminate.
//
// Run:  node --test test/        (from provider-proxy/; no dependencies, no install)

import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const MAIL_PROXY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Ports are allocated dynamically (ephemeral) so a leftover proxy or a parallel run
// can't collide on a fixed port or make the health gate false-green against a stranger.
let PROXY_URL = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2);

/** Grab a free ephemeral port from the OS. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let upstream;
const upstreamHits = [];
/** Every proxy child spawned, so after() can reap them all. */
const spawned = [];

/** Simulate the API POSTing a transactional email to its (proxied) provider base URL. */
function appSends(email, token, base = PROXY_URL) {
  return fetch(`${base}/v1/transactional`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      dataVariables: { actionButtonUrl: `https://web.vechemoga.local/verify?token=${token}` },
    }),
  });
}

// ---- Control-plane client -------------------------------------------------
// The same calls MailboxClient makes, inlined so this repo owns no test-suite code.

/** Register an expectation keyed on the recipient; returns its id. */
async function expectMail(email, base = PROXY_URL) {
  const res = await fetch(`${base}/__proxy/expectations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "POST", path: "/v1/transactional", bodyMatch: { email } }),
  });
  assert.equal(res.status, 201, `registering an expectation for ${email} should return 201`);
  return (await res.json()).id;
}

async function clearExpectation(id, base = PROXY_URL) {
  await fetch(`${base}/__proxy/expectations/${id}`, { method: "DELETE" });
}

async function journalByExpectation(id, base = PROXY_URL) {
  const res = await fetch(`${base}/__proxy/requests?expectationId=${encodeURIComponent(id)}`);
  return res.json();
}

/** Read the journal by a body field — the only way to find a stubbed capture, which has
 *  no expectation id to scope by. */
async function journalByBody(bodyPath, bodyValue, base = PROXY_URL) {
  const res = await fetch(
    `${base}/__proxy/requests?bodyPath=${encodeURIComponent(bodyPath)}&bodyValue=${encodeURIComponent(bodyValue)}`
  );
  assert.equal(res.status, 200);
  return res.json();
}

const tokenOf = (entry) =>
  new URL(entry.body?.dataVariables?.actionButtonUrl ?? "https://x/").searchParams.get("token");

/** Poll an expectation's captures until the verification token shows up. */
async function waitForToken(id, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await journalByExpectation(id);
    // newest last — scan in reverse so a re-registration's fresh token wins
    for (let i = entries.length - 1; i >= 0; i--) {
      const token = tokenOf(entries[i]);
      if (token) return token;
    }
    await sleep(100);
  }
  throw new Error(`no capture for expectation ${id} within ${timeoutMs}ms`);
}

// ---- Boot -----------------------------------------------------------------
// Boot exactly once, and gate every test on it — an explicit awaited guard is race-free,
// unlike relying on top-level hook ordering under the auto-run test runner.
let booted;
function ensureUp() {
  if (!booted) booted = boot();
  return booted;
}

/** Spawn one proxy child on a free port and wait for it to answer /__proxy/health.
 *  `env` is the ONLY source of the proxy's own config: the inherited environment is
 *  scrubbed of both proxy vars first, so a developer's exported PROXY_UPSTREAM_URL can't
 *  quietly turn the stub-mode instance into a passthrough one and pass these tests. */
async function spawnProxy(env = {}) {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const childEnv = { ...process.env, PROXY_PORT: String(port) };
  delete childEnv.PROXY_UPSTREAM_URL;
  delete childEnv.PROXY_JOURNAL_MAX;
  Object.assign(childEnv, env);

  const child = spawn("node", ["provider-proxy.mjs"], {
    cwd: MAIL_PROXY_DIR,
    env: childEnv,
    stdio: "ignore",
  });
  spawned.push(child);
  let spawnErr;
  child.on("error", (e) => {
    spawnErr = e; // record, don't throw in an emitter — surface it below so the caller rejects cleanly
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnErr) throw spawnErr;
    if (child.exitCode !== null) throw new Error(`proxy exited early with code ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/__proxy/health`)).ok) return url; // our child is listening -> stays up
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("proxy did not become healthy");
}

async function boot() {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        upstreamHits.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        upstreamHits.push({});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: "real-provider-upstream" }));
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, resolve);
  });
  const upstreamUrl = `http://localhost:${upstream.address().port}`;

  PROXY_URL = await spawnProxy({ PROXY_UPSTREAM_URL: upstreamUrl });
}

// The stub-mode instance: no upstream, so unmatched traffic is stubbed + journaled. Booted
// on demand and separately from the main one, and given its own journal, so these
// assertions never race the passthrough tests' traffic.
let stubBooted;
let STUB_URL = "";
function ensureStubUp() {
  if (!stubBooted) stubBooted = spawnProxy().then((url) => (STUB_URL = url));
  return stubBooted;
}

after(() => {
  for (const child of spawned) child.kill();
  upstream?.close();
});

// ---- Tests ----------------------------------------------------------------

test("expectation set -> mocked locally + captured, real provider untouched", async () => {
  await ensureUp();
  const email = `case.a+${rand()}@test.local`;
  const id = await expectMail(email);
  const res = await appSends(email, "token-AAA");
  const body = await res.json();

  assert.equal(res.status, 200, "app send should get the canned 200");
  assert.equal(body.success, true, "response is the stub, not the upstream");
  assert.equal(body.from, undefined, "must not be the upstream's response");
  assert.equal(upstreamHits.find((h) => h.email === email), undefined, "real provider must not receive it");
  assert.equal(await waitForToken(id), "token-AAA");
  await clearExpectation(id);
});

test("no expectation -> transparently proxied to the real provider, not journaled", async () => {
  await ensureUp();
  const email = `case.b+${rand()}@test.local`;
  const before = upstreamHits.length;
  const res = await appSends(email, "token-BBB");
  const body = await res.json();

  assert.equal(body.from, "real-provider-upstream", "proxy should return the upstream response");
  assert.equal(upstreamHits.length, before + 1, "upstream should receive exactly one");
  assert.ok(upstreamHits.some((h) => h.email === email));

  const journal = await (
    await fetch(`${PROXY_URL}/__proxy/requests?bodyPath=email&bodyValue=${encodeURIComponent(email)}`)
  ).json();
  assert.equal(journal.length, 0, "passthrough must not be recorded");
});

test("cleared expectation -> that recipient falls back to passthrough", async () => {
  await ensureUp();
  const email = `case.c+${rand()}@test.local`;
  const id = await expectMail(email);
  await appSends(email, "token-C1");
  assert.equal(await waitForToken(id), "token-C1");

  await clearExpectation(id);
  const before = upstreamHits.length;
  await appSends(email, "token-C2");
  assert.equal(upstreamHits.length, before + 1, "after clearing it should proxy to upstream");
});

test("50 concurrent DISTINCT-key scenarios never cross-contaminate", async () => {
  await ensureUp();
  const N = 50;
  const jitter = () => sleep(Math.floor(Math.random() * 10));

  const scenario = async (i) => {
    const email = `load.${i}+${rand()}@test.local`;
    const token = `tok-${i}-${rand()}`;
    const id = await expectMail(email);
    await jitter();
    await appSends(email, token); // interleaves with every other scenario's send
    await jitter();
    const got = await waitForToken(id);
    await clearExpectation(id);
    return { i, ok: got === token, got, token };
  };

  // Contend the same event loop with interleaved real passthrough traffic too.
  const noise = Array.from({ length: 20 }, (_, i) => appSends(`noise.${i}+${rand()}@test.local`, `n-${i}`));
  const [results] = await Promise.all([
    Promise.all(Array.from({ length: N }, (_, i) => scenario(i))),
    Promise.all(noise),
  ]);

  const wrong = results.filter((r) => !r.ok);
  assert.equal(wrong.length, 0, `every scenario must read exactly its own token; wrong: ${JSON.stringify(wrong)}`);
});

// Prove the READ is scoped by expectation id specifically (not "email happened to be unique").
// A read keyed on an id returns only that id's capture, and an id with no matching send returns
// empty even though the shared journal holds other entries.
test("reads are scoped by expectation id, not by luck", async () => {
  await ensureUp();
  const emailX = `idscope.x+${rand()}@test.local`;
  const emailY = `idscope.y+${rand()}@test.local`;
  const idX = await expectMail(emailX);
  const idY = await expectMail(emailY);
  const idZ = await expectMail(`idscope.z+${rand()}@test.local`); // never sent to

  await appSends(emailX, "tok-X");
  await appSends(emailY, "tok-Y");

  const byX = await journalByExpectation(idX);
  const byY = await journalByExpectation(idY);
  const byZ = await journalByExpectation(idZ);
  assert.deepEqual(byX.map(tokenOf), ["tok-X"], "id X read must return only X's capture");
  assert.deepEqual(byY.map(tokenOf), ["tok-Y"], "id Y read must return only Y's capture");
  assert.equal(byZ.length, 0, "an id with no matching send is empty though the journal holds 2 entries");

  for (const id of [idX, idY, idZ]) await clearExpectation(id);
});

// Exercise the newest-registered-wins tie-break.
test("re-registration supersedes: the newest expectation's token is what's read", async () => {
  await ensureUp();
  const email = `rereg+${rand()}@test.local`;
  const idOld = await expectMail(email);
  const idNew = await expectMail(email); // registered after idOld -> should win

  await appSends(email, "tok-NEW");
  assert.equal(await waitForToken(idNew), "tok-NEW", "the newest matching expectation must capture the send");
  assert.equal((await journalByExpectation(idOld)).length, 0, "the superseded expectation must capture nothing");

  await clearExpectation(idNew);
  await clearExpectation(idOld);
});

// bodyPath and bodyValue are one filter. Half of it used to compare every entry against
// undefined and return [], which a caller reads as "nothing captured" and polls to a timeout.
test("bodyPath without bodyValue is rejected, not silently empty", async () => {
  await ensureUp();
  const email = `halffilter+${rand()}@test.local`;
  const id = await expectMail(email);
  await appSends(email, "tok-HALF");
  await waitForToken(id); // the entry is definitely in the journal

  for (const query of [`bodyPath=email`, `bodyValue=${encodeURIComponent(email)}`]) {
    const res = await fetch(`${PROXY_URL}/__proxy/requests?${query}`);
    assert.equal(res.status, 400, `${query} alone must 400, not return a misleading []`);
    assert.match((await res.json()).error, /together/);
  }

  // The complete filter still works, so the guard didn't break the real path.
  const ok = await fetch(`${PROXY_URL}/__proxy/requests?bodyPath=email&bodyValue=${encodeURIComponent(email)}`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).length, 1);

  await clearExpectation(id);
});

test("journal is pruned back to empty once expectations are cleared", async () => {
  await ensureUp();
  const leftover = await (await fetch(`${PROXY_URL}/__proxy/requests`)).json();
  assert.equal(leftover.length, 0, "clearing expectations must prune their captures (bounded growth)");
});

test("clearing all expectations resets both planes", async () => {
  await ensureUp();
  const email = `reset+${rand()}@test.local`;
  const id = await expectMail(email);
  await appSends(email, "tok-RESET");
  await waitForToken(id);

  const res = await fetch(`${PROXY_URL}/__proxy/expectations`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cleared: true });
  assert.equal((await (await fetch(`${PROXY_URL}/__proxy/requests`)).json()).length, 0, "journal cleared too");

  // With its expectation gone, the same recipient now passes through.
  const before = upstreamHits.length;
  await appSends(email, "tok-AFTER-RESET");
  assert.equal(upstreamHits.length, before + 1, "cleared expectation must not keep matching");
});

// ---- Stub mode: no upstream ------------------------------------------------
// The off-prod contract. The real Loops clients point here, so an unmatched request is
// every send nobody registered an expectation for — including the ESP poller sweeping
// every contact every 60s. It must succeed and be recorded, never fail and never leave.

test("no upstream: unmatched is stubbed 200, not a 502", async () => {
  await ensureStubUp();
  const res = await appSends(`stub.a+${rand()}@test.local`, "tok-STUB", STUB_URL);

  assert.equal(res.status, 200, "an unmatched send must succeed — a 502 makes the ESP poller retry to abandonment");
  assert.deepEqual(await res.json(), { success: true }, "the stub body is what the provider clients expect");
});

// Retires the expect()-before-send footgun: the send happens first, with nothing
// registered, and is still readable afterwards.
test("no upstream: unmatched is journaled and readable by bodyPath after the fact", async () => {
  await ensureStubUp();
  const email = `stub.b+${rand()}@test.local`;
  await appSends(email, "tok-AFTER-THE-FACT", STUB_URL);

  const entries = await journalByBody("email", email, STUB_URL);
  assert.equal(entries.length, 1, "the unmatched send must be recorded even with no expectation registered");
  assert.equal(tokenOf(entries[0]), "tok-AFTER-THE-FACT", "and its body must be readable back out");
  assert.equal(entries[0].matchedExpectationId, null, "nothing claimed it, so it carries no expectation id");
});

test("no upstream: unmatched never reaches the real provider", async () => {
  await ensureStubUp();
  const email = `stub.c+${rand()}@test.local`;
  const before = upstreamHits.length;
  const body = await (await appSends(email, "tok-NO-LEAK", STUB_URL)).json();

  assert.equal(upstreamHits.length, before, "with no upstream configured, nothing may leave");
  assert.equal(body.from, undefined, "the response is the stub, not a provider's");
  assert.equal(upstreamHits.find((h) => h.email === email), undefined, "the recipient must never be seen upstream");
});

test("no upstream: an expectation still wins over the stub", async () => {
  await ensureStubUp();
  const email = `stub.d+${rand()}@test.local`;
  const id = await expectMail(email, STUB_URL);
  await appSends(email, "tok-EXPECTED", STUB_URL);

  const entries = await journalByExpectation(id, STUB_URL);
  assert.equal(entries.length, 1, "a matched send is claimed by its expectation, not stubbed");
  assert.equal(tokenOf(entries[0]), "tok-EXPECTED");
  assert.equal(entries[0].matchedExpectationId, id, "and is tagged, so a parallel suite can scope to it");

  await clearExpectation(id, STUB_URL);
});

// Stubbed entries have no expectation id, so disposal can't prune them. DELETE
// /__proxy/requests is their reset — worth pinning, since it and PROXY_JOURNAL_MAX are
// the only two things bounding them.
test("no upstream: stubbed captures survive expectation disposal, and DELETE /requests is their reset", async () => {
  await ensureStubUp();
  const email = `stub.e+${rand()}@test.local`;
  const id = await expectMail(`stub.e.other+${rand()}@test.local`, STUB_URL);
  await appSends(email, "tok-UNPRUNABLE", STUB_URL); // unmatched: that expectation keys on another recipient

  await clearExpectation(id, STUB_URL);
  assert.equal(
    (await journalByBody("email", email, STUB_URL)).length,
    1,
    "disposing an expectation must not prune a capture it never claimed"
  );

  const res = await fetch(`${STUB_URL}/__proxy/requests`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal((await (await fetch(`${STUB_URL}/__proxy/requests`)).json()).length, 0, "DELETE /requests clears them");
});

// PROXY_JOURNAL_MAX is the standing bound on stubbed traffic: a stack left running
// appends one entry per poll forever with no client to dispose anything.
test("no upstream: the journal cap holds under an unmatched flood, keeping the newest", async () => {
  const url = await spawnProxy({ PROXY_JOURNAL_MAX: "10" });
  // Sequential, so "the newest 10" is a deterministic claim rather than a race.
  for (let i = 0; i < 25; i++) await appSends(`flood.${i}@test.local`, `tok-${i}`, url);

  const entries = await (await fetch(`${url}/__proxy/requests`)).json();
  assert.equal(entries.length, 10, "the cap must hold — an unbounded journal is a leak in a long-running stack");
  assert.deepEqual(
    entries.map(tokenOf),
    Array.from({ length: 10 }, (_, i) => `tok-${i + 15}`),
    "it is a ring buffer: the oldest are dropped and the newest 10 survive, in order"
  );
});

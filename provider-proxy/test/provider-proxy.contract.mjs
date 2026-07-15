// Contract + concurrency regression test for the provider proxy-mock.
//
// Exercises the REAL binary (../provider-proxy.mjs) over the REAL control plane, which is
// the only surface test suites depend on — so this pins the contract VecheMogaAutomation's
// MailboxClient (and any future client) is written against. A fake upstream stands in for
// the real provider, so passthrough is proven without sending real email.
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

let proxy;
let upstream;
const upstreamHits = [];

/** Simulate the API POSTing a transactional email to its (proxied) provider base URL. */
function appSends(email, token) {
  return fetch(`${PROXY_URL}/v1/transactional`, {
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
async function expectMail(email) {
  const res = await fetch(`${PROXY_URL}/__proxy/expectations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "POST", path: "/v1/transactional", bodyMatch: { email } }),
  });
  assert.equal(res.status, 201, `registering an expectation for ${email} should return 201`);
  return (await res.json()).id;
}

async function clearExpectation(id) {
  await fetch(`${PROXY_URL}/__proxy/expectations/${id}`, { method: "DELETE" });
}

async function journalByExpectation(id) {
  const res = await fetch(`${PROXY_URL}/__proxy/requests?expectationId=${encodeURIComponent(id)}`);
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

  const proxyPort = await freePort();
  PROXY_URL = `http://localhost:${proxyPort}`;
  proxy = spawn("node", ["provider-proxy.mjs"], {
    cwd: MAIL_PROXY_DIR,
    env: { ...process.env, PROXY_PORT: String(proxyPort), PROXY_UPSTREAM_URL: upstreamUrl },
    stdio: "ignore",
  });
  let spawnErr;
  proxy.on("error", (e) => {
    spawnErr = e; // record, don't throw in an emitter — surface it below so boot() rejects cleanly
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnErr) throw spawnErr;
    if (proxy.exitCode !== null) throw new Error(`proxy exited early with code ${proxy.exitCode}`);
    try {
      if ((await fetch(`${PROXY_URL}/__proxy/health`)).ok) return; // our child is listening -> stays up
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("proxy did not become healthy");
}

after(() => {
  proxy?.kill();
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

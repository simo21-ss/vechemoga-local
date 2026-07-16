---
description: Thin triage + approved-fix-plan layer over the built-in /code-review. Delegates the actual reviewing to /code-review (no posting, no auto-fix), then you confirm which findings are proper and it produces a fix plan for your approval.
argument-hint: "[low|medium|high|max] [<PR number>]   (default: high, current branch)"
allowed-tools: Skill, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Read, Grep, Glob
---

# /pr-code-review

A thin layer over the built-in **`/code-review`**. It lets `/code-review` do the actual reviewing (it's deeper and Anthropic-maintained), then adds the workflow you want on top:

1. **You confirm which findings are proper** (per-finding Yes / No / Edit).
2. The confirmed findings become a **fix plan you approve**.

It **never posts to GitHub** and never auto-applies fixes.

## Invocation

Raw input is `$ARGUMENTS`. Extract, in any order:

- An **effort** token — `low` | `medium` | `high` | `max`. Default `high`.
- An optional **PR number** (`^\d+$`) — passed through to `/code-review`. No PR number → the current branch / worktree diff.
- Any other token → refuse with `Usage: /pr-code-review [low|medium|high|max] [<PR number>]`.

`ultra` is **not** run by this command — it's a billed, user-triggered cloud review. For ultra depth, run `/code-review ultra [<PR#>]` yourself first, then invoke `/pr-code-review` and it will triage those existing findings (see *Using an existing review*).

## Phase 1 — generate findings via `/code-review`

Invoke the built-in **`code-review`** skill (via the Skill tool) at the chosen effort, **without `--comment` and without `--fix`** — we want only its findings, not posting or auto-applying:

- current branch → `code-review <effort>`
- a PR → `code-review <effort> <PR number>`

Let it run to completion and produce its findings in the conversation. Treat each reported finding (file, line, severity, description) as a **candidate** for triage. Do not let it post comments or modify files.

If `/code-review` reports nothing → print `No issues found by /code-review.` and stop.

### Using an existing review

If the conversation **already** contains a fresh `/code-review` result (e.g. you just ran `/code-review ultra`), skip Phase 1 and triage those findings directly instead of running a new review.

## Phase 2 — confirm which findings are proper

For each candidate finding, in order, call `AskUserQuestion`:

- `question`:
  ```
  [<severity>] <path>:<line>

  <finding description>

  Is this a proper finding?
  ```
  (omit `:line` for a change-level finding)
- `header`: `Finding <i>/<N>`
- `options`:
  - `{ label: "Yes — valid", description: "Keep it; goes into the fix plan" }`
  - `{ label: "No — drop", description: "Not a real issue; discard" }`
  - `{ label: "Edit", description: "Refine the finding before keeping it" }`

**Yes** → push onto `CONFIRMED`. **No** → drop. **Edit** → follow-up `AskUserQuestion` whose `Other` free-text field holds the rewrite (`Cancel` → drop), then keep. A full cancel maps all remaining findings to dropped.

When judging a finding, weigh it against the repo's conventions — [CLAUDE.md](../../CLAUDE.md) and [README.md](../../README.md) are the source of truth (this repo has no `.claude/skills/`; the sibling app repos do; the proxy's control-plane contract is documented in the `vechemoga-provider-proxy` repo). Don't keep a finding that contradicts an established convention here. **Deliberate choices a general reviewer tends to flag wrongly:**

- **`PROXY_UPSTREAM_URL` unset by default** — unmatched provider traffic is stubbed `200 {"success":true}` on purpose, so it can never reach a real inbox: with no upstream there is no code path from here to the provider at all. "The proxy has no upstream configured" is the intended state, not a gap, and it is what lets the API's *real* Loops clients point here off-prod. Conversely, *do* keep a finding that would make real mail reachable by default, or that leans on the dummy `LOOPS_API_KEY` as the safety net (it only turns a leaked send into a 401).
- **Unmatched traffic is journaled too** — deliberate, not a leak: it is what lets a suite read a send back by `bodyPath` after the fact instead of having to `expect()` first. Those entries carry `matchedExpectationId: null`, so disposing an expectation cannot prune them, and `PROXY_JOURNAL_MAX` (a ring buffer) plus `DELETE /__proxy/requests` are knowingly their only bounds.
- **The provider-proxy is a pulled release image, not source here** — it comes from ECR, published by the `vechemoga-provider-proxy` repo's pipeline. Don't keep "vendor the script / build the proxy locally / add a healthcheck block for it" (the image ships its own `HEALTHCHECK`). Do keep a finding that would change proxy *behaviour* from this repo — that change belongs in the proxy repo.
- **The compose sets only `SPRING_PROFILES_ACTIVE` for the API** — provider config (both Loops base-urls, the flags, the dummy key) lives in the API's `local` / `local-ide` profiles, so one file describes the stack. Even `JAVA_OPTS` is the API image's own. Don't keep "move the provider config into the compose". If an override ever *is* needed here, it must use the **`-D` form, not env vars**: relaxed binding mangles `base-url` into `..._BASEURL` silently.
- **The web healthcheck accepting any HTTP status** — the apex homepage 500s until a CMS page exists, so a status-strict probe would wrongly mark the app down.
- **No Dockerfiles here at all** — the app Dockerfiles live in the app repos, the proxy's in `vechemoga-provider-proxy`; this repo only composes released/built images.
- **Cross-repo build contexts** (`../../VecheMogaApi`, `../../VecheMogaWeb`) and the required side-by-side layout — by design.

Do keep findings about things that silently break a developer: a compose/`run.sh` mismatch (a probe or printed URL that disagrees with the published port), a bind mount whose source doesn't exist (Docker silently creates an empty directory and the container serves stale code), a service rename that orphans a container still holding a port, or docs that contradict the stack.

## Phase 3 — fix plan + approval

If `CONFIRMED` is empty → print `No findings confirmed; nothing to plan.` and stop.

1. **Build the plan.** Turn every confirmed finding into an actionable, ordered fix plan:
   - Group by file / area; within a group order `blocker`/high → `issue` → `nit`.
   - Each step states **what to change, where (`path:line`), and why** (one line), with the concrete approach — and the convention it restores when relevant.
   - Call out ordering / dependencies, and any single change that resolves several findings at once.
   - Flag any fix that also needs a **docs update** ([README.md](../../README.md), [.env.example](../../.env.example)) or a **companion PR in a sibling repo** — `VecheMogaAutomation` codes against the stack's published ports and the proxy's `/__proxy/*` contract (owned by `vechemoga-provider-proxy`), so a change to the compose or `run.sh` can break it.
   - Note when a fix changes something a running stack holds: a service name, a published port, or the API's provider base URL.
2. **Present** the plan as a clear numbered list in plain text (not a code block).
3. **Get approval** via `AskUserQuestion`:
   - `question`: `Approve this fix plan for <N> findings?`
   - `header`: `Approve plan`
   - `options`:
     - `{ label: "Approve", description: "Plan is good" }`
     - `{ label: "Revise", description: "I'll say what to change in the plan" }`
     - `{ label: "Cancel", description: "Discard the plan; change nothing" }`
   - **Revise** → take free-text feedback, adjust, re-present, re-ask (cap 2 rounds). **Cancel** → stop; nothing changes.
4. **On Approve** → restate the final approved plan once, then ask via `AskUserQuestion`: `Implement the approved plan now?` → `{ label: "Yes, implement" }` / `{ label: "No, just leave the plan" }`.
   - **Yes** → implement the fixes following the plan and the repo conventions ([CLAUDE.md](../../CLAUDE.md)). Edits touch the working tree only. After, run `docker compose -f docker/docker-compose.yml config -q` and `bash -n docker/run.sh` as applicable — and for anything touching the compose or `run.sh`, **verify behaviourally**: `./run.sh up` and a mailbox scenario from `VecheMogaAutomation` actually capturing a token. Static checks alone don't prove this stack works.
   - **No** → stop; the approved plan is the deliverable.

## Guardrails

- **This is only a triage + plan layer.** All review generation is delegated to `/code-review`; this command does not maintain its own review checklist (the docs above supply the *conventions* to weigh findings against, not a parallel review pass).
- **Never pass `--comment` or `--fix` to `/code-review`.** No PR comments, no auto-applied fixes from the review step.
- **Never post to GitHub** and **never commit or push.** Even after approval, implementation edits the working tree only — committing/pushing is a separate, explicit step.
- **Don't auto-launch `ultra`** (billed, user-triggered). Use low/medium/high/max, or triage a review the user ran themselves.
- **Explicit triage.** Every finding needs an explicit Yes / No / Edit — never bulk-accept on the user's behalf.
- **Plan needs approval.** No implementation happens until you approve the plan and opt to implement.

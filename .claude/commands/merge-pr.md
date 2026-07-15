---
description: Merge this branch's PR — rebases by default, deletes the branch, then cleans up local refs
argument-hint: "[pr-number]"
---

Merge a GitHub pull request for the **vechemoga-local** repository. This command is self-contained
(adapted from the sibling VecheMogaApi/VecheMogaWeb `/merge-pr`). Two steps there don't apply here and are
intentionally omitted: the **base-branch guard** (their default branch is `prod`, so a PR can silently target
it — this repo's default is `main` and there is no `dev`/`prod` split), and the Confluence **`/update-docs`**
step (no business docs are driven from this repo).

**Target PR:** `$ARGUMENTS` — if empty, resolve it from the current branch with
`gh pr view --json number,title,headRefName,baseRefName,state`.

Steps:

1. Confirm the target PR (number + title). If no open PR exists for the branch, say so and stop — do not guess.
2. **Check for a companion PR before merging.** This repo is the hub: the compose builds from
   `../../VecheMogaApi` and `../../VecheMogaWeb`, and `VecheMogaAutomation`'s CI checks *this* repo out to run
   the provider proxy-mock against the `/__proxy/*` contract. If the PR touches
   `provider-proxy/`, `docker/docker-compose.yml` or `docker/run.sh`, ask whether a sibling PR has to land with
   it (`gh pr list --repo simo21-ss/vechemoga-automation` to check). Merging one side alone can leave the
   other's pipeline red. If there is a companion, merge this one **first** — the sibling depends on this repo's
   contents, not the reverse — then tell the user to land the other.
3. **Rebase by default — don't ask.** Use `--rebase` unless the user explicitly names a different strategy
   (squash / merge-commit) for this PR.
4. Merge with that strategy and delete the source branch (rebase by default):
   `gh pr merge <n> --rebase --delete-branch`  (or `--squash` / `--merge` if the user asked)
5. If `gh` fails local cleanup with `'main' is already used by worktree`, the GitHub merge still succeeded but
   **both branches are left behind**. Verify with `gh pr view <n> --json state` (→ `MERGED`) and delete the
   remote branch with `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`.
6. **Local cleanup, phase 1 (do it now).** Drop the stale remote-tracking ref and resolve the primary checkout
   for phase 2:
   `git fetch --prune`
   `echo "main checkout: $(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`
   The local PR branch can't be deleted from inside its own worktree, so defer it to phase 2.
7. Report the merge commit and confirm the remote branch is gone. If the merge changed a service name, a
   published port, or the API's provider base URL, remind the user that a **stack still running from the old
   revision needs `./run.sh up`** to pick it up (every `up` passes `--remove-orphans`, which clears a container
   left behind by a renamed service). Then give the user **phase 2**: Archive the worktree session in the Claude
   Code UI, then from the main checkout printed above run
   `git worktree prune && git branch -D <branch> && git pull --ff-only` (skip `branch -D` if `--delete-branch`
   already removed the local branch).

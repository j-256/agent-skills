---
name: fork-and-pr
description: Walk a contributor through forking a GitHub repo they don't own, branching, committing, and opening a PR back to upstream – using `gh` and `git`. Invoke when the user wants to contribute to a repo where they lack write access: "I want to make a PR to <repo>", "contribute a fix to <repo>", "fork this and PR up", "open a PR against <upstream>", or when they've already cloned an upstream-not-fork and a `git push` would fail. Handles the four states a contributor can be in (no clone yet / cloned upstream directly / fork already exists locally / fork exists on GitHub but not cloned), forks via `gh repo fork --clone --remote` so `origin` and `upstream` are wired correctly, helps name a branch, then PAUSES for the user to make their commits before pushing and opening the PR with `gh pr create`. Not for: pushing to a repo the user already owns (no fork needed – just `git push` + `gh pr create`); diagnosing 403s from missing SAML SSO grants on `gh` tokens (one-time per org, not part of the per-PR flow – tell the user to grant SSO at github.com/settings/tokens and retry); resolving merge conflicts; multi-PR / stacked-diff workflows.
---

# Fork and PR

Walk a contributor through the standard "fork + branch + commit + push + PR" flow against a GitHub repo they don't have write access to. The user knows what they want to change; this skill codifies the boring `gh`/`git` syntax around it so they don't have to remember it.

## When this applies

Trigger when the user wants to contribute upward to a repo they don't own. Common phrasings: "I want to make a PR to X", "contribute a fix to X", "fork and PR", "open a PR against the upstream X repo", or right after a `git push` fails with 403 on a clone of someone else's repo.

Skip when:

- The user owns the repo (just `git push` + `gh pr create` – no fork needed).
- The user is hitting a SAML SSO 403 on `gh` itself (`Resource protected by organization SAML enforcement`). That's a one-time per-org token authorization at `https://github.com/settings/tokens`, not a per-PR step. Tell them to grant SSO on their `gh` CLI token and retry; don't try to drive that through this skill.
- The contribution is a stacked-diff or multi-PR series (this skill assumes one branch → one PR).

## Inputs from the user

Usually one or more of:

- **Upstream repo** (`owner/name` or full URL, e.g. `SalesforceCommerceCloud/plugin_sitemap`).
- **What they want to change** (a one-line intent, used to suggest a branch name).
- **Where they're starting from** – fresh, or already inside a clone.

If the upstream repo isn't named, ask. If the intent isn't named, ask before step 3 (branch naming) – not before steps 1–2.

## Flow

The skill runs as five steps with a deliberate pause between steps 3 and 4. Steps 1–3 set up the workspace; the user makes their edits and commits; steps 4–5 publish.

### Step 1: State check

Figure out which of four starting states the user is in. Run, in the directory the user is operating from:

```bash
git rev-parse --show-toplevel 2>/dev/null
git remote -v 2>/dev/null
gh repo view <upstream> --json viewerPermission,parent 2>&1
```

Interpret:

- **Not in a git repo** (`git rev-parse` fails) → state A: no clone yet.
- **In a git repo, `origin` points at upstream** → state B: cloned upstream directly. Will need to swap remotes during fork.
- **In a git repo, `origin` points at user's fork, `upstream` points at the target** → state D: fully set up. Skip to step 3.
- **`gh repo view` shows `viewerPermission: ADMIN/WRITE`** → user owns it or already has push access. Skill doesn't apply – tell them so and stop.
- **`gh repo view` errors with `Resource protected by organization SAML enforcement`** → SSO grant missing. Stop and tell them to authorize at `https://github.com/settings/tokens`; don't try to fork through it.

### Step 2: Fork (if needed)

For state A or B, run:

```bash
gh repo fork <upstream> --clone --remote
```

`--clone` clones the fork into the current directory if state A; if state B (already in a clone of upstream), `gh` swaps `origin` to point at the new fork and renames the existing remote to `upstream` automatically. `--remote` ensures the rename happens.

For state C (fork on GitHub but not cloned locally), `gh repo clone <user>/<repo>` then `git remote add upstream <upstream>`.

For state D, no-op.

After this step, `git remote -v` should show `origin` = user's fork, `upstream` = the target repo. Confirm before proceeding.

### Step 3: Branch

Suggest a branch name based on the user's stated intent. Conventions vary by upstream repo, but reasonable defaults:

- `fix/<short-slug>` for bug fixes
- `feat/<short-slug>` for features
- `chore/<short-slug>` for maintenance/dependency/cleanup
- `docs/<short-slug>` for docs-only changes

If the upstream repo has a `CONTRIBUTING.md` with a different convention, follow that instead. Run:

```bash
git checkout -b <branch-name>
```

### Step 4: PAUSE — user edits and commits

This is the handoff. Tell the user explicitly:

> "Branch `<name>` is ready. Make your edits, commit them (`git add <files>` then `git commit`), and tell me when you're done – I'll push and open the PR."

Then stop. Do not poll `git status` or proactively check on their progress; wait for them to come back with "done", "committed", "ready", or similar.

While paused, if the user asks code questions or wants help with the change itself, that's a different task – help them, but don't push or open the PR until they say they're done.

### Step 5: Push and open PR

When the user confirms they've committed:

```bash
git push -u origin <branch-name>
gh pr create --repo <upstream> --web
```

`--web` opens the PR creation page in the browser with the branch and base pre-filled. This is preferable to authoring title/body on the CLI for first-time contributions to a repo, because the upstream may have a PR template (`.github/PULL_REQUEST_TEMPLATE.md`) that only renders in the web UI.

If the user explicitly wants to skip the browser, drop `--web` and `gh` will prompt for title and body inline – or pass `--title` / `--body` directly if the user already knows what they want.

## Disambiguation

- **User says "make a PR" but is in a repo they own**: skip the fork; just push and `gh pr create`. Confirm by checking `gh repo view --json viewerPermission`.
- **User has multiple GitHub accounts**: `gh auth status` will show which one is active. The fork lands under the active account. If they want it under a different account, `gh auth switch` first.
- **Upstream uses a non-`main` default branch** (`master`, `develop`): `gh pr create` auto-detects it. Don't hardcode `main` anywhere.
- **User already has an old fork that's behind upstream**: `gh repo fork` is idempotent (it'll reuse the existing fork) but won't sync it. If their fork is stale and they want a clean branch off current upstream, `git fetch upstream && git checkout -b <branch> upstream/<default-branch>` before step 4.

## What this skill doesn't do

- Authenticate `gh` (`gh auth login` – one-time setup, not per-PR).
- Grant SAML SSO on `gh` tokens (per-org, browser-driven, one-time).
- Resolve merge conflicts on rebase/merge.
- Sync a stale fork with upstream beyond a single fresh branch.
- Author the actual commit message or PR body content – that's the user's call.

## Style

- Cite commands the user can run, not internal paths.
- One step per assistant turn during the active phases (1, 2, 3, 5). The pause at step 4 is the only multi-turn boundary.
- After step 5, return the PR URL `gh` printed and stop. Don't ask follow-ups.

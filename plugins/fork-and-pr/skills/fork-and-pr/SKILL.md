---
name: fork-and-pr
description: Use for a single GitHub fork-and-PR contribution when the user lacks upstream write access, including how-to, existing forks or clones, and push 403. Do not use for owned or write-access repos, SAML authorization, merge conflicts, or stacked or multiple PRs.
license: MIT
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

The skill runs as a staged flow with a deliberate pause after workspace setup. The user makes their edits and commits before the publish steps resume.

### Step 1: State check

Figure out the user's starting state. Run, in the directory the user is operating from:

```bash
git rev-parse --show-toplevel 2>/dev/null
git status --short 2>/dev/null
git remote -v 2>/dev/null
gh repo view <upstream> --json viewerPermission,parent 2>&1
gh api user --jq .login
gh repo view <user>/<repo> --json parent 2>/dev/null
```

Use the login printed by `gh api user` for `<user>` and the repository-name portion of `<upstream>` for `<repo>`.

Interpret:

- **Not in a git repo, and the user fork is absent** (`git rev-parse` and the user-fork lookup fail) → state A: no fork or clone yet.
- **In a git repo, `origin` points at upstream** → state B: cloned upstream directly. Will need to swap remotes during fork.
- **Not in a git repo, but the user fork's `parent` is upstream** → state C: fork exists on GitHub but is not cloned locally.
- **In a git repo, `origin` points at user's fork, `upstream` points at the target** → state D: fully set up. Skip to step 3.
- **`gh repo view` shows `viewerPermission: ADMIN/WRITE`** → user owns it or already has push access. Skill doesn't apply – tell them so and stop.
- **`gh repo view` errors with `Resource protected by organization SAML enforcement`** → SSO grant missing. Stop and tell them to authorize at `https://github.com/settings/tokens`; don't try to fork through it.

Keep the `git status --short` result for step 3. Do not stash, reset, or otherwise rewrite existing work to make the setup look clean.

### Step 2: Fork (if needed)

For state A, run:

```bash
gh repo fork <upstream> --clone --remote
```

This creates or reuses the fork, clones it, and configures the parent as `upstream`.

For state B, run this from inside the existing upstream clone:

```bash
gh repo fork --remote
```

Omitting the repository argument selects the current repository. `gh` renames the existing `origin` remote to `upstream` and adds the user's fork as the new `origin`; do not pass `--clone` inside an existing clone.

For state C, run:

```bash
gh repo clone <user>/<repo>
```

When GitHub CLI clones a fork, it adds the parent repository as `upstream` automatically. Verify the remotes before considering a manual `git remote add`.

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
git status --short
default_branch="$(gh repo view <upstream> --json defaultBranchRef --jq '.defaultBranchRef.name')"
git fetch upstream "$default_branch"
git checkout -b <branch-name> "upstream/$default_branch"
```

If `git status --short` reports changes, stop and ask the user how they want to preserve that work before creating a branch. Never stash or reset it silently. Starting from `upstream/$default_branch` avoids carrying stale fork commits or whatever branch happened to be checked out.

If the user is already on the intended topic branch, do not create a nested branch. Verify that the current upstream tip is an ancestor before continuing:

```bash
git merge-base --is-ancestor "upstream/$default_branch" HEAD
```

If that check fails, stop and discuss creating a clean branch or rebasing; conflict resolution is outside this skill.

### Step 4: PAUSE – user edits and commits

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
- **Upstream uses a non-`main` default branch** (`master`, `develop`): resolve it with `gh repo view` in step 3 and let `gh pr create` auto-detect the PR base. Don't hardcode `main` anywhere.
- **User already has an old fork that's behind upstream**: `gh repo fork` reuses the fork but doesn't sync its default branch. Step 3 deliberately creates the topic branch from the fetched upstream default, so syncing the fork's default branch is unnecessary.

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

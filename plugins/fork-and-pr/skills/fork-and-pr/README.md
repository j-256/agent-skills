# fork-and-pr

An Agent Skill that walks you through forking a GitHub repo you don't own, branching, committing, pushing, and opening a PR back to upstream – with the right `gh` and `git` syntax for your starting state.

## What it does

- **Detects your starting state.** Checks whether you are in a repository, where its remotes point, whether your fork exists only on GitHub, and whether you already have upstream write access.
- **Forks correctly from each starting state.** `gh repo fork <upstream> --clone --remote` from a fresh directory; `gh repo fork --remote` from an existing upstream clone; `gh repo clone <user>/<repo>` when the fork already exists on GitHub; no-op if everything is already wired.
- **Suggests a branch name** from your stated intent (`fix/...`, `feat/...`, `docs/...`, `chore/...`), or follows the upstream's `CONTRIBUTING.md` convention if it has one.
- **PAUSES for your commits.** Steps 1-3 set up the workspace; the skill stops and waits for you to make and commit your edits before steps 4-5 publish.
- **Opens the PR with the upstream's template loaded** – `gh pr create --repo <upstream> --web`, which surfaces `.github/PULL_REQUEST_TEMPLATE.md` (the CLI prompt mode skips it).
- **Branches from the current upstream default.** Resolves the default branch, fetches it, refuses to overwrite dirty work, and avoids inheriting stale fork commits or the current checkout.

## Not for

- **Pushing to a repo you already own.** No fork needed – just `git push` + `gh pr create`. The skill stops if `gh repo view` reports `viewerPermission: ADMIN/WRITE`.
- **SAML SSO 403s** from `gh` itself (`Resource protected by organization SAML enforcement`). That's a one-time per-org token authorization at `https://github.com/settings/tokens`, separate from the per-PR flow. The skill stops and tells you to grant SSO and retry.
- **Stacked-diff or multi-PR series.** Assumes one branch -> one PR.
- **Merge conflict resolution** during rebase or merge.
- **First-time `gh` setup** (`gh auth login`).

## Why you'd want this

The fork-and-PR flow has several entry states, and the right command for each one isn't worth memorizing if you only contribute upstream occasionally. The skill is a structured prompt that codifies the syntax so you don't go fishing through the `gh` docs every time – and the state-detection step catches the embarrassing case ("oh, I'm in a clone of upstream, my push is going to 403") before you waste a commit.

The deliberate pause between branch creation and push is the load-bearing design choice: the skill trusts the assistant to remember the in-flight state across your edit-and-commit phase rather than persisting it externally. Same conversation, same context, no state file.

## How it works

1. **State check** – inspect the repository, working tree, remotes, upstream permissions, and any existing user fork.
2. **Fork (if needed)** – use the command appropriate to a fresh directory, an existing upstream clone, or an existing remote fork, then verify `origin` and `upstream`.
3. **Branch** – resolve and fetch the upstream default, then create `<branch-name>` directly from it after confirming the working tree is clean.
4. **PAUSE** – you make edits, `git add`, `git commit`. The skill stops here.
5. **Push and open PR** – `git push -u origin <branch>` + `gh pr create --repo <upstream> --web`.

## Prerequisites

- `gh` CLI authenticated (`gh auth status` shows the right account).
- For org-protected repos: the `gh` CLI token has been authorized for that org at `https://github.com/settings/tokens` (one-time, per-org).

## Install

Install this directory as an individual Agent Skill, or install the self-contained `fork-and-pr` plugin.

No npm dependencies and no bundled runtime scripts. The flow runs in conversation; the active agent executes the `gh` and `git` commands as you authorize them.

## Usage

See [`SKILL.md`](SKILL.md) for the full per-state flow and command list. In practice you just say *"I want to make a PR to `<upstream>`"* and the skill drives.

## Companion skills

Domain-agnostic; no companions. The DSC family of skills in this repo target Salesforce developer docs and is unrelated.

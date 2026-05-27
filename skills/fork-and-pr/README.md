# fork-and-pr

A Claude Code skill that walks you through forking a GitHub repo you don't own, branching, committing, pushing, and opening a PR back to upstream -- with the right `gh` and `git` syntax for whichever of four starting states you're in.

## What it does

- **Detects your starting state.** Are you in a git repo? Is `origin` already a fork? Does `gh repo view` succeed? Five outcomes covered (no clone yet / cloned upstream directly / fork already exists locally / fork exists on GitHub but not cloned / you actually own the repo and don't need a fork).
- **Forks correctly across the four starting states.** `gh repo fork --clone --remote` from a fresh dir; same command from an upstream-clone (auto-swaps remotes to `origin` = fork, `upstream` = target); `gh repo clone` + `git remote add upstream` if the fork already exists on GitHub but not locally; no-op if everything's already wired.
- **Suggests a branch name** from your stated intent (`fix/...`, `feat/...`, `docs/...`, `chore/...`), or follows the upstream's `CONTRIBUTING.md` convention if it has one.
- **PAUSES for your commits.** Steps 1-3 set up the workspace; the skill stops and waits for you to make and commit your edits before steps 4-5 publish.
- **Opens the PR with the upstream's template loaded** -- `gh pr create --repo <upstream> --web`, which surfaces `.github/PULL_REQUEST_TEMPLATE.md` (the CLI prompt mode skips it).
- **Defaults to the right branch automatically.** Doesn't hardcode `main` -- `gh` auto-detects the upstream's default branch (`master`, `develop`, anything).

## Not for

- **Pushing to a repo you already own.** No fork needed -- just `git push` + `gh pr create`. The skill stops if `gh repo view` reports `viewerPermission: ADMIN/WRITE`.
- **SAML SSO 403s** from `gh` itself (`Resource protected by organization SAML enforcement`). That's a one-time per-org token authorization at `https://github.com/settings/tokens`, separate from the per-PR flow. The skill stops and tells you to grant SSO and retry.
- **Stacked-diff or multi-PR series.** Assumes one branch -> one PR.
- **Merge conflict resolution** during rebase or merge.
- **First-time `gh` setup** (`gh auth login`).

## Why you'd want this

The fork-and-PR flow has five steps and four entry states, and the right command for each combination isn't worth memorizing if you only contribute upstream occasionally. The skill is a structured prompt that codifies the syntax so you don't go fishing through the `gh` docs every time -- and the state-detection step catches the embarrassing case ("oh, I'm in a clone of upstream, my push is going to 403") before you waste a commit.

The deliberate pause between branch creation and push is the load-bearing design choice: the skill trusts the assistant to remember the in-flight state across your edit-and-commit phase rather than persisting it externally. Same conversation, same context, no state file.

## How it works

1. **State check** -- `git rev-parse --show-toplevel`, `git remote -v`, `gh repo view <upstream> --json viewerPermission,parent` to identify which starting state you're in.
2. **Fork (if needed)** -- `gh repo fork <upstream> --clone --remote` for fresh / upstream-clone states; `gh repo clone` + `git remote add upstream` for fork-not-cloned; no-op if already wired.
3. **Branch** -- `git checkout -b <branch-name>` with a name suggested from your intent.
4. **PAUSE** -- you make edits, `git add`, `git commit`. The skill stops here.
5. **Push and open PR** -- `git push -u origin <branch>` + `gh pr create --repo <upstream> --web`.

## Prerequisites

- `gh` CLI authenticated (`gh auth status` shows the right account).
- For org-protected repos: the `gh` CLI token has been authorized for that org at `https://github.com/settings/tokens` (one-time, per-org).

## Install

```bash
git clone <repo-url>
cd claude-code-skills
ln -s "$PWD/skills/fork-and-pr" ~/.claude/skills/fork-and-pr
```

No npm dependencies, no scripts -- this skill is just `SKILL.md` + this README. The flow runs in conversation; Claude executes the `gh` and `git` commands as you authorize them.

## Usage

See [`SKILL.md`](SKILL.md) for the full per-state flow and command list. In practice you just say *"I want to make a PR to `<upstream>`"* and the skill drives.

## Companion skills

Domain-agnostic; no companions. The DSC family of skills in this repo target Salesforce developer docs and is unrelated.

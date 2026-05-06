# fork-and-pr

Claude Code skill that walks a contributor through forking a GitHub repo they don't own, branching, committing, pushing, and opening a PR back to upstream. The skill itself doesn't run any tooling – it's a structured prompt that codifies the `gh` and `git` syntax so the user (and Claude on their behalf) doesn't have to remember it.

The flow has a deliberate pause: steps 1–3 set up the workspace (fork, remotes, branch), the user makes their edits and commits, then steps 4–5 push and open the PR. Same conversation throughout – the skill trusts the assistant to remember the in-flight state rather than persisting it externally.

## What it does

A user says *"I want to make a PR to `<upstream>`"* (or hits a 403 trying to push to a clone of someone else's repo), and the skill walks through:

1. **State check** – is the user in a git repo, is `origin` already a fork, does `gh repo view` work?
2. **Fork** – `gh repo fork <upstream> --clone --remote` (handles both "no local clone" and "already in upstream clone, swap remotes").
3. **Branch** – propose a branch name from the user's stated intent, `git checkout -b`.
4. **PAUSE** – user makes edits and commits; skill stops and waits.
5. **Push & PR** – `git push -u origin <branch>` then `gh pr create --repo <upstream> --web`.

## When to invoke

Whenever the user wants to contribute upward to a repo they don't have write access to:

- "I want to make a PR to `<repo>`"
- "fork this and PR up"
- "open a PR against `<upstream>`"
- A `git push` just failed with 403 on a clone of someone else's repo

## When NOT to invoke

- The user owns the repo. Just push and `gh pr create`.
- The user is hitting a SAML SSO 403 from `gh` itself (`Resource protected by organization SAML enforcement`). That's a one-time per-org token authorization at `https://github.com/settings/tokens`, separate from the per-PR flow. Tell them to grant SSO and retry.
- Multi-PR / stacked-diff workflows. This skill assumes one branch → one PR.

## Prerequisites

- `gh` CLI authenticated (`gh auth status` shows the right account).
- For org-protected repos: the `gh` CLI token has been authorized for that org at `https://github.com/settings/tokens` (one-time, per-org).

## Install

Symlinked into `~/.claude/skills/`:

```bash
ln -s "$PWD/claude-code-skills/skills/fork-and-pr" ~/.claude/skills/fork-and-pr
```

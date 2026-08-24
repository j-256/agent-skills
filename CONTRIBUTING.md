# Contributing to agent-skills

## Choose the source branch

The hosted `main` branch is a generated distribution tip and can be replaced after any publication. The stable, host-neutral development history lives on `source`. A force update of `main` does not affect a topic branch based on `source`.

After cloning, create a topic branch from `source` rather than `main`:

```bash
git fetch origin source
git switch -c my-change --no-track origin/source
git submodule update --init harness
```

If the canonical repository uses a remote other than `origin`, substitute that remote name. Push the topic branch to a writable remote and set the pull request's base branch to `source`. Keep repository self and companion links host-neutral in source content, and preserve the relative `../stream-eval.git` submodule URL.

To catch up while a pull request is open, rebase onto the latest source branch:

```bash
git fetch origin source
git rebase origin/source
git submodule update harness
```

If work was accidentally based on generated `main`, preserve a backup branch and replay only the contribution commits onto `source`:

```bash
git branch backup/my-change
git fetch origin source
git rebase --onto origin/source <generated-main-tip> my-change
git submodule update harness
```

`<generated-main-tip>` is the generated commit that the topic branch originally started from. If that boundary is unclear or generated `main` was merged into the topic, stop and ask a maintainer to inspect the graph rather than guessing.

## Validation

Run the repository validators for every distribution change:

```bash
node scripts/test-sync-standalone-skills.mjs
node scripts/sync-standalone-skills.mjs --check
node scripts/validate-skills.mjs
node scripts/validate-distribution.mjs
```

The nearest package README and [AGENTS.md](AGENTS.md) document the focused checks for skill, runtime, metadata, and eval changes.

## Commit messages

Use Conventional Commits, with a scope when it makes the change easier to identify.

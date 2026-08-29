## Prompt

> what's the standard fork-and-PR flow on GitHub? I keep forgetting whether to fork before or after cloning.

Skill: `fork-and-pr`. Captured from a trigger-eval transcript because the skill's pause-mid-flow shape does not fit synthesis-eval.

## Answer

From a fresh directory, fork and clone in one command:

```bash
gh repo fork <owner/repo> --clone --remote
```

This forks the repo on GitHub, clones your fork locally, and wires up both remotes correctly:

- `origin` -> your fork
- `upstream` -> the original repo

If you already cloned the upstream directly, run this from inside that clone:

```bash
gh repo fork --remote
```

The current-repository form swaps `origin` to the fork and preserves the original repository as `upstream`. Do not pass `--clone` inside an existing clone. If your fork already exists on GitHub but is not local, use `gh repo clone <user/repo>`; GitHub CLI adds the parent repository as `upstream` automatically.

After that, the flow is:

1. Confirm `git status --short` is clean; stop and preserve any existing work if it is not.
2. Resolve the upstream default with `gh repo view <owner/repo> --json defaultBranchRef --jq '.defaultBranchRef.name'`.
3. Fetch that branch and create `fix/<your-thing>` directly from `upstream/<default-branch>`.
4. Make edits, `git add`, `git commit`.
5. `git push -u origin <branch>`.
6. `gh pr create --repo <owner/repo> --web`.

The `--web` flag is worth keeping – it opens the PR form in the browser where any upstream PR template renders properly.

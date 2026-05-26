**Fork first, then clone** -- or better, do both in one command:

```bash
gh repo fork <owner/repo> --clone --remote
```

This forks the repo on GitHub, clones your fork locally, and wires up both remotes correctly:
- `origin` -> your fork
- `upstream` -> the original repo

If you already cloned the upstream directly (the common "oops"), run the same command from inside that clone. `gh` detects the situation and swaps `origin` to point at the new fork, renaming the existing remote to `upstream` -- no manual `git remote` surgery needed.

After that, the flow is:

1. `git checkout -b fix/<your-thing>`
2. Make edits, `git add`, `git commit`
3. `git push -u origin <branch>`
4. `gh pr create --repo <owner/repo> --web`

The `--web` flag on step 4 is worth keeping -- it opens the PR form in the browser where any upstream PR template renders properly.

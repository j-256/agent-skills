# Fork and PR

A self-contained Agent Plugin that guides contributors through a GitHub fork and one pull request to an upstream repository.

The package contains the [`fork-and-pr`](skills/fork-and-pr/) skill and a captured [standard-flow example](examples/fork-and-pr-standard-flow.md). It requires `git`, the GitHub CLI (`gh`), GitHub network access, and an authenticated account with any required organization SSO grant.

The portable [`plugin.json`](plugin.json), Codex [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and Claude [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) carry the same identity and version. Bump all three together for a release.

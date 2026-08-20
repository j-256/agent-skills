# Stepped Demo Script

A self-contained Agent Plugin for authoring paste-and-run Bash demonstrations with narration, pauses, visible expectations, and cleanup guidance.

The package contains the [`stepped-demo-script`](skills/stepped-demo-script/) skill and a captured [`find -delete` example](examples/demo-find-delete-no-prompt.md). Generated scripts target Bash 3.2 or later and use `jq` only when available.

The portable [`plugin.json`](plugin.json), Codex [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and Claude [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) carry the same identity and version. Bump all three together for a release.

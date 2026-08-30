# Stepped Demo Script

A self-contained Agent Plugin for authoring paste-and-run Bash demonstrations with narration, pauses, visible expectations, and cleanup guidance.

The package contains the [`stepped-demo-script`](skills/stepped-demo-script/) skill and a captured [`find -delete` example](examples/demo-find-delete-no-prompt.md). Generated scripts target Bash 3.2 or later and use `jq` only when available.

## Install

### Codex

Add the marketplace once, then install this plugin:

```bash
codex plugin marketplace add https://github.com/j-256/agent-skills.git
codex plugin add stepped-demo-script@portable-agent-skills
```

### Claude Code

Add the marketplace once, then install this plugin:

```bash
claude plugin marketplace add https://github.com/j-256/agent-skills.git --scope user
claude plugin install stepped-demo-script@portable-agent-skills --scope user
```

### OpenCode

OpenCode consumes the contained skill directly rather than the Agent Plugin manifests. Clone the repository to a stable location, then add this plugin's skills directory to `skills.paths` in `~/.config/opencode/opencode.json`:

```bash
git clone https://github.com/j-256/agent-skills.git agent-skills
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": {
    "paths": [
      "/absolute/path/to/agent-skills/plugins/stepped-demo-script/skills"
    ]
  }
}
```

Merge the path into an existing `skills.paths` array rather than replacing other entries, keep the clone in place, and restart OpenCode.

The portable [`plugin.json`](plugin.json), Codex [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and Claude [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) carry the same identity and version. Bump all three together for a release.

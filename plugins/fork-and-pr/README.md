# Fork and PR

A self-contained Agent Plugin that guides contributors through a GitHub fork and one pull request to an upstream repository.

The package contains the [`fork-and-pr`](skills/fork-and-pr/) skill and a captured [standard-flow example](examples/fork-and-pr-standard-flow.md). It requires `git`, the GitHub CLI (`gh`), GitHub network access, and an authenticated account with any required organization SSO grant.

## Install

### Codex

Add the marketplace once, then install this plugin:

```bash
codex plugin marketplace add https://github.com/j-256/agent-skills.git
codex plugin add fork-and-pr@portable-agent-skills
```

### Claude Code

Add the marketplace once, then install this plugin:

```bash
claude plugin marketplace add https://github.com/j-256/agent-skills.git --scope user
claude plugin install fork-and-pr@portable-agent-skills --scope user
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
      "/absolute/path/to/agent-skills/plugins/fork-and-pr/skills"
    ]
  }
}
```

Merge the path into an existing `skills.paths` array rather than replacing other entries, keep the clone in place, and restart OpenCode.

The portable [`plugin.json`](plugin.json), Codex [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and Claude [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) carry the same identity and version. Bump all three together for a release.

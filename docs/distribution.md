# Distribution and installation

This repository is named `agent-skills`, while its marketplace identity is `portable-agent-skills`. The marketplace uses a distinct name because Claude reserves `agent-skills` for an official source.

## What gets installed

The repository publishes three independently installable, self-contained packages:

| Plugin | Bundled skills |
|---|---|
| `dsc` | `dsc-endpoint-help`, `dsc-scenario`, `dsc-scrape` |
| `fork-and-pr` | `fork-and-pr` |
| `stepped-demo-script` | `stepped-demo-script` |

Each package contains a portable `plugin.json`, a Codex `.codex-plugin/plugin.json`, a Claude `.claude-plugin/plugin.json`, its license, and every runtime file it needs. The root Codex and Claude marketplace catalogs both point to these packages with repository-relative paths. OpenCode consumes the contained skill directories through its `skills.paths` configuration because its JavaScript plugin system is separate from the Agent Plugin format.

## Choose one repository source

A client only needs one reachable installation source:

1. Use a local clone while developing or when Git authentication is inconvenient
2. Use this repository's Git remote for shared installation

Register the marketplace once per client.

## Install from a local clone

Add the repository root, not an individual plugin directory, because the marketplace catalog lives at the root.

For Codex:

```bash
codex plugin marketplace add /absolute/path/to/agent-skills
codex plugin add dsc@portable-agent-skills
codex plugin add fork-and-pr@portable-agent-skills
codex plugin add stepped-demo-script@portable-agent-skills
```

The CLI commands may be replaced with Codex's `/plugins` browser. Start a new session after installation.

For Claude Code:

```bash
claude plugin marketplace add /absolute/path/to/agent-skills --scope user
claude plugin install dsc@portable-agent-skills --scope user
claude plugin install fork-and-pr@portable-agent-skills --scope user
claude plugin install stepped-demo-script@portable-agent-skills --scope user
```

Start a new session after installation, or run `/reload-plugins` if Claude's install summary requests it.

For OpenCode, keep the clone in place and add the desired package skill directories to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": {
    "paths": [
      "/absolute/path/to/agent-skills/plugins/dsc/skills",
      "/absolute/path/to/agent-skills/plugins/fork-and-pr/skills",
      "/absolute/path/to/agent-skills/plugins/stepped-demo-script/skills"
    ]
  }
}
```

Merge the desired entries into an existing `skills.paths` array rather than replacing other entries, then restart OpenCode. Pointing at each plugin's `skills/` directory preserves the real plugin layout, including the DSC package's relative access to `shared/`.

## Install from this repository's Git remote

Codex and Claude Code accept the full Git URL localized into the hosted copy of this document:

```bash
marketplace_url='<repo-url>'
git ls-remote "$marketplace_url"
codex plugin marketplace add "$marketplace_url"
claude plugin marketplace add "$marketplace_url" --scope user
```

Install plugins through the Codex or Claude Code commands shown in the local-install section. For OpenCode, clone the same URL and configure the resulting absolute paths as shown above:

```bash
git clone "$marketplace_url" agent-skills
```

## Install from a private or SSO-protected Git remote

For another private source, first prove that Git can authenticate without an interactive username or password prompt:

```bash
marketplace_url='https://git.example.com/TEAM/agent-skills.git'
git ls-remote "$marketplace_url"
```

If that succeeds, use the same URL with Codex and Claude Code:

```bash
codex plugin marketplace add "$marketplace_url"
claude plugin marketplace add "$marketplace_url" --scope user
```

OpenCode uses an ordinary persistent clone rather than a marketplace command:

```bash
git clone "$marketplace_url" agent-skills
```

If `git ls-remote` prompts or fails, complete the provider's SSO authorization and configure its Git credential helper first. Claude's manual marketplace add, install, and update commands use the same existing Git credential helpers as the terminal. Codex accepts HTTPS and SSH Git marketplace sources, and OpenCode relies on `git clone`, so the source must be cloneable in the environment where the client runs.

Claude's `OWNER/REPOSITORY` shorthand uses SSH by default. Prefer a full HTTPS URL when corporate access is already configured through a credential helper, or set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` before using shorthand. For SSH, pre-load the key in `ssh-agent` and accept the host fingerprint before installation because Claude suppresses interactive SSH prompts.

Claude background marketplace refreshes disable HTTPS credential helpers for the initial pull. A failed pull falls back to a credentialed re-clone, but private repositories behave more predictably when `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` is set and updates are run manually. Do not solve this with a broad plaintext token rewrite in global Git configuration.

## Direct skill compatibility

The plugin marketplaces are the preferred Codex and Claude Code distribution path, while `skills.paths` is the supported OpenCode path. Existing local Claude installations that symlink direct skills from a full clone remain compatible:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/dsc-endpoint-help" ~/.claude/skills/dsc-endpoint-help
ln -s "$PWD/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
ln -s "$PWD/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
ln -s "$PWD/skills/fork-and-pr" ~/.claude/skills/fork-and-pr
ln -s "$PWD/skills/stepped-demo-script" ~/.claude/skills/stepped-demo-script
```

Keep the full clone in place. The compatibility paths are repository symlinks into canonical plugin packages, while the DSC skills resolve the bundled `plugins/dsc/shared/` runtime directly. Copying only a root `skills/<name>` symlink does not create a self-contained package.

## Maintainer validation

Run the repository validators and Claude's strict validators after changing packaging or marketplace metadata:

```bash
node scripts/validate-skills.mjs
node scripts/validate-distribution.mjs
claude plugin validate --strict plugins/dsc
claude plugin validate --strict plugins/fork-and-pr
claude plugin validate --strict plugins/stepped-demo-script
claude plugin validate --strict .claude-plugin/marketplace.json
```

The manifests for one plugin share a version. Bump its portable, Codex, and Claude manifests together before publishing a release.

## Platform references

- [OpenAI plugin documentation](https://developers.openai.com/plugins/)
- [Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces)
- [OpenCode skill documentation](https://opencode.ai/docs/skills/)
- [Agent Skills specification](https://agentskills.io/specification)

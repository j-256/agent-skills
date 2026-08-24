# Distribution and installation

This repository is named `agent-skills`, while its marketplace identity is `portable-agent-skills`. The marketplace uses a distinct name because Claude reserves `agent-skills` for an official source.

## What gets installed

The repository publishes three independently installable, self-contained packages:

| Plugin | Bundled skills |
|---|---|
| `dsc` | `dsc-endpoint-help`, `dsc-scenario`, `dsc-scrape` |
| `fork-and-pr` | `fork-and-pr` |
| `stepped-demo-script` | `stepped-demo-script` |

Each package contains a portable `plugin.json`, a Codex `.codex-plugin/plugin.json`, a Claude `.claude-plugin/plugin.json`, its license, and every runtime file it needs. The root Codex and Claude marketplace catalogs both point to these packages with repository-relative paths.

## Choose one marketplace source

A client only needs one reachable installation source:

1. Use a local clone while developing or when Git authentication is inconvenient
2. Use this repository's Git remote for shared installation

Register the marketplace once per client.

## Install from a local clone

Add the repository root, not an individual plugin directory, because the marketplace catalog lives at the root.

For Codex:

```bash
codex plugin marketplace add /absolute/path/to/agent-skills
codex
```

Inside Codex, open `/plugins`, choose the `portable-agent-skills` marketplace, install the desired plugins, and start a new session before using them.

For Claude Code:

```bash
claude plugin marketplace add /absolute/path/to/agent-skills --scope user
claude plugin install dsc@portable-agent-skills --scope user
claude plugin install fork-and-pr@portable-agent-skills --scope user
claude plugin install stepped-demo-script@portable-agent-skills --scope user
```

Start a new session after installation, or run `/reload-plugins` if Claude's install summary requests it.

## Install from this repository's Git remote

Both clients accept the full Git URL localized into the hosted copy of this document:

```bash
marketplace_url='<repo-url>'
git ls-remote "$marketplace_url"
codex plugin marketplace add "$marketplace_url"
claude plugin marketplace add "$marketplace_url" --scope user
```

Install plugins through Codex's `/plugins` browser or the Claude commands shown in the local-install section.

## Install from a private or SSO-protected Git remote

For another private source, first prove that Git can authenticate without an interactive username or password prompt:

```bash
marketplace_url='https://git.example.com/TEAM/agent-skills.git'
git ls-remote "$marketplace_url"
```

If that succeeds, use the same URL with both clients:

```bash
codex plugin marketplace add "$marketplace_url"
claude plugin marketplace add "$marketplace_url" --scope user
```

If `git ls-remote` prompts or fails, complete the provider's SSO authorization and configure its Git credential helper first. Claude's manual marketplace add, install, and update commands use the same existing Git credential helpers as the terminal. Codex accepts HTTPS and SSH Git marketplace sources, so its source must likewise be cloneable in the environment where Codex runs.

Claude's `OWNER/REPOSITORY` shorthand uses SSH by default. Prefer a full HTTPS URL when corporate access is already configured through a credential helper, or set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` before using shorthand. For SSH, pre-load the key in `ssh-agent` and accept the host fingerprint before installation because Claude suppresses interactive SSH prompts.

Claude background marketplace refreshes disable HTTPS credential helpers for the initial pull. A failed pull falls back to a credentialed re-clone, but private repositories behave more predictably when `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` is set and updates are run manually. Do not solve this with a broad plaintext token rewrite in global Git configuration.

## Direct skill compatibility

The plugin marketplaces are the preferred distribution path. Existing local Claude installations that symlink direct skills from a full clone remain compatible:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/dsc-endpoint-help" ~/.claude/skills/dsc-endpoint-help
ln -s "$PWD/skills/dsc-scenario" ~/.claude/skills/dsc-scenario
ln -s "$PWD/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
ln -s "$PWD/skills/fork-and-pr" ~/.claude/skills/fork-and-pr
ln -s "$PWD/skills/stepped-demo-script" ~/.claude/skills/stepped-demo-script
```

Keep the full clone in place. The compatibility paths are repository symlinks into canonical plugin packages, and the DSC skills share `plugins/dsc/shared/` through contained symlinks. Copying only a root `skills/<name>` symlink does not create a self-contained package.

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
- [Agent Skills specification](https://agentskills.io/specification)

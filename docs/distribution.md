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

The repository also publishes each skill as an ordinary, self-contained directory under `skills/<name>/`. These directories are generated from the canonical plugin skills. Each DSC standalone skill includes its own synchronized `shared/` runtime, so copying one skill does not create a dependency on a sibling directory or a full repository clone.

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

Merge the desired entries into an existing `skills.paths` array rather than replacing other entries, then restart OpenCode. Each selected skill resolves its runtime within its own directory.

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

## Install one skill without a full checkout

Every root `skills/<name>/` path is a standalone package. A direct-skill client can install that directory alone, and a local consumer can copy it into the client's skill directory without preserving the repository around it.

To fetch only one skill from a Git source, use sparse checkout:

```bash
repository_url='<repo-url>'
skill='dsc-endpoint-help'
git clone --filter=blob:none --sparse "$repository_url" agent-skill
git -C agent-skill sparse-checkout set "skills/$skill"
```

The installable directory is then `agent-skill/skills/$skill`. Copy that directory into the consuming client's skill location, or point a direct-skill discovery setting at its parent directory. No plugin manifest, sibling skill, or `plugins/dsc/shared/` path needs to remain available.

From an existing checkout, the equivalent operation is simply:

```bash
cp -R "skills/$skill" /path/to/client-skills/
```

## Maintainer validation

Run the repository validators and Claude's strict validators after changing packaging or marketplace metadata:

```bash
node scripts/test-sync-standalone-skills.mjs
node scripts/sync-standalone-skills.mjs --check
node scripts/validate-skills.mjs
node scripts/validate-distribution.mjs
claude plugin validate --strict plugins/dsc
claude plugin validate --strict plugins/fork-and-pr
claude plugin validate --strict plugins/stepped-demo-script
claude plugin validate --strict .claude-plugin/marketplace.json
```

After editing a canonical skill or `plugins/dsc/shared/`, refresh generated copies with `node scripts/sync-standalone-skills.mjs --write`. The manifests for one plugin share a version. Bump its portable, Codex, and Claude manifests together before publishing a release.

The source-branch validation workflow runs the synchronization test, `--check`, both repository validators, and every offline DSC suite on pushes and pull requests.

## Platform references

- [OpenAI plugin documentation](https://developers.openai.com/plugins/)
- [Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces)
- [OpenCode skill documentation](https://opencode.ai/docs/skills/)
- [Agent Skills specification](https://agentskills.io/specification)

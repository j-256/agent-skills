# DSC

A self-contained Agent Plugin for Salesforce API references published on developer.salesforce.com.

## Skills

- [`dsc-scrape`](skills/dsc-scrape/) fetches catalogs, references, operations, and types into a uniform JSON cache.
- [`dsc-endpoint-help`](skills/dsc-endpoint-help/) answers single-endpoint questions and diagnoses request or OAuth errors against the published spec.
- [`dsc-scenario`](skills/dsc-scenario/) composes multi-call plans and runnable cURL blocks with prerequisite ordering and ID threading.

The editable runtime source lives in [`shared/`](shared/), and the distribution sync copies it into each skill's local `shared/` directory. The package requires Node.js, network access to developer.salesforce.com, and a writable user cache directory. No npm install is required because the YAML parser is vendored.

## Install

### Codex

Add the marketplace once, then install this plugin:

```bash
codex plugin marketplace add https://github.com/j-256/agent-skills.git
codex plugin add dsc@portable-agent-skills
```

### Claude Code

Add the marketplace once, then install this plugin:

```bash
claude plugin marketplace add https://github.com/j-256/agent-skills.git --scope user
claude plugin install dsc@portable-agent-skills --scope user
```

### OpenCode

OpenCode consumes the contained skills directly rather than the Agent Plugin manifests. Clone the repository to a stable location, then add the DSC skills directory to `skills.paths` in `~/.config/opencode/opencode.json`:

```bash
git clone https://github.com/j-256/agent-skills.git agent-skills
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": {
    "paths": [
      "/absolute/path/to/agent-skills/plugins/dsc/skills"
    ]
  }
}
```

Merge the path into an existing `skills.paths` array rather than replacing other entries, keep the selected skill directories in place, and restart OpenCode.

## Validation

From this plugin directory:

```bash
bash shared/test/run.sh
bash skills/dsc-scrape/test/run.sh
bash skills/dsc-endpoint-help/test/run.sh
bash skills/dsc-scenario/test/run.sh
```

The portable [`plugin.json`](plugin.json), Codex [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and Claude [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) carry the same identity and version. Bump all three together for a release.

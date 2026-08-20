# DSC

A self-contained Agent Plugin for Salesforce API references published on developer.salesforce.com.

## Skills

- [`dsc-scrape`](skills/dsc-scrape/) fetches catalogs, references, operations, and types into a uniform JSON cache.
- [`dsc-endpoint-help`](skills/dsc-endpoint-help/) answers single-endpoint questions and diagnoses request or OAuth errors against the published spec.
- [`dsc-scenario`](skills/dsc-scenario/) composes multi-call plans and runnable cURL blocks with prerequisite ordering and ID threading.

The skills share the contained [`shared/`](shared/) library through plugin-internal symlinks. The package requires Node.js, network access to developer.salesforce.com, and a writable user cache directory. No npm install is required because the YAML parser is vendored.

## Validation

From this plugin directory:

```bash
bash shared/tests/run.sh
bash skills/dsc-scrape/tests/run.sh
bash skills/dsc-endpoint-help/tests/run.sh
bash skills/dsc-scenario/tests/run.sh
```

The portable [`plugin.json`](plugin.json), Codex [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and Claude [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) carry the same identity and version. Bump all three together for a release.

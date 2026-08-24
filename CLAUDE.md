@AGENTS.md

# Claude Code compatibility

Claude-specific package metadata lives in the root `.claude-plugin/marketplace.json` catalog and each plugin's `.claude-plugin/plugin.json` manifest. Keep those files synchronized with the portable and Codex manifests as required by `AGENTS.md`, and validate them with `claude plugin validate --strict`.

The `stream-eval` harness invokes `claude -p`; its model and profile guidance in `AGENTS.md` applies only to evaluation infrastructure, not to the runtime assumptions of shipped skills.

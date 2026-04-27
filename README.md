# claude-code-skills

Personal collection of [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) skills.

[Skills](https://docs.claude.com/en/docs/claude-code/skills) are self-contained capability packages that Claude Code discovers and invokes on demand. Each directory under [`skills/`](skills/) is one skill — its own `SKILL.md`, supporting scripts, tests, and documentation.

## Skills

| Name | Description |
|---|---|
| [`dsc-scrape`](skills/dsc-scrape/) | Scrape developer.salesforce.com (DSC) API reference pages into structured JSON. Fetch-based — handles OpenAPI 3 (YAML), RAML (AMF JSON), and ReDoc references through one pipeline. |

## Install

Claude Code discovers skills from `~/.claude/skills/<skill-name>/`. To install a skill from this repo, symlink its directory in:

```bash
git clone <repo-url>
ln -s "$PWD/claude-code-skills/skills/dsc-scrape" ~/.claude/skills/dsc-scrape
```

Copying instead of symlinking also works, but you lose the ability to pull updates with `git pull`.

Each skill has its own `README.md` covering prerequisites (Node version, external tools, MCP servers, etc.) and usage. Check the skill's README before first use.

## License

[MIT](LICENSE).

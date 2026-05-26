## Prompt

> what API references does Agentforce publish?

Skill: `dsc-scrape`. Captured from `evals/dsc-scrape/synthesis-eval.json` fixture `agentforce-alias-url-trace` (run 5 of `iteration-synthesis-baseline`).

## Answer

Agentforce publishes 10 references at https://developer.salesforce.com/docs/ai/agentforce/references. Two are scrapeable REST APIs; the rest are markdown docs:

**Scrapeable REST references (`rest-oa3`)**
| Reference | URL |
|---|---|
| Agent API | https://developer.salesforce.com/docs/ai/agentforce/references/agent-api |
| Models API REST | https://developer.salesforce.com/docs/ai/agentforce/references/models-api |

**Markdown references** (documentation, not machine-readable specs)
| Reference | URL |
|---|---|
| About | https://developer.salesforce.com/docs/ai/agentforce/references/about |
| Agentforce DX | https://developer.salesforce.com/docs/ai/agentforce/references/agentforce-dx |
| Agentforce Mobile SDK | https://developer.salesforce.com/docs/ai/agentforce/references/agentforce-mobile-sdk |
| Agent Script | https://developer.salesforce.com/docs/ai/agentforce/references/agent-script |
| Models API Apex Classes | https://developer.salesforce.com/docs/ai/agentforce/references/models-apex-api |
| Testing API | https://developer.salesforce.com/docs/ai/agentforce/references/testing-api |
| Citations | https://developer.salesforce.com/docs/ai/agentforce/references/citations |
| Metadata and Tooling API | https://developer.salesforce.com/docs/ai/agentforce/references/agents-metadata-tooling |

The two REST APIs are the ones this skill can dig into further – let me know if you want to look up endpoints in either.

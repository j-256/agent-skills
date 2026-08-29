# Fork-and-PR routing exclusions

Status: shipped on 2026-08-29 with the isolated Codex trigger profile, `gpt-5.6-sol`, low reasoning effort, and every sibling skill installed.

## Hypothesis

The discovery description should invoke `fork-and-pr` for a single upstream contribution where the user lacks write access, while declining owned or write-access repositories, SAML authorization failures, merge conflicts, and stacked or multiple pull requests.

## Finding

The original description led with an unconditional "Always use" instruction and left its exclusions at the end. The isolated trigger run accepted every intended contribution prompt but also invoked the skill for SAML authorization, stacked pull requests, and a repository where the user already had write access.

The revised description makes missing upstream write access part of the positive condition and states the exclusions as a direct "Do not use" sentence. On the rerun, every positive fixture invoked `fork-and-pr` first and every negative fixture declined it.

## Decision

Keep applicability conditions in the positive clause instead of relying on a trailing exception to narrow a broad unconditional trigger. The workflow body still explains each excluded case so an agent that has already loaded the skill can stop safely.

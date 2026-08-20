# iteration-description-cap

Status: PASSED. Every skill description satisfies the repository's 300-character limit, the standard Agent Skills validator accepts every skill, and every final full trigger suite passes with all sibling skills installed.

## Hypothesis tested

The skill descriptions can be reduced to at most 300 characters without losing their routing boundaries if each description prioritizes concrete request shapes, explicit handoffs, and the most important exclusions.

Verdict: confirmed. The final descriptions preserve the intended boundaries among endpoint lookup, multi-call scenarios, reference scraping, fork-and-PR contribution, and narrated Bash demonstrations.

## Method

The evaluations used `global.anthropic.claude-sonnet-4-6` with the isolated profile. Every run installed the skill under test plus all four sibling skills, so the model had to choose among the repository's complete skill set rather than decide against an empty background. Credentials were injected through the local authenticated environment without writing or printing secret values.

Candidate descriptions first ran against each skill's complete trigger fixture. A failure produced a small focused fixture containing the missed boundary and representative confusables. Focused fixtures ran repeatedly before the complete fixture ran again. The per-run timeout was 600 seconds because the trigger harness continues executing a selected skill after recording its first tool call; provider retry backoff is excluded from that effective timeout.

`scripts/validate-skills.mjs` enforces the 300-character limit, single-line descriptions, and directory-to-frontmatter name agreement. The standard `quick_validate.py` validator supplied with the Agent Skills tooling also accepts every skill.

## Results

| Skill | Focused evidence | Final complete fixture |
|---|---|---|
| `dsc-endpoint-help` | Error-only diagnosis fires while custom-hook runtime questions decline in every repeated run | Every query passed |
| `dsc-scrape` | Reference URLs and API catalogs fire while Atlas guides decline in every repeated run | Every query passed |
| `dsc-scenario` | Runnable multi-call repros fire while narrated demos and single-endpoint lookups hand off in every repeated run | Every query passed |
| `fork-and-pr` | Generic flow and existing-clone requests fire while owned-repository and SAML work decline in every repeated run | Every query passed |
| `stepped-demo-script` | An explicit Bash reproduction without the word `script` fires while scenario planning and CI work decline in every repeated run | Every query passed |

The final complete outputs are under each skill's ignored `evals/<skill>/runs/final-description*/results.json` directory. Focused outputs use the corresponding `iteration-description-*` directories.

## Controlled comparison

`fork-and-pr` initially under-fired on a generic fork flow and an existing cloned fork after compression. A detached-worktree control restored the original long description and ran the same model, sibling set, and focused fixture. The original description missed the same two request shapes, so the behavior was model drift rather than a compression regression. Starting the compressed description with `Always use` made every focused and complete query pass while preserving all declines.

`stepped-demo-script` showed one analogous stochastic miss on a request that explicitly asked for a Bash reproduction with pauses and visible checks. Changing its opening from `Use` to `Always use` made that exact query pass in every focused repetition and in the complete rerun without creating a false positive.

## Harness observations

Some negative fixtures asked for ordinary scripts or CI configuration. The model correctly declined `stepped-demo-script` but then wrote files while carrying out the alternative task. The evaluator detected those changes, destroyed the disposable worktrees, and left the operator worktree untouched. These were containment events, not routing failures.

## Conclusion

The 300-character requirement is compatible with this repository's trigger quality. The strongest descriptions are not compressed summaries of the full skill body; they are compact routing contracts that state the highest-signal positive shapes, the neighboring skill handoffs, and the exclusions most likely to cause harmful over-firing.

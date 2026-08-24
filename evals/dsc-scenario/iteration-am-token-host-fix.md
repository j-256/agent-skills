# iteration-am-token-host-fix

## Finding

The Account Manager (AM) token URL the skill hardcodes was wrong: `account.demandware.net` does **not resolve** (DNS failure), while `account.demandware.com` is the live endpoint. Found by **executing** the runnable the skill emits for the AM auth branch (demo prompt 5, SCAPI Admin `getOrder`), not by reading it – every text/citation assertion on that fixture passed, but the emitted URL was non-functional. This is the exact failure class that text-level synthesis assertions can't catch: a plan that *reads* correct and cites a canonical-looking URL that is dead.

## Evidence (verified live)

- `curl https://account.demandware.net/dwsso/oauth2/access_token` → `Could not resolve host` (the SCAPI sandbox host and developer.salesforce.com both resolve fine from the same environment, so it's host-specific, not a general network block).
- `POST https://account.demandware.com/dwsso/oauth2/access_token` with the AM private client (`client_credentials`) → **HTTP 200**, real Bearer token, granted scopes include `sfcc.orders.rw`.
- End-to-end demo-5 runnable: AM token (`.com`) 200 → `getOrder` 403 `Forbidden`. The 403 is a Business Manager role/WebDAV-permission gap on the AM client (exactly the nuance the skill's own demo-5 answer predicts: "scope gates the call, BM role gates the data; without it 401/403"), i.e. a sandbox client-config limitation, not a skill defect. The token-URL half is the defect; the call-shape half is correct.

## What changed

- `skills/_shared/slas-flows.js`: `AM_FLOWS['private-cc'].tokenUrl` and `['public-pkce'].tokenUrl` → `.com` (the source of truth; both flows share the host).
- `skills/dsc-scenario/SKILL.md`: 3 occurrences (output-composition line, auth-routing table row, AM-framing example block).
- `skills/dsc-scenario/README.md`: the "auth routing isn't in the spec" explanation.
- `skills/dsc-scenario/test/test-slas-flows.js`: both `AM_FLOWS` tokenUrl assertions → `.com` (RED-first: updated test failed against the `.net` source, then the source fix turned it green).
- `evals/dsc-scenario/synthesis-eval.json`: `synthesis-scenario-am-admin-orders` positive assertion pattern `account\.demandware\.com/...` + `because`/hypothesis updated.

Historical artifacts left as-is (they record what was true when written): `docs/superpowers/plans/` and `specs/` for the original auth-routing work, and `evals/dsc-scenario/runs/**/results.json`.

## Surprise / why it matters

The skill family's whole premise is "don't ship a confidently-wrong answer." A hardcoded, authoritative-looking token URL that doesn't resolve is precisely that – and it survived every synthesis eval because the assertions checked that the URL was *cited verbatim*, not that it *works*. The lesson: for emitted runnables, executing them against a live instance is a distinct verification layer from asserting on their text. The `createOrder` registry runnable was executed in the same pass and worked end-to-end (createBasket 200 → createOrder 200, real orderNo), which is why this defect stood out – the basket path was live-correct, the AM path was not.

## Eval

Deterministic suite 12/12 after the fix (RED→GREEN on test-slas-flows). `synthesis-scenario-am-admin-orders` re-run on Sonnet 4.6 (isolated, 3 runs): **3/3 strict pass** – the model emits `account.demandware.com` and the now-`.com`-required positive assertion holds, `first_tool=Skill`/`dsc-scenario`, 0 failed asserts, 0 contaminated.

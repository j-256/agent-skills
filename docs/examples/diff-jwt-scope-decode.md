## Prompt

> this is failing on a customer's instance. their getCustomer call is 403ing -- here's the request, response, and the bearer JWT they're sending. can you decode the scopes from the token and tell me what's missing for shopper-customers getCustomer?
>
> request:
> ```
> curl -X GET 'https://zzrf-001.dx.commercecloud.salesforce.com/checkout/shopper-customers/v1/organizations/f_ecom_zzrf_001/customers/abc12345' \
>   -H 'Authorization: Bearer eyJ2ZXIiOiIxLjAiLCJqa3UiOiJzbGFzL3Byb2QvenpyZl8wMDEiLCJraWQiOiJlMzc1MmFjMy0yMzIzLTQwMjgtODk0ZC01ZjRjMTQwOTAxOTIiLCJ0eXAiOiJqd3QiLCJjbHYiOiJKMi4yLjAiLCJhbGciOiJFUzI1NiJ9.eyJzY3AiOlsic2ZjYy5zaG9wcGVyLWJhc2tldHMucnciLCJzZmNjLnNob3BwZXItb3JkZXJzIl0sInN1YiI6ImNjOnNsYXM6OnNmY2M6dGVuYW50Onp6cmZfMDAxOjp1c2lkOjEyMzQifQ.signature'
> ```
>
> response: HTTP 403
> body: `{"type":"/error-types/insufficient-scope-error","title":"Insufficient Scope"}`
>
> which scope do they need to add?

Skill: `dsc-endpoint-help`. Captured from `evals/dsc-endpoint-help/synthesis-eval.json` fixture `synthesis-diff-jwt-scope-decode` (run from `iteration-harness-skill-load-determinism`).

## Answer

## Diagnosis

The token's scopes are completely wrong for this call. It was issued for baskets/orders (`sfcc.shopper-baskets.rw`, `sfcc.shopper-orders`) -- none of those cover `getCustomer`. The spec requires one of: `sfcc.shopper-myaccount`, `sfcc.shopper-myaccount.rw`, or `sfcc.shopper-standard`. The customer needs to re-request a token with at least `sfcc.shopper-myaccount` (read-only access is sufficient for `getCustomer`). There's also a separate shape issue – `siteId` is a required query param and it's missing from the request entirely.

Confidence: **high** – scopes decoded directly from the JWT `scp` claim.

## Diff

### Scopes
- Required: `sfcc.shopper-myaccount`, `sfcc.shopper-myaccount.rw`, `sfcc.shopper-standard` (any one)
- Provided: `sfcc.shopper-baskets.rw`, `sfcc.shopper-orders`
- Missing: all three required scopes

### Request shape
- `siteId` query param is required but absent – add `?siteId=<site-id>` to the URL

## Sources
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-customers?meta=getCustomer

---

Two things to fix: get a new token scoped for `sfcc.shopper-myaccount`, and add `siteId` to the query string. The 403 will clear once the right scope is in the token; the missing `siteId` would likely surface as a 400 after that.

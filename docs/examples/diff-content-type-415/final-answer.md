## Prompt

> customer's checkout integration is returning 415 from shopper-baskets on createBasket. here's the exact request and response:
>
> ```
> curl -X POST 'https://zzrf-001.dx.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/f_ecom_zzrf_001/baskets?siteId=RefArch' \
>   -H 'Authorization: Bearer eyJ2ZXIi...' \
>   -H 'Content-Type: text/plain' \
>   -d '{"currency":"USD"}'
> ```
>
> response: HTTP 415
> body: `{"type":"/error-types/unsupported-media-type","title":"Unsupported Media Type","detail":"The Content-Type header value 'text/plain' is not supported by this resource."}`
>
> what's wrong here? diff against the spec.

Skill: `dsc-endpoint-help`. Captured from `evals/dsc-endpoint-help/synthesis-eval.json` fixture `synthesis-diff-content-type-415` (run from `iteration-triage-content-type-extraction`).

## Answer

## Diagnosis

The 415 is caused by a wrong `Content-Type` header. The spec requires `application/json` for `createBasket`'s request body; the integration is sending `text/plain`. The fix is a one-header change: replace `-H 'Content-Type: text/plain'` with `-H 'Content-Type: application/json'`.

Confidence: low – no token was provided, so scope coverage can't be confirmed. The Content-Type mismatch is the unambiguous root cause of the 415; once that's fixed, the call may still fail on auth if the token's scopes are wrong. Share the token if you want a scope diff too.

## Diff

### Request shape
- **Content-Type mismatch** – sent `text/plain`, spec requires `application/json`

### Scopes
- Required: `sfcc.shopper-baskets-orders.rw` OR `sfcc.shopper-standard`
- Provided: unknown (no token decoded)
- Missing: unknown

## Sources
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket

## Prompt

> logged-in shopper -- what has to be done before addPaymentInstrumentToBasket will succeed? in order, with the scopes

Skill: `dsc-scenario`. Captured verbatim from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-inreference-producer-pick` (`iteration-unify-curated-facts`, Sonnet, strict-pass 5/5), executed against a live B2C Commerce sandbox (RefArch, v25_6). Everything below `## Answer` is byte-for-byte as the skill composed it; the only edits permitted are scrubbing the sandbox realm to a placeholder and dropping a leading reasoning preamble. The target is `addPaymentInstrumentToBasket`, not order submission -- so the honest success signal is a returned basket carrying a `paymentInstruments[]` entry with a real `paymentInstrumentId`, not an `orderNo`. The payment body is skill-emitted (the `op-body` curated fact), not hand-added.

## Answer (verbatim skill output)

---

## Scenario: Logged-in shopper adds a payment instrument to a basket

Target: `POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments`   (`shopper-baskets-v2.addPaymentInstrumentToBasket`)
References involved: `auth` (Shopper Login / SLAS), `shopper-baskets-v2`

Combined scopes required: `sfcc.shopper-baskets-orders.rw`

Alternatively, configure your SLAS client with `sfcc.shopper-standard` — a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1 — Authenticate the shopper.** `authenticateCustomer` (`POST /oauth2/login`)

This uses the platform's built-in IDP, which is the OOTB default. The `authorizeCustomer` (`/oauth2/authorize`) federation path applies only if your instance has been explicitly configured with a custom IDP (Okta, Auth0, Google, etc.) — if that's not the case, the platform itself is the IDP and `authenticateCustomer` is correct.

- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/login`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- Required params: `code_challenge`, `channel_id`, `client_id`, `redirect_uri` (form-encoded); `Authorization: Basic base64(shopperUser:shopperPass)` header
- Produces: `303` redirect; `code` and `usid` extracted from the `Location` header
- Why: `addPaymentInstrumentToBasket` declares `ShopperToken` security — a shopper-identity bearer is required. The OOTB registered flow starts with `authenticateCustomer` to obtain the authorization code.

**Step 1b — Exchange code for shopper token.** `getAccessToken`

- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Required params: `grant_type=authorization_code_pkce`, `client_id`, `redirect_uri`, `code` (from step 1), `code_verifier`, `channel_id`, `usid`
- Produces: `access_token` (bearer token for all subsequent calls)
- Why: PKCE flow requires a separate token exchange leg; `access_token` is the bearer credential `addPaymentInstrumentToBasket` requires.

**Step 2 — Create a basket.** `createBasket`

- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- Produces: `Basket` → `basketId` (threaded into step 3)
- Why: `addPaymentInstrumentToBasket` requires `basketId` as a path parameter; `createBasket` is the canonical from-nothing producer (structural dependency).

**Step 3 — Add the payment instrument.** `addPaymentInstrumentToBasket`

- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/payment-instruments`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
- `basketId` threaded from step 2's response
- **Runtime-required body (curated, NOT stated in the spec).** The spec marks the request body optional, but a bodyless call 400s the null-Body constraint at runtime. Minimum working body:
  ```json
  {
    "paymentMethodId": "CREDIT_CARD",
    "paymentCard": { "cardType": "Visa" }
  }
  ```
  - `paymentMethodId`: required — the payment method (e.g. `CREDIT_CARD`); omitting it triggers the null-Body constraint
  - `paymentCard.cardType`: required — `paymentMethodId` alone adds nothing; `cardType` is the runtime-required card leaf
  - Provenance: runtime-verified on a live B2C Commerce sandbox (RefArch, v25_6, 2026-07-12). See https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail
command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# ---- Fill in your connection values ----
SHOPPER_USER=""              # registered shopper username
SHOPPER_PASS=""              # registered shopper password
CHANNEL_ID=""              # the channel id (typically equals SITE_ID)
CLIENT_ID=""              # your SLAS/OCAPI client id
REDIRECT_URI=""              # a redirect URI registered on the client
BASE_URL=""              # your instance API base, e.g. https://<short-code>.api.commercecloud.salesforce.com
ORGANIZATION_ID=""              # your org id, e.g. f_ecom_abcd_001
SITE_ID=""              # your site id, e.g. RefArch
: "${SHOPPER_USER:?fill in SHOPPER_USER above}" "${SHOPPER_PASS:?fill in SHOPPER_PASS above}" "${CHANNEL_ID:?fill in CHANNEL_ID above}" "${CLIENT_ID:?fill in CLIENT_ID above}" "${REDIRECT_URI:?fill in REDIRECT_URI above}" "${BASE_URL:?fill in BASE_URL above}" "${ORGANIZATION_ID:?fill in ORGANIZATION_ID above}" "${SITE_ID:?fill in SITE_ID above}"

# Reproduce: addPaymentInstrumentToBasket (reference: shopper-baskets-v2)
# Combined scopes required: sfcc.shopper-baskets-orders.rw

# Auth -- SLAS PKCE (public client)
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

# Auth leg 1 -- authenticateCustomer (registered B2C login)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
AUTH_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  -X POST \
  -H "Authorization: Basic $(printf '%s:%s' "${SHOPPER_USER}" "${SHOPPER_PASS}" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "code_challenge=${CODE_CHALLENGE}" \
  --data-urlencode "channel_id=${CHANNEL_ID}" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORGANIZATION_ID}/oauth2/login")
AUTH_CODE=$(printf '%s' "$AUTH_LOCATION" | grep -oE 'code=[^&]+' | cut -d= -f2)
USID=$(printf '%s' "$AUTH_LOCATION" | grep -oE 'usid=[^&]+' | cut -d= -f2)

# Auth leg 2 -- getAccessToken (exchange code for a shopper token)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
TOKEN_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORGANIZATION_ID}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code_pkce" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "code=${AUTH_CODE}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}" \
  --data-urlencode "channel_id=${CHANNEL_ID}" \
  --data-urlencode "usid=${USID}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)

# POST /organizations/{organizationId}/baskets  -- createBasket
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
CREATE_BASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json")

BASKET_ID=$(echo "$CREATE_BASKET_RESPONSE" | jq -r .basketId)

# POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments  -- addPaymentInstrumentToBasket
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
# ⚠ Runtime-required body (curated), NOT stated in the spec: this operation
#   needs the body below at runtime even though the spec marks it optional. This is
#   curated runtime knowledge. Provenance:
#   Runtime-verified on a live B2C Commerce sandbox (RefArch, v25_6, 2026-07-12): a bodyless addPaymentInstrumentToBasket 400s the null-Body constraint; {paymentMethodId:CREDIT_CARD, paymentCard:{cardType:Visa}} adds an instrument. cardType is required -- paymentMethodId alone adds nothing. General citation: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
#   - paymentMethodId: the payment method (e.g. CREDIT_CARD); a bodyless call 400s the null-Body constraint
#   - paymentCard.cardType: cardType is the runtime-required card leaf -- paymentMethodId alone adds nothing
ADD_PAYMENT_INSTRUMENT_TO_BASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "paymentMethodId": "CREDIT_CARD",
  "paymentCard": {
    "cardType": "Visa"
  }
}
JSON
)
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
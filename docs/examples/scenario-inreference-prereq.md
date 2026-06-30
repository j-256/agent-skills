## Prompt

> logged-in shopper -- what has to be done before addPaymentInstrumentToBasket will succeed? in order, with the scopes

Skill: `dsc-scenario`. Captured verbatim from fixture `synthesis-scenario-inreference-producer-pick` (`iteration-inreference-producer-pick`, run 1, Sonnet 4.6, strict-pass).

## Answer

## Scenario: Logged-in shopper adds a payment instrument to a basket

Target: `POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments`  (`shopper-baskets-v2.addPaymentInstrumentToBasket`)
References involved: Shopper Login (SLAS / `auth`), Shopper Baskets V2

```
Combined SLAS client scopes required:
  sfcc.shopper-baskets-orders.rw

Alternatively, configure your SLAS client with `sfcc.shopper-standard` — a meta-scope
that includes everything above plus 19 others. Simpler setup, broader permissions; both
are accepted by every operation in this plan.
```

---

## Plan

**Step 1 — Authenticate the registered shopper (`authenticateCustomer`).**

This uses the platform's built-in IDP, which is the OOTB default. The `authorizeCustomer` (`/oauth2/authorize`) federation path applies only if your instance has been explicitly configured with a custom IDP (Okta, Auth0, Google, etc.) — if that's not the case, the platform itself is the IDP and `authenticateCustomer` is correct.

- Method/path: `POST https://slas.commercecloud.salesforce.com/api/v1/organizations/{organizationId}/oauth2/login`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- Required params: `code_challenge`, `channel_id`, `client_id`, `redirect_uri`
- Authorization header: `Basic base64(shopperUserID:shopperPassword)` — the shopper's own credentials, not the SLAS client secret
- Produces: `303` redirect whose `Location` carries `code=<authorization_code>` and `usid=<usid>` as query params
- Why: `addPaymentInstrumentToBasket` declares `ShopperToken` security; SLAS registered-B2C flow is the OOTB path to obtain one.

**Step 1b — Exchange the authorization code for a shopper token (`getAccessToken`).**

- Method/path: `POST https://slas.commercecloud.salesforce.com/api/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Body: `grant_type=authorization_code_pkce`, `code=<from step 1 Location header>`, `code_verifier`, `client_id`, `redirect_uri`, `usid`
- Produces: `access_token` (the shopper JWT)
- Why: The authorization code from step 1 is single-use; this exchanges it for the bearer token all downstream calls require.

**Step 2 — Create a basket (`createBasket`).**

- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- Produces: `Basket` — including `basketId`
- Why: `addPaymentInstrumentToBasket` requires `basketId` in the path; `createBasket` is the structural producer of a new basket from nothing.

**Step 3 — Add the payment instrument (`addPaymentInstrumentToBasket`).** ← target

- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/payment-instruments?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
- Input: `basketId` from step 2 response
- Produces: updated `Basket`
- Why: `addPaymentInstrumentToBasket` requires `basketId` in the path; this step is the structural consumer of the basket created in step 2.

No explicit ordering constraint found beyond structural dependency — structural order only.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# PKCE setup
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

# Step 1 — authenticateCustomer (registered B2C, platform IDP)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
LOGIN_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' -X POST \
  "https://slas.commercecloud.salesforce.com/api/v1/organizations/${ORGANIZATION_ID}/oauth2/login" \
  -H "Authorization: Basic $(printf '%s:%s' "$SHOPPER_USER_ID" "$SHOPPER_PASSWORD" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code_challenge=${CODE_CHALLENGE}&channel_id=${CHANNEL_ID}&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}")

AUTH_CODE=$(echo "$LOGIN_LOCATION" | grep -o 'code=[^&]*' | cut -d= -f2)
USID=$(echo "$LOGIN_LOCATION" | grep -o 'usid=[^&]*' | cut -d= -f2)

# Step 1b — getAccessToken
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
TOKEN_RESPONSE=$(curl -sS -X POST \
  "https://slas.commercecloud.salesforce.com/api/v1/organizations/${ORGANIZATION_ID}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code_pkce&code=${AUTH_CODE}&code_verifier=${CODE_VERIFIER}&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&usid=${USID}")

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)

# Step 2 — createBasket
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
CREATEBASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json")

BASKET_ID=$(echo "$CREATEBASKET_RESPONSE" | jq -r .basketId)

# Step 3 — addPaymentInstrumentToBasket  (target)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"amount": 0, "paymentMethodId": "CREDIT_CARD"}'

# ----------------------------------------------------------
# Placeholders:
#   BASE_URL:         e.g. https://zz00-001.dx.commercecloud.salesforce.com
#   ORGANIZATION_ID:  your org ID (f_ecom_...)
#   SITE_ID:          your site ID (e.g. RefArch)
#   CLIENT_ID:        your SLAS public client ID
#   REDIRECT_URI:     your registered redirect URI
#   CHANNEL_ID:       your channel ID (typically same as SITE_ID)
#   SHOPPER_USER_ID:  the shopper's login (email or username)
#   SHOPPER_PASSWORD: the shopper's password
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket

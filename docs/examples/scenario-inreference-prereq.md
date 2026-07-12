## Prompt

> logged-in shopper -- what has to be done before addPaymentInstrumentToBasket will succeed? in order, with the scopes

Skill: `dsc-scenario`. Captured verbatim from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-inreference-producer-pick` (run 1 of `iteration-honest-trophies`, Sonnet, strict-pass 5/5), then executed against a live B2C Commerce sandbox (site `RefArch`, API `v25_6`) with a registered test shopper.

**What the renderer emits (deterministic, relayed verbatim):** the SLAS registered auth legs, the `createBasket` call, and the target `addPaymentInstrumentToBasket` call shape with its `${BASKET_ID}` threaded from the basket response and `?siteId=` present.

**What the caller supplies (edited in, disclosed):** the target op has no structural body input and no submittability entry, so the renderer correctly does not invent its request payload. The `addPaymentInstrumentToBasket` body `{"paymentMethodId":"CREDIT_CARD","paymentCard":{"cardType":"Visa"}}` is added here, the same way you would supply any endpoint payload; it was verified live to add an instrument (`cardType` is required – `paymentMethodId` alone adds nothing, which is why the older hand-authored `{amount:0,paymentMethodId:CREDIT_CARD}` body silently added nothing).

This scenario's target is `addPaymentInstrumentToBasket`, NOT order submission – so the honest success signal is a returned basket carrying a `paymentInstruments[]` entry, not an `orderNo`. The only other addition is a trailing `jq` display line surfacing the captured response.

## Answer

---

## Scenario: Logged-in shopper adds a payment instrument to a basket

Target: `POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments`  (`shopper-baskets-v2.addPaymentInstrumentToBasket`)
References involved: Shopper Login (SLAS) (`auth`), Shopper Baskets V2 (`shopper-baskets-v2`)

Combined scopes required: `sfcc.shopper-baskets-orders.rw`

Alternatively, configure your SLAS client with `sfcc.shopper-standard` — a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1 — Obtain a SLAS shopper token (`authenticateCustomer`).**

This uses the platform's built-in IDP, which is the OOTB default. The `authorizeCustomer` (`/oauth2/authorize`) federation path applies only if your instance has been explicitly configured with a custom IDP (Okta, Auth0, Google, etc.) — if that's not the case, the platform itself is the IDP and `authenticateCustomer` is correct.

- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/login`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- Produces: PKCE `code` + `usid` (in the `303` `Location` redirect URL)
- Why: `addPaymentInstrumentToBasket` requires a `ShopperToken`-scheme bearer; this leg acquires it via PKCE for the registered shopper. The `303` Location carries the `code` — not a JSON body; the capture reads the redirect URL.

**Step 1b — Exchange code for access token (`getAccessToken`).**

- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token` (shopper bearer)
- Why: Exchanges the PKCE authorization code from step 1 for a bearer token. `grant_type=authorization_code_pkce`, threading `code`, `code_verifier`, `usid`, `channel_id`.

**Step 2 — Create a basket (`createBasket`).**

- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- Produces: `Basket` → `basketId`
- Why: `addPaymentInstrumentToBasket` requires `basketId` as a path parameter; `createBasket` produces it from nothing (structural dependency).

**Step 3 — Add the payment instrument (`addPaymentInstrumentToBasket`). ← target**

- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/payment-instruments`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
- Produces: updated `Basket`
- Why: The target operation. `basketId` threads from step 2's response.

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
ADD_PAYMENT_INSTRUMENT_TO_BASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethodId": "CREDIT_CARD", "paymentCard": {"cardType": "Visa"}}')

echo "$ADD_PAYMENT_INSTRUMENT_TO_BASKET_RESPONSE" | jq -c '{paymentInstruments: [.paymentInstruments[]? | {paymentMethodId, paymentInstrumentId}]}'
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket

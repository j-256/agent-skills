## Prompt

> target op is `shopper-orders.createOrder`. what are the prerequisites -- which calls have to happen first and where does the basketId come from?

Skill: `dsc-scenario`. Captured verbatim from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-createorder-basketid-threading` (`iteration-honest-trophies`, Sonnet, strict-pass), executed against a live B2C Commerce sandbox (RefArch, v25_6). Everything below `## Answer` is byte-for-byte as the skill composed it; the only edits permitted are scrubbing the sandbox instance to a placeholder and dropping a leading reasoning preamble.

## Answer (verbatim skill output)

## Scenario: Guest shopper creates an order from a prepared basket

**Target:** `POST /organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
**References involved:** auth (Shopper Login / SLAS), shopper-baskets-v2, shopper-orders

**Combined scopes required:** `sfcc.shopper-baskets-orders.rw`

Alternatively, configure your SLAS client with `sfcc.shopper-standard` — a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1. Authorize the shopper (guest).** `authorizeCustomer`
- Method/path: `GET /shopper/auth/v1/organizations/{organizationId}/oauth2/authorize?hint=guest&...`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- Produces: a `303` redirect whose `Location` header carries `code=<authorizationCode>` and `usid=<usid>`
- Why: `getAccessToken` (step 2) requires an authorization code; the spec declares a `authorization_code_pkce` grant which requires a prior `/authorize` leg to produce it.

**Step 2. Exchange the code for a shopper access token.** `getAccessToken`
- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token` (bearer token for all subsequent calls)
- Why: `createBasket` and `createOrder` both declare `ShopperToken` security; a valid shopper bearer is required.

**Step 3. Create a populated basket.** `createBasket` (shopper-baskets-v2)
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- Produces: `Basket` — response `.basketId` is threaded into `createOrder`'s request body.
- Why (structural): `createOrder` requires a `basketId` in the request body; `createBasket` is the canonical from-nothing producer of a `Basket`.
- Why (checkout business-rule — curated, not stated in the spec): `createBasket` always returns 200 and never enforces submittability — the entire required-set is gated at `createOrder`. The spec's `Basket.required` is `null` and the basket-prep prose states no hard required-set. The basket body **must be populated** for `createOrder` to accept it; this is empirically-verified runtime knowledge. Each field below causes a distinct 400 if absent:
  - `productItems` — `createOrder` returns 400 "Product Items Required"
  - `shipments[].shippingMethod` — `createOrder` returns 400 "Order total missing, calculation failed"
  - `shipments[].shippingAddress` — `createOrder` returns 400 "Empty Shipping Address"
  - `billingAddress` (firstName + lastName required) — 400 "Empty Billing Address" / "Invalid Billing Address"
  - `paymentInstruments[].paymentMethodId` + `paymentCard.cardType` — 400 "Missing Payment Method Id" / "Invalid Payment Method Id" (`cardType` is the only required `paymentCard` leaf for `CREDIT_CARD`; `holder`, `expirationMonth`, `expirationYear` are above the minimum)

  Provenance: drop-one verified on realm `abcd_001`, site `RefArch`, API `v25_6` on 2026-07-11. See https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

**Step 4. Submit the order.** `createOrder` ← target
- Method/path: `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Produces: `Order`
- Why: target operation; `basketId` from step 3's response is the only required body field.

---

**Where `basketId` comes from:** `createBasket` returns it at the top level of the response (`$.basketId`). The runnable captures it as `BASKET_ID=$(echo "$CREATE_BASKET_RESPONSE" | jq -r .basketId)` and passes it as `{"basketId": "${BASKET_ID}"}` to `createOrder`. There is no separate "get basket" call — the id comes straight from the create response.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail
command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# ---- Fill in your connection values ----
BASE_URL=""              # your instance API base, e.g. https://<short-code>.api.commercecloud.salesforce.com
ORGANIZATION_ID=""              # your org id, e.g. f_ecom_abcd_001
CLIENT_ID=""              # your SLAS/OCAPI client id
REDIRECT_URI=""              # a redirect URI registered on the client
SITE_ID=""              # your site id, e.g. RefArch
PRODUCT_ID=""              # supply from your environment (no structural producer found)
SHIPPING_METHOD_ID=""              # supply from your environment (no structural producer found)
: "${BASE_URL:?fill in BASE_URL above}" "${ORGANIZATION_ID:?fill in ORGANIZATION_ID above}" "${CLIENT_ID:?fill in CLIENT_ID above}" "${REDIRECT_URI:?fill in REDIRECT_URI above}" "${SITE_ID:?fill in SITE_ID above}" "${PRODUCT_ID:?fill in PRODUCT_ID above}" "${SHIPPING_METHOD_ID:?fill in SHIPPING_METHOD_ID above}"

# Reproduce: createOrder (reference: shopper-orders)
# Combined scopes required: sfcc.shopper-baskets-orders.rw

# Auth -- SLAS PKCE (public client)
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

# Auth leg 1 -- authorizeCustomer (hint=guest)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
AUTH_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORGANIZATION_ID}/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&hint=guest&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256")
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
  --data-urlencode "channel_id=${SITE_ID}" \
  --data-urlencode "usid=${USID}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)

# POST /organizations/{organizationId}/baskets  -- createBasket
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
# ⚠ Checkout business-rule (curated), NOT stated in the spec: Basket must be populated
#   below for the target to accept it. The spec enumerates no required-set; this is
#   curated runtime knowledge.
#   - productItems: at least one line item; createOrder returns 400 "Product Items Required" otherwise
#   - shipments[].shippingMethod: a shipping method on the default shipment (id "me"); without it createOrder returns 400 Validation "Order total missing, calculation failed"
#   - shipments[].shippingAddress: a shipping address on the shipment; createOrder returns 400 "Empty Shipping Address" otherwise
#   - billingAddress: a billing address with both first and last name; createOrder returns 400 "Empty Billing Address" / "Invalid Billing Address"
#   - paymentInstruments: a payment instrument (e.g. paymentMethodId CREDIT_CARD); createOrder returns 400 "Missing Payment Method Id" without one
CREATE_BASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "productItems": [
    {
      "productId": "${PRODUCT_ID}",
      "quantity": 1
    }
  ],
  "shipments": [
    {
      "shippingMethod": {
        "id": "${SHIPPING_METHOD_ID}"
      },
      "shippingAddress": {
        "firstName": "Jane",
        "lastName": "Doe",
        "address1": "1 Market St",
        "city": "San Francisco",
        "stateCode": "CA",
        "postalCode": "94105",
        "countryCode": "US"
      }
    }
  ],
  "billingAddress": {
    "firstName": "Jane",
    "lastName": "Doe",
    "address1": "1 Market St",
    "city": "San Francisco",
    "stateCode": "CA",
    "postalCode": "94105",
    "countryCode": "US"
  },
  "paymentInstruments": [
    {
      "paymentMethodId": "CREDIT_CARD",
      "paymentCard": {
        "cardType": "Visa"
      }
    }
  ]
}
JSON
)

BASKET_ID=$(echo "$CREATE_BASKET_RESPONSE" | jq -r .basketId)

# POST /organizations/{organizationId}/orders  -- createOrder
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
CREATE_ORDER_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORGANIZATION_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "basketId": "${BASKET_ID}"
}
JSON
)
```

---

## Sources
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

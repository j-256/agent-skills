## Prompt

> i need to repro a registered shopper adding a promo coupon to their basket and checking out -- on an instance. which SCAPI calls do i need in what order, and which scopes must the SLAS client have

Skill: `dsc-scenario`. Captured verbatim from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-add-coupon-checkout` (`iteration-honest-trophies`, Sonnet, strict-pass), executed against a live B2C Commerce sandbox (RefArch, v25_6). Everything below `## Answer` is byte-for-byte as the skill composed it; the only edits permitted are scrubbing the sandbox realm to a placeholder and dropping a leading reasoning preamble (this capture had one).

## Answer (verbatim skill output)

## Scenario: Registered shopper adds a promo coupon to their basket and checks out

Target: `POST /organizations/{organizationId}/orders`  (`shopper-orders.createOrder`)  
References involved: `auth` (Shopper Login / SLAS), `shopper-baskets-v2`, `shopper-orders`

**Combined SLAS client scopes required: `sfcc.shopper-baskets-orders.rw`**

Alternatively, configure your SLAS client with `sfcc.shopper-standard` — a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1 — Authenticate the registered shopper (SLAS leg 1: `authenticateCustomer`).**

> This uses the platform's built-in IDP, which is the OOTB default. The `authorizeCustomer` (`/oauth2/authorize`) federation path applies only if your instance has been explicitly configured with a custom IDP (Okta, Auth0, Google, etc.) — if that's not the case, the platform itself is the IDP and `authenticateCustomer` is correct.

- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/login`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- Produces: `code` + `usid` (extracted from the `303` `Location` redirect header)
- Why: Authenticates the shopper against the platform IDP using their B2C credentials (`Authorization: Basic base64(user:pass)`). Required params: `code_challenge`, `channel_id`, `client_id`, `redirect_uri`. The authorization code lives in the `303` `Location` header — there is no JSON body on this response.

**Step 1b — Exchange the code for a shopper access token (SLAS leg 2: `getAccessToken`).**
- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token`
- Why: `createBasket`, `addCouponToBasket`, and `createOrder` all require `Authorization: Bearer <access_token>` (scheme `ShopperToken`); this is the PKCE `authorization_code_pkce` exchange that produces it.

**Step 2 — Create and populate the basket (`createBasket`).**
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- Produces: `Basket` → `basketId` (threaded to steps 3 and 4)
- Why: `createOrder` requires a `basketId`; this step produces it. The basket body must be populated at create — `createBasket` always returns 200 and never enforces submittability; the entire required-set is gated at `createOrder`. This is curated runtime knowledge, not stated in the spec (`Basket.required` is `null`):
  - `productItems` — at least one line item; `createOrder` returns 400 "Product Items Required" without one
  - `shipments[].shippingMethod` — `createOrder` returns 400 "Order total missing, calculation failed" if absent (shipping cost is an order-total component)
  - `shipments[].shippingAddress` — `createOrder` returns 400 "Empty Shipping Address" without one
  - `billingAddress` (with `firstName` + `lastName`) — `createOrder` returns 400 "Empty Billing Address" / "Invalid Billing Address" without it
  - `paymentInstruments[].paymentMethodId` + `paymentCard.cardType` — `createOrder` returns 400 "Missing Payment Method Id" / "Invalid Payment Method Id" without them (`cardType` is the only required `paymentCard` leaf — verified drop-one on realm abcd_001, RefArch v25_6, 2026-07-11)

**Step 3 — Apply the promo coupon to the basket (`addCouponToBasket`).**
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/coupons`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addCouponToBasket
- Produces: updated `Basket` (coupon applied, totals recalculated)
- Why: User-requested business-logic step. The coupon must be applied before `createOrder` so the order total reflects the promotion. No explicit ordering constraint stated in the spec — structural placement is before `createOrder` by logical necessity (the basket is locked once `createOrder` consumes it). Body: `{"code": "<COUPON_CODE>"}`.

**Step 4 — Submit the basket as an order (`createOrder`).**
- Method/path: `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Produces: `Order`
- Why: `basketId` (from step 2) is the only structural input; the basket must already be populated (step 2) and the coupon applied (step 3) before this call.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail
command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# ---- Fill in your connection values ----
SHOPPER_USER=""              # registered shopper username
SHOPPER_PASS=""              # registered shopper password
CHANNEL_ID=""                # the channel id (typically equals SITE_ID)
CLIENT_ID=""                 # your SLAS/OCAPI client id
REDIRECT_URI=""              # a redirect URI registered on the client
BASE_URL=""                  # your instance API base, e.g. https://<short-code>.api.commercecloud.salesforce.com
ORGANIZATION_ID=""           # your org id, e.g. f_ecom_abcd_001
SITE_ID=""                   # your site id, e.g. RefArch
PRODUCT_ID=""                # supply from your environment (no structural producer found)
SHIPPING_METHOD_ID=""        # supply from your environment (no structural producer found)
COUPON_CODE=""               # the promo coupon code to apply
: "${SHOPPER_USER:?fill in SHOPPER_USER above}" "${SHOPPER_PASS:?fill in SHOPPER_PASS above}" \
  "${CHANNEL_ID:?fill in CHANNEL_ID above}" "${CLIENT_ID:?fill in CLIENT_ID above}" \
  "${REDIRECT_URI:?fill in REDIRECT_URI above}" "${BASE_URL:?fill in BASE_URL above}" \
  "${ORGANIZATION_ID:?fill in ORGANIZATION_ID above}" "${SITE_ID:?fill in SITE_ID above}" \
  "${PRODUCT_ID:?fill in PRODUCT_ID above}" "${SHIPPING_METHOD_ID:?fill in SHIPPING_METHOD_ID above}" \
  "${COUPON_CODE:?fill in COUPON_CODE above}"

# Reproduce: registered shopper adds promo coupon + checkout
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

# POST /organizations/{organizationId}/baskets  -- createBasket (populated for submittability)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
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

# POST /organizations/{organizationId}/baskets/{basketId}/coupons  -- addCouponToBasket
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addCouponToBasket
ADD_COUPON_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets/${BASKET_ID}/coupons?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"code\": \"${COUPON_CODE}\"}")

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
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addCouponToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**Scope summary:** Your SLAS client needs exactly one scope: `sfcc.shopper-baskets-orders.rw`. It covers basket writes (create + coupon), order creation, and the reads implied by `.rw`. The `sfcc.shopper-standard` meta-scope is a drop-in superset if you want to avoid enumerating individual scopes.

**Two fill-in values you'll need from your instance before running:**
- `PRODUCT_ID` — any active product id on your catalog (e.g. from Business Manager or a search call)
- `SHIPPING_METHOD_ID` — an applicable shipping method id for the site (e.g. from `getShippingMethodsForShipment` on the baskets reference, or Business Manager)

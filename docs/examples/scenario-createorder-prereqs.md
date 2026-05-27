## Prompt

> target op is `shopper-orders.createOrder`. what are the prerequisites -- which calls have to happen first and where does the basketId come from?

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-createorder-basketid-threading` (run 5 of `iteration-auth-routing-baseline`).

## Answer

---

## Scenario: Guest shopper creates an order from a basket

**Target:** POST `/organizations/{organizationId}/orders` — `shopper-orders.createOrder`
**References involved:** `auth` (Shopper Login / SLAS), `shopper-baskets`, `shopper-orders`

**Combined SLAS client scopes required:**
```
sfcc.shopper-baskets-orders.rw
```
Alternatively, configure your SLAS client with `sfcc.shopper-standard` — a meta-scope that expands to include this scope plus 17 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1 — Obtain a SLAS guest access token.**
`auth.authorizeCustomer` → `auth.getAccessToken` (SLAS guest + public client + PKCE)

- 1a. `GET /oauth2/authorize?hint=guest&...` → `code` (authorization code)
- 1b. `POST /oauth2/token` with `grant_type=authorization_code_pkce` → `access_token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer and https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token` (bearer token passed as `Authorization: Bearer` on every subsequent call)

**Step 2 — Create a basket.**
`shopper-baskets.createBasket`

- Method/path: `POST /organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- Produces: `basketId` (top-level field in the `Basket` response object)
- Why: `createOrder` requires a `basketId` in the request body; the `Basket` type is produced by this operation's 201 response. No producer for `basketId` exists in the `shopper-orders` reference itself — it must come from here.

**Step 3 — Add at least one product line item.**
`shopper-baskets.addItemToBasket`

- Method/path: `POST /organizations/{organizationId}/baskets/{basketId}/items`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- Produces: updated `Basket` (confirms item is in basket)
- Why: `createOrder` requires a basket with product items; submitting an empty basket returns a fault. Structural ordering — the basket must have items before `createOrder` is called.

**Step 4 — Set billing address.**
`shopper-baskets.updateBillingAddressForBasket`

- Method/path: `PUT /organizations/{organizationId}/baskets/{basketId}/billing-address`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- Produces: updated `Basket`
- Why: `createOrder` requires a billing address on the basket. Structural — no explicit ordering prose found; placement follows standard checkout sequence.

**Step 5 — Set shipping address on the default shipment.**
`shopper-baskets.updateShippingAddressForShipment`

- Method/path: `PUT /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- Produces: updated `Basket`
- Why: A shipment with a shipping address is required before a shipping method can be selected, and before `createOrder` will accept the basket. `shipmentId` for the default shipment is `"me"` — the platform alias for the default shipment.

**Step 6 — Select a shipping method.**
`shopper-baskets.updateShippingMethodForShipment`

- Method/path: `PUT /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- Produces: updated `Basket` (with `shippingMethod` and tax/totals recalculated)
- Why: `createOrder` requires a shipping method set on every shipment. Structural — no explicit ordering prose; follows address step because `getShippingMethodsForShipment` filters by address.

**Step 7 — Add a payment instrument.**
`shopper-baskets.addPaymentInstrumentToBasket`

- Method/path: `POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- Produces: updated `Basket` (with `paymentInstruments[]`)
- Why: `createOrder` requires at least one payment instrument covering the order total. Structural — no explicit ordering prose.

**Step 8 — Create the order.**
`shopper-orders.createOrder`

- Method/path: `POST /organizations/{organizationId}/orders`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Produces: `Order` (with `orderNo`, status, etc.)
- Why: Target operation. Body contains `{"basketId": "<value from Step 2>"}`. The platform atomically converts the basket to an order; the basket is consumed and no longer accessible after this call.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

# Placeholders — set before running:
#   BASE_URL         e.g. https://zz00-001.dx.commercecloud.salesforce.com
#   ORG_ID           e.g. f_ecom_zz00_001
#   SITE_ID          e.g. RefArch
#   CLIENT_ID        your SLAS public client ID
#   CODE_VERIFIER    random 43–128 char string (PKCE)
#   CODE_CHALLENGE   base64url(SHA-256(CODE_VERIFIER))

# Step 1a — SLAS authorize (guest)
echo "Step 1a: authorize guest..."
AUTH_RESPONSE=$(curl -sS -w "\n%{http_code}" \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/authorize?response_type=code&hint=guest&client_id=${CLIENT_ID}&redirect_uri=https%3A%2F%2Flocalhost&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256" \
  -D - -o /dev/null)
# The 303 redirect Location header contains ?code=...
AUTH_CODE=$(echo "$AUTH_RESPONSE" | grep -i '^location:' | sed 's/.*[?&]code=\([^&]*\).*/\1/' | tr -d '\r')
echo "Got code: ${AUTH_CODE}"

# Step 1b — SLAS token exchange
echo "Step 1b: exchange code for token..."
TOKEN_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code_pkce&code=${AUTH_CODE}&redirect_uri=https%3A%2F%2Flocalhost&client_id=${CLIENT_ID}&code_verifier=${CODE_VERIFIER}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | node -e "process.stdin.resume();let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>console.log(JSON.parse(b).access_token))")
echo "Got access_token."

# Step 2 — Create basket
echo "Step 2: create basket..."
BASKET=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}')
BASKET_ID=$(echo "$BASKET" | node -e "process.stdin.resume();let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>console.log(JSON.parse(b).basketId))")
echo "basketId: ${BASKET_ID}"

# Step 3 — Add item
echo "Step 3: add item..."
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '[{"productId":"<PRODUCT_ID>","quantity":1}]' | node -e "process.stdin.resume();let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=JSON.parse(b);console.log('items:',r.productItems?.length)})"

# Step 4 — Set billing address
echo "Step 4: billing address..."
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/billing-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"100 Commerce St","city":"Burlington","stateCode":"MA","postalCode":"01803","countryCode":"US"}' > /dev/null
echo "Billing address set."

# Step 5 — Set shipping address (default shipment = "me")
echo "Step 5: shipping address..."
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"100 Commerce St","city":"Burlington","stateCode":"MA","postalCode":"01803","countryCode":"US"}' > /dev/null
echo "Shipping address set."

# Step 6 — Select shipping method
# First, discover available methods:
# GET ${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-methods?siteId=${SITE_ID}
echo "Step 6: shipping method..."
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"id":"<SHIPPING_METHOD_ID>"}' > /dev/null
echo "Shipping method set."

# Step 7 — Add payment instrument
echo "Step 7: payment instrument..."
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"amount":<ORDER_TOTAL>,"paymentMethodId":"<PAYMENT_METHOD_ID>"}' > /dev/null
echo "Payment instrument added."

# Step 8 — Create order  ← the target
echo "Step 8: createOrder..."
ORDER=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\":\"${BASKET_ID}\"}")
echo "$ORDER" | node -e "process.stdin.resume();let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const r=JSON.parse(b);console.log('orderNo:',r.orderNo,'status:',r.status)})"

# ----------------------------------------------------------
# Remaining placeholders:
#   PRODUCT_ID          a product master or variant ID active in your catalog
#   SHIPPING_METHOD_ID  from getShippingMethodsForShipment response (e.g. "001")
#   ORDER_TOTAL         match the basket's order total
#   PAYMENT_METHOD_ID   a method active on your site (e.g. "CREDIT_CARD", "DW_APPLE_PAY")
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**Where `basketId` comes from:** `shopper-baskets.createBasket` (Step 2) returns a `Basket` object; the `basketId` field in that response is passed verbatim as the body of `createOrder`. There is no `basketId` producer anywhere in the `shopper-orders` reference — the basket must exist before you ever touch `shopper-orders`.

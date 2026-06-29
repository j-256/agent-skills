## Prompt

> i need to repro a registered shopper adding a promo coupon to their basket and checking out -- on an instance. which SCAPI calls do i need in what order, and which scopes must the SLAS client have

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-add-coupon-checkout` (run 1 of `iteration-runnable-jq`, Sonnet 4.6, strict-pass), then updated to the `shopper-baskets-v2` reference under `iteration-prefer-latest-reference-version` (the skill now defaults to the latest reference version; v2 is a documented superset of v1 with identical operation slugs and paths, so the only changes are the basket reference's citations and `/checkout/shopper-baskets/v2/` path segments – confirmed against a strict-passing v2 capture from that iteration). Verbatim except the Step 10 payment-card body: the raw capture used `creditCardNumber` / `securityCode`, which aren't fields on the spec's `OrderPaymentCardRequest` type (valid card fields are `cardType`, `creditCardToken`, `maskedNumber`, `expirationMonth/Year`, `holder`, …) – corrected to the tokenized `creditCardToken` form. Every spec quote and operation verified against the live scrape cache.

## Answer

---

## Scenario: Registered shopper adds a promo coupon and checks out

**Target:** POST `/organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
**References involved:** auth (Shopper Login / SLAS), shopper-baskets-v2, shopper-orders
**Combined SLAS client scopes required:** `sfcc.shopper-baskets-orders.rw`

> Alternatively, configure your SLAS client with `sfcc.shopper-standard` – a meta-scope that includes `sfcc.shopper-baskets-orders.rw` plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1. Obtain a PKCE code via `authenticateCustomer` (B2C login).**
`auth.authenticateCustomer`
- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/login`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- Produces: authorization `code` (in the `Location` redirect header), `usid`
- Why: This uses the platform's built-in IDP, which is the OOTB default. The `authorizeCustomer` (`/oauth2/authorize`) federation path applies only if your instance has been explicitly configured with a custom IDP (Okta, Auth0, etc.) – if that's not the case, the platform itself is the IDP and `authenticateCustomer` is correct.
  Required params per description: `code_challenge`, `channel_id`, `client_id`, `redirect_uri`; `Authorization: Basic base64(shopperUserID:shopperPassword)` header (the *shopper's* credentials, not the client secret).

**Step 2. Exchange code for a shopper access token via `getAccessToken`.**
`auth.getAccessToken`
- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token` (shopper JWT), `refresh_token`
- Why: `createOrder` (and every Shopper Baskets operation) declares `ShopperToken` security; the bearer token must be obtained before any basket call can succeed. `grant_type=authorization_code_pkce`; pass `code` (from Step 1 `Location` header), `code_verifier`, `client_id`, `redirect_uri`.

**Step 3. Create a basket via `createBasket`.**
`shopper-baskets-v2.createBasket`
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- Produces: `basketId`, default shipment with `shipmentId: "me"`
- Why: `createOrder` description states "Submits an order based on a prepared basket. The only considered value from the request body is basketId." – `basketId` must exist before `createOrder` can be called. Structural producer for `basketId`.

**Step 4. Add at least one item via `addItemToBasket`.**
`shopper-baskets-v2.addItemToBasket`
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/items?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addItemToBasket
- Produces: updated basket with line items
- Why: A coupon applied to an empty basket may not evaluate correctly and `createOrder` will fail without purchasable items. No explicit ordering constraint in spec prose – structural requirement; `basketId` produced by Step 3.

**Step 5. Apply the promo coupon via `addCouponToBasket`.**
`shopper-baskets-v2.addCouponToBasket`
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/coupons?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addCouponToBasket
- Produces: updated basket with `couponItems[]` (coupon `statusCode`, `valid` flag)
- Why: `basketId` consumed from Step 3 response. Body: `{"code": "<your-promo-code>"}` (a `CouponItem` object – only `code` is required). No explicit ordering constraint – structural; must come after basket exists.

**Step 6. Get available shipping methods via `getShippingMethodsForShipment`.**
`shopper-baskets-v2.getShippingMethodsForShipment`
- Method/path: `GET /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-methods?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=getShippingMethodsForShipment
- Produces: `applicableShippingMethods[0].id` (the shipping method ID to pass to Step 7)
- Why: `updateShippingMethodForShipment` requires a valid `shippingMethodId`; this call provides the list of accepted values. Structural producer. Use `shipmentId=me` (default shipment from Step 3).

**Step 7. Set a shipping method via `updateShippingMethodForShipment`.**
`shopper-baskets-v2.updateShippingMethodForShipment`
- Method/path: `PUT /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateShippingMethodForShipment
- Produces: updated basket with shipping costs applied
- Why: `createOrder` requires a fully-prepared basket; a basket without a shipping method set will be rejected at order submission. No explicit doc constraint – structural; `shipmentId` from Step 3.

**Step 8. Set a shipping address via `updateShippingAddressForShipment`.**
`shopper-baskets-v2.updateShippingAddressForShipment`
- Method/path: `PUT /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateShippingAddressForShipment
- Produces: updated basket with shipping address
- Why: Required to make the basket "prepared" for order submission. No explicit prose constraint – structural ordering.

**Step 9. Set a billing address via `updateBillingAddressForBasket`.**
`shopper-baskets-v2.updateBillingAddressForBasket`
- Method/path: `PUT /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/billing-address?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateBillingAddressForBasket
- Produces: updated basket with billing address
- Why: Structural; required before payment instrument and order submission.

**Step 10. Add a payment instrument via `addPaymentInstrumentToBasket`.**
`shopper-baskets-v2.addPaymentInstrumentToBasket`
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets/{basketId}/payment-instruments?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
- Produces: updated basket with payment instrument
- Why: `createOrder` description says "prepared basket"; a basket without a payment instrument will be rejected. Structural; `basketId` from Step 3.

**Step 11. Submit the order via `createOrder`.**
`shopper-orders.createOrder`
- Method/path: `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Produces: `Order` object with `orderNo`, `status`, `couponItems[]` (verify `valid: true`), `customerInfo`
- Why: Target operation. Description: "Submits an order based on a prepared basket. The only considered value from the request body is basketId." – body is `{"basketId": "<basketId>"}`.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# -- Placeholders --
# BASE_URL       e.g. https://zz00-001.api.commercecloud.salesforce.com
# SHORT_CODE     e.g. zz00
# ORG_ID         e.g. f_ecom_zz00_001
# SITE_ID        e.g. RefArch
# CLIENT_ID      your SLAS public client ID
# REDIRECT_URI   a redirect URI registered on the SLAS client (e.g. http://localhost:3000/callback)
# CHANNEL_ID     typically equals SITE_ID
# SHOPPER_USER   registered shopper username
# SHOPPER_PASS   registered shopper password
# PROMO_CODE     the promo/coupon code to apply
# PRODUCT_ID     a product ID to add to the basket
# SHIPPING_METHOD_ID  leave blank to auto-pick from Step 6 output

# -- Step 1: PKCE setup --
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

# -- Step 1: authenticateCustomer (registered B2C login) --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
LOGIN_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  -X POST "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/login" \
  -H "Authorization: Basic $(printf '%s:%s' "$SHOPPER_USER" "$SHOPPER_PASS" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "code_challenge=${CODE_CHALLENGE}" \
  --data-urlencode "channel_id=${CHANNEL_ID}" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}")

AUTH_CODE=$(printf '%s' "$LOGIN_LOCATION" | grep -oE 'code=[^&]+' | cut -d= -f2)
USID=$(printf '%s' "$LOGIN_LOCATION" | grep -oE 'usid=[^&]+' | cut -d= -f2)
echo "auth code: $AUTH_CODE  usid: $USID"

# -- Step 2: getAccessToken --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
TOKEN_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code_pkce" \
  --data-urlencode "code=${AUTH_CODE}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "usid=${USID}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)
echo "access token: ${ACCESS_TOKEN:0:40}..."

# -- Step 3: createBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
BASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}')
BASKET_ID=$(echo "$BASKET_RESPONSE" | jq -r .basketId)
echo "basketId: $BASKET_ID"

# -- Step 4: addItemToBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addItemToBasket
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}]" | jq .

# -- Step 5: addCouponToBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addCouponToBasket
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets/${BASKET_ID}/coupons?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"${PROMO_CODE}\"}" | jq '{couponItems: .couponItems}'

# -- Step 6: getShippingMethodsForShipment --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=getShippingMethodsForShipment
SHIPPING_RESPONSE=$(curl -sS \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-methods?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")
SHIPPING_METHOD_ID=$(echo "$SHIPPING_RESPONSE" | jq -r '.applicableShippingMethods[0].id')
echo "using shipping method: $SHIPPING_METHOD_ID"

# -- Step 7: updateShippingMethodForShipment --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateShippingMethodForShipment
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"${SHIPPING_METHOD_ID}\"}" | jq '{shippingTotal: .shippingTotal}' 2>/dev/null || true

# -- Step 8: updateShippingAddressForShipment --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateShippingAddressForShipment
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"123 Main St","city":"San Francisco","stateCode":"CA","postalCode":"94105","countryCode":"US","phone":"4155550100"}' \
  | jq .shipments 2>/dev/null || true

# -- Step 9: updateBillingAddressForBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateBillingAddressForBasket
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets/${BASKET_ID}/billing-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"123 Main St","city":"San Francisco","stateCode":"CA","postalCode":"94105","countryCode":"US","phone":"4155550100"}' \
  | jq .billingAddress 2>/dev/null || true

# -- Step 10: addPaymentInstrumentToBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
# Card data uses a tokenized creditCardToken; the spec's OrderPaymentCardRequest does not accept a raw PAN.
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethodId":"CREDIT_CARD","amount":0,"paymentCard":{"cardType":"Visa","creditCardToken":"<tokenized-card>","expirationMonth":12,"expirationYear":2030,"holder":"Test Shopper"}}' \
  | jq .paymentInstruments 2>/dev/null || true

# -- Step 11: createOrder --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
ORDER_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\":\"${BASKET_ID}\"}")
ORDER_NO=$(echo "$ORDER_RESPONSE" | jq -r .orderNo)
echo "Order submitted: $ORDER_NO"
echo "$ORDER_RESPONSE" | jq '{orderNo, status, couponItems, customerInfo}'
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addCouponToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=getShippingMethodsForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateShippingAddressForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=updateBillingAddressForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**Scope summary:** Your SLAS client needs exactly `sfcc.shopper-baskets-orders.rw` (covers both the basket writes and the order submit). If you'd rather keep client config simple, `sfcc.shopper-standard` is a superset that covers everything here.

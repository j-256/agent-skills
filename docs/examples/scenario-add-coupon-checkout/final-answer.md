---

## Scenario: Registered shopper adds a promo coupon to basket and checks out

**Target:** `POST /organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
**References involved:** `auth` (SLAS), `shopper-baskets`, `shopper-orders`

**Combined SLAS client scopes required:**
```
sfcc.shopper-baskets-orders.rw
sfcc.shopper-baskets-orders
sfcc.shopper-standard
```

(`sfcc.shopper-baskets-orders` is additionally required by `getShippingMethodsForShipment`; the other two cover everything else.)

---

## Plan

**Step 1 – Get an authorization code.** `auth.authorizeCustomer`
- `GET /organizations/{organizationId}/oauth2/authorize`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- Query params: `client_id`, `redirect_uri`, `response_type=code`, `hint=sb-user`, `usid` (optional, to bind session)
- Produces: `code` (authorization code) in the redirect URL
- Why: SLAS registered-shopper flow requires a two-step OAuth 2.1 PKCE exchange. `authorizeCustomer` is step one — the shopper authenticates and you receive a `code`.

**Step 2 – Exchange code for a shopper access token.** `auth.getAccessToken`
- `POST /organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Body (form-encoded): `grant_type=authorization_code`, `code=<from step 1>`, `redirect_uri`, `client_id`, `code_verifier` (PKCE)
- Produces: `access_token` (ShopperToken), `refresh_token`
- Why: "This is the second step of the OAuth 2.1 authorization code flow." – `getAccessToken` summary. All subsequent Shopper* calls require the bearer token from this step.

**Step 3 – Create a basket.** `shopper-baskets.createBasket`
- `POST /organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- Query params: `siteId` (required)
- Body (optional): `customerInfo.email`, `customerInfo.customerNo` to pre-associate the basket with the registered shopper
- Produces: `basketId`, `shipments[0].shipmentId` (default shipment is created automatically)
- Why: `addItemToBasket` requires `basketId` in the path; this step's response provides it.

**Step 4 – Add a product line item.** `shopper-baskets.addItemToBasket`
- `POST /organizations/{organizationId}/baskets/{basketId}/items`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- Path: `basketId` from step 3
- Body: `[{"productId": "...", "quantity": 1}]`
- Produces: updated basket (line item with `itemId`)
- Why: `createOrder` requires a basket with at least one item; `addCouponToBasket` applies against existing line items for promotion evaluation.

**Step 5 – Add the promo coupon.** `shopper-baskets.addCouponToBasket`
- `POST /organizations/{organizationId}/baskets/{basketId}/coupons`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addCouponToBasket
- Path: `basketId` from step 3
- Body: `{"code": "<your-coupon-code>"}`
- Produces: updated basket with `coupons[]` entry and price adjustments applied
- Why: `addCouponToBasket` requires `basketId`; this step's response confirms the coupon was accepted before committing the order.

**Step 6 – Set a shipping address.** `shopper-baskets.updateShippingAddressForShipment`
- `PUT /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- Path: `basketId` from step 3, `shipmentId` from step 3's default shipment
- Body: address object (`address1`, `city`, `stateCode`, `postalCode`, `countryCode`, `firstName`, `lastName`)
- Why: `createOrder` requires a shipping address; structural dependency via basket readiness.

**Step 7 – Get available shipping methods.** `shopper-baskets.getShippingMethodsForShipment`
- `GET /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-methods`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- Produces: `applicableShippingMethods[].id` — pick one for step 8
- Why: You need a valid `shippingMethodId` from the sandbox's configured methods; this avoids hardcoding.

**Step 8 – Set a shipping method.** `shopper-baskets.updateShippingMethodForShipment`
- `PUT /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- Body: `{"id": "<shippingMethodId from step 7>"}`
- Why: `createOrder` requires a shipping method on the shipment.

**Step 9 – Add a payment instrument.** `shopper-baskets.addPaymentInstrumentToBasket`
- `POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- Body: `{"paymentMethodId": "CREDIT_CARD", "amount": <order total>, "paymentCard": {...}}`
- Why: `createOrder` requires at least one payment instrument on the basket.

**Step 10 – Submit the order.** `shopper-orders.createOrder`
- `POST /organizations/{organizationId}/orders`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Query params: `siteId` (required)
- Body: `{"basketId": "<basketId from step 3>"}` — "The only considered value from the request body is basketId." – `createOrder` description.
- Produces: `orderNo`, `status`, final order with coupon-adjusted pricing

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

# Placeholders — fill before running
BASE_URL="https://${SHORT_CODE}.api.commercecloud.salesforce.com"
ORG_ID="f_ecom_${REALM_ID}_${INSTANCE_ID}"
SITE_ID="RefArch"
CLIENT_ID="<your-slas-client-id>"
REDIRECT_URI="<your-registered-redirect-uri>"
CODE_VERIFIER="<pkce-code-verifier>"          # 43-128 char random string
CODE_CHALLENGE="<base64url(sha256(verifier))>"
COUPON_CODE="<your-promo-coupon-code>"
PRODUCT_ID="<master-or-variant-product-id>"

# Step 1 – Authorize (opens browser / follow redirect manually to capture ?code=)
# GET ${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/authorize \
#   ?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code \
#   &hint=sb-user&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256
# Capture the `code` from the redirect URL.
AUTH_CODE="<paste-code-from-redirect>"

# Step 2 – Exchange code for access token
TOKEN_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/token" \
  -H "Authorization: Basic $(echo -n "${CLIENT_ID}:" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${AUTH_CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}")
ACCESS_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.access_token')
echo "access_token: ${ACCESS_TOKEN:0:40}..."

# Step 3 – Create basket
BASKET=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}')
BASKET_ID=$(echo "${BASKET}" | jq -r '.basketId')
SHIPMENT_ID=$(echo "${BASKET}" | jq -r '.shipments[0].shipmentId')
echo "basketId: ${BASKET_ID}  shipmentId: ${SHIPMENT_ID}"

# Step 4 – Add item
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 1}]" | jq '.productItems[].productId'

# Step 5 – Add coupon
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/coupons?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"code\": \"${COUPON_CODE}\"}" | jq '.coupons'

# Step 6 – Set shipping address
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"123 Main St","city":"Burlington","stateCode":"MA","postalCode":"01803","countryCode":"US"}' \
  | jq '.shippingAddress.city'

# Step 7 – Get shipping methods
SHIP_METHODS=$(curl -sS \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-methods?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")
SHIP_METHOD_ID=$(echo "${SHIP_METHODS}" | jq -r '.applicableShippingMethods[0].id')
echo "shippingMethodId: ${SHIP_METHOD_ID}"

# Step 8 – Set shipping method
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${SHIP_METHOD_ID}\"}" | jq '.shipments[0].shippingMethod.id'

# Step 9 – Add payment instrument (sandbox card — check your site's active payment methods)
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethodId":"CREDIT_CARD","amount":0,"paymentCard":{"cardType":"Visa","holder":"Test Shopper","maskedNumber":"************1234","expirationMonth":12,"expirationYear":2030}}' \
  | jq '.paymentInstruments[0].paymentMethodId'

# Step 10 – Create order
ORDER=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\": \"${BASKET_ID}\"}")
echo "orderNo: $(echo "${ORDER}" | jq -r '.orderNo')"
echo "status:  $(echo "${ORDER}" | jq -r '.status')"
echo "coupon discount: $(echo "${ORDER}" | jq '.couponItems')"
```

---

## Sources
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addCouponToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**A few things to note before you run this:**

- The SLAS `authorizeCustomer` step (step 1) is a browser redirect — it can't be done with a bare `curl`. For sandbox repro you'll typically do it once in a browser, capture the `code` from the redirect, then paste it in.
- Step 9's `amount: 0` on the payment instrument is a common sandbox pattern (lets the platform calculate from basket total), but some site configs require a non-zero amount matching the order total. If `createOrder` returns a payment-amount error, pull `productTotal` from the basket response after step 5 and use that.
- `sfcc.shopper-baskets-orders` (read) is only strictly required by `getShippingMethodsForShipment` — if you skip step 7 and hardcode a known shipping method ID, you can omit it from the SLAS client scope.

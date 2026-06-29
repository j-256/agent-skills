## Prompt

> i need to repro a registered shopper adding a promo coupon to their basket and checking out -- on an instance. which SCAPI calls do i need in what order, and which scopes must the SLAS client have

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-add-coupon-checkout` (run 3 of `iteration-auth-code-capture-b2clogin`, Sonnet 4.6, strict-pass). Verbatim capture; every operation name, path, and response field verified against the live scrape cache.

## Answer

---

## Scenario: Registered shopper adds a promo coupon and checks out

**Target:** POST `/organizations/{organizationId}/orders` – `shopper-orders.createOrder`
**References involved:** `auth` (Shopper Login / SLAS), `shopper-baskets`, `shopper-orders`

**Combined SLAS client scopes required:**
```
sfcc.shopper-baskets-orders.rw
```

Alternatively, configure your SLAS client with `sfcc.shopper-standard` – a meta-scope that includes `sfcc.shopper-baskets-orders.rw` plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1 – PKCE setup (local, no network call)**
Generate `code_verifier` / `code_challenge` before the login call.

---

**Step 2 – Log in the registered shopper.** `auth.authenticateCustomer`

This uses the platform's built-in IDP, which is the OOTB default. The `authorizeCustomer` (`/oauth2/authorize`) federation path applies only if your instance has been explicitly configured with a custom IDP (Okta, Auth0, Google, etc.) – if that's not the case, the platform itself is the IDP and `authenticateCustomer` is correct.

- **Method/path:** POST `/organizations/{organizationId}/oauth2/login`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- **Required:** `Authorization: Basic base64(shopperUsername:shopperPassword)` header; query params `code_challenge`, `channel_id`, `client_id`, `redirect_uri`
- **Produces:** `303` redirect; `Location` header contains `code=<AUTH_CODE>` and `usid=<USID>`
- **Why:** `createOrder` requires a `ShopperToken`; this is the first leg of the PKCE authorization-code flow for a B2C-credentialed shopper

---

**Step 3 – Exchange the auth code for a shopper access token.** `auth.getAccessToken`

- **Method/path:** POST `/organizations/{organizationId}/oauth2/token`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- **Required (form body):** `grant_type=authorization_code_pkce`, `code=<AUTH_CODE>` (from Step 2 Location header), `code_verifier` (from Step 1), `client_id`, `redirect_uri`
- **Produces:** `access_token` (shopper JWT), `refresh_token`
- **Why:** every Shopper Baskets and Shopper Orders operation requires `Authorization: Bearer <access_token>`

---

**Step 4 – Create a basket.** `shopper-baskets.createBasket`

- **Method/path:** POST `/organizations/{organizationId}/baskets?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- **Produces:** `Basket` – including `basketId`
- **Why:** `createOrder` body requires a `basketId`; `addItemToBasket`, `addCouponToBasket`, and all preparation steps below consume the `basketId` produced here

---

**Step 5 – Add a product to the basket.** `shopper-baskets.addItemToBasket`

- **Method/path:** POST `/organizations/{organizationId}/baskets/{basketId}/items?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- **Body:** `[{"productId": "...", "quantity": 1}]`
- **Why:** `basketId` comes from Step 4; a basket must contain at least one product item before checkout or it will fail validation

---

**Step 6 – Add the promo coupon.** `shopper-baskets.addCouponToBasket`

- **Method/path:** POST `/organizations/{organizationId}/baskets/{basketId}/coupons?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addCouponToBasket
- **Body:** `{"code": "<COUPON_CODE>"}`
- **Why:** `basketId` comes from Step 4; this is the coupon step in the repro

---

**Step 7 – Set billing address.** `shopper-baskets.updateBillingAddressForBasket`

- **Method/path:** PUT `/organizations/{organizationId}/baskets/{basketId}/billing-address?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- **Body:** `OrderAddress` object (`firstName`, `lastName`, `address1`, `city`, `stateCode`, `postalCode`, `countryCode`)
- **Why:** `basketId` from Step 4; a missing billing address is a basket flash that blocks `createOrder`

---

**Step 8 – Set shipping address.** `shopper-baskets.updateShippingAddressForShipment`

- **Method/path:** PUT `/organizations/{organizationId}/baskets/{basketId}/shipments/me/shipping-address?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- **Body:** `OrderAddress` object
- **Why:** `basketId` from Step 4; default shipment ID is `me`; missing shipping address is a basket flash

---

**Step 9 – Get available shipping methods.** `shopper-baskets.getShippingMethodsForShipment`

- **Method/path:** GET `/organizations/{organizationId}/baskets/{basketId}/shipments/me/shipping-methods?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- **Produces:** `ShippingMethodResult` – array of `{id, name}` objects
- **Why:** `updateShippingMethodForShipment` requires a valid `id` from this list; no structural ordering constraint stated in the spec beyond needing the shipping address set first

---

**Step 10 – Select a shipping method.** `shopper-baskets.updateShippingMethodForShipment`

- **Method/path:** PUT `/organizations/{organizationId}/baskets/{basketId}/shipments/me/shipping-method?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- **Body:** `{"id": "<SHIPPING_METHOD_ID>"}` (from Step 9)
- **Why:** missing shipping method is a basket flash

---

**Step 11 – Get available payment methods.** `shopper-baskets.getPaymentMethodsForBasket`

- **Method/path:** GET `/organizations/{organizationId}/baskets/{basketId}/payment-methods?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getPaymentMethodsForBasket
- **Produces:** `PaymentMethodResult` – list of valid `paymentMethodId` values
- **Why:** `addPaymentInstrumentToBasket` must reference a `paymentMethodId` the site supports; no explicit spec constraint, structural dependency on basketId from Step 4

---

**Step 12 – Add a payment instrument.** `shopper-baskets.addPaymentInstrumentToBasket`

- **Method/path:** POST `/organizations/{organizationId}/baskets/{basketId}/payment-instruments?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- **Body:** `{"paymentMethodId": "CREDIT_CARD", "amount": <total>, "paymentCard": {...}}`
- **Why:** a basket with no payment instrument will fail `createOrder` validation

---

**Step 13 – Submit the order.** `shopper-orders.createOrder`

- **Method/path:** POST `/organizations/{organizationId}/orders?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- **Body:** `{"basketId": "<BASKET_ID>"}` – spec note: "The only considered value from the request body is `basketId`"
- **Produces:** `Order` – including `orderNo`
- **Why:** `basketId` threads from Step 4; all preceding steps resolve the basket flashes that would otherwise cause a `400`

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

# -- Environment --
# BASE_URL:        e.g. https://zz00-001.dx.commercecloud.salesforce.com
# ORG_ID:          f_ecom_<realm><instance>
# SITE_ID:         your site ID, e.g. RefArch
# CLIENT_ID:       your SLAS public client ID
# REDIRECT_URI:    your registered redirect URI (can be localhost for repros)
# CHANNEL_ID:      same as SITE_ID for most storefronts
# SHOPPER_USER:    shopper username (email)
# SHOPPER_PASS:    shopper password
# COUPON_CODE:     promo coupon code to apply
# PRODUCT_ID:      a valid product ID on the site

# -- Step 1: PKCE --
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

# -- Step 2: authenticateCustomer (POST /oauth2/login) --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
SHOPPER_BASIC=$(printf '%s:%s' "$SHOPPER_USER" "$SHOPPER_PASS" | openssl base64 | tr -d '\n')

LOGIN_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/login" \
  -H "Authorization: Basic ${SHOPPER_BASIC}" \
  -G \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "channel_id=${CHANNEL_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "code_challenge=${CODE_CHALLENGE}")

AUTH_CODE=$(printf '%s' "$LOGIN_LOCATION" | grep -oE 'code=[^&]+' | cut -d= -f2)
USID=$(printf '%s' "$LOGIN_LOCATION" | grep -oE 'usid=[^&]+' | cut -d= -f2)

# -- Step 3: getAccessToken (POST /oauth2/token) --
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

ACCESS_TOKEN=$(printf '%s' "$TOKEN_RESPONSE" | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).access_token))")

# -- Step 4: createBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
BASKET=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}')

BASKET_ID=$(printf '%s' "$BASKET" | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).basketId))")

# -- Step 5: addItemToBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 1}]" > /dev/null

# -- Step 6: addCouponToBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addCouponToBasket
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/coupons?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"code\": \"${COUPON_CODE}\"}" > /dev/null

# -- Step 7: updateBillingAddressForBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/billing-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"104 Presidential Way","city":"Woburn","stateCode":"MA","postalCode":"01801","countryCode":"US"}' > /dev/null

# -- Step 8: updateShippingAddressForShipment --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"104 Presidential Way","city":"Woburn","stateCode":"MA","postalCode":"01801","countryCode":"US"}' > /dev/null

# -- Step 9: getShippingMethodsForShipment --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
SHIPPING_METHODS=$(curl -sS \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-methods?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

SHIPPING_METHOD_ID=$(printf '%s' "$SHIPPING_METHODS" | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).applicableShippingMethods[0].id))")

# -- Step 10: updateShippingMethodForShipment --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${SHIPPING_METHOD_ID}\"}" > /dev/null

# -- Step 11: getPaymentMethodsForBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getPaymentMethodsForBasket
PAYMENT_METHODS=$(curl -sS \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-methods?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

# -- Step 12: addPaymentInstrumentToBasket --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
# Adjust paymentMethodId and card details to match your site's config
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethodId":"CREDIT_CARD","amount":0,"paymentCard":{"cardType":"Visa","holder":"Test Shopper","maskedNumber":"************1234","expirationMonth":12,"expirationYear":2030}}' > /dev/null

# -- Step 13: createOrder --
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
ORDER=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\": \"${BASKET_ID}\"}")

ORDER_NO=$(printf '%s' "$ORDER" | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).orderNo))")
echo "Order created: ${ORDER_NO}"
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addCouponToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getPaymentMethodsForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**Key notes for your SLAS client config:**

- Single scope needed: `sfcc.shopper-baskets-orders.rw` (or `sfcc.shopper-standard` as a meta-scope covering it)
- The `/oauth2/login` call returns a `303` – the `code` and `usid` are in the `Location` redirect URL, not in a JSON body
- `channel_id` on the `/login` call is required and maps to your `siteId`; easy to miss
- Steps 7–12 resolve basket *flashes* (validation errors Commerce checks at `createOrder` time) – skip any of them and you'll get a `400` listing the missing pieces

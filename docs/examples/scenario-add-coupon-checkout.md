## Prompt

> i need to repro a registered shopper adding a promo coupon to their basket and checking out -- on an instance. which SCAPI calls do i need in what order, and which scopes must the SLAS client have

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-add-coupon-checkout` (run 5 of `iteration-auth-routing-baseline`).

## Answer

---

## Scenario: Registered shopper adds a promo coupon to their basket and checks out

**Target:** POST `/organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
**References involved:** Shopper Login (SLAS / `auth`), Shopper Baskets, Shopper Orders
**Auth flow:** SLAS registered-B2C (OOTB platform IDP — `authenticateCustomer` + `getAccessToken`)

---

### Combined SLAS client scopes required

```
sfcc.shopper-baskets-orders.rw
```

Alternatively, configure your SLAS client with `sfcc.shopper-standard` – a meta-scope that expands to 20 individual scopes and includes `sfcc.shopper-baskets-orders.rw`. Simpler client setup, broader permissions; accepted by every operation in this plan.

---

### Plan

**Step 1 — Authenticate the shopper (get an auth code).**  `auth.authenticateCustomer`

This uses the platform's built-in IDP, which is the OOTB default. `authenticateCustomer` (`POST /oauth2/login`) is the right call when your instance has **not** been configured with a custom IDP (Okta, Auth0, etc.) — in that case the platform itself is the IDP. If you do have a custom IDP, you'd use `authorizeCustomer` with `hint=<idp-name>` instead.

- **Method/path:** `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/login`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- **Request:** Basic auth header `{client_id}:{client_secret}`, JSON body `{"username": "...", "password": "...", "code_challenge": "<PKCE-S256-hash>"}`, query params `channel_id={siteId}` and `redirect_uri`
- **Produces:** `authorization_code` (in the redirect location or response body)

**Step 2 — Exchange the auth code for a shopper access token.** `auth.getAccessToken`

- **Method/path:** `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- **Request:** form body `grant_type=authorization_code_pkce&code={authorization_code}&code_verifier={verifier}&redirect_uri=...&channel_id={siteId}`, Basic auth `{client_id}:{client_secret}`
- **Produces:** `access_token` (Bearer token used for all basket/order calls), `refresh_token`

**Step 3 — Create a basket.** `shopper-baskets.createBasket`

- **Method/path:** `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- **Request:** Authorization: Bearer `{access_token}`, body can be `{}` to accept defaults
- **Produces:** `basketId` — threads through every subsequent basket call

**Step 4 — Add a product line item.** `shopper-baskets.addItemToBasket`

- **Method/path:** `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/items?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- **Request:** body `[{"productId": "...", "quantity": 1}]`
- **Produces:** updated basket with `productItems[]`, `shipmentId` on the default shipment

**Step 5 — Add the promo coupon.** `shopper-baskets.addCouponToBasket`

- **Method/path:** `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/coupons?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addCouponToBasket
- **Request:** body `{"code": "<coupon-code>"}`
- **Produces:** updated basket with `couponItems[]` confirming the discount applied

**Step 6 — Set the billing address.** `shopper-baskets.updateBillingAddressForBasket`

- **Method/path:** `PUT /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/billing-address?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- **Request:** body with an `OrderAddress` object (`firstName`, `lastName`, `address1`, `city`, `stateCode`, `countryCode`, `postalCode`)

**Step 7 — Set the shipping address.** `shopper-baskets.updateShippingAddressForShipment`

- **Method/path:** `PUT /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- **Request:** same `OrderAddress` shape; `shipmentId` comes from the basket response in step 4 (default shipment is `"me"` or the literal ID from the basket)
- **Why:** `createOrder` requires a shipping address on every shipment; structural prerequisite.

**Step 8 — Select a shipping method.** `shopper-baskets.updateShippingMethodForShipment`

- **Method/path:** `PUT /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- **Request:** body `{"id": "<shipping-method-id>"}` — get available methods first via `getShippingMethodsForShipment` (same `basketId`/`shipmentId`) if you don't already know a valid ID
- **Why:** `createOrder` requires a shipping method on every shipment.

**Step 9 — Add a payment instrument.** `shopper-baskets.addPaymentInstrumentToBasket`

- **Method/path:** `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/payment-instruments?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- **Request:** body with `paymentMethodId` (e.g. `"CREDIT_CARD"`) and card/billing details; the `getPaymentMethodsForBasket` op returns valid IDs for your site config
- **Why:** `createOrder` requires at least one payment instrument on the basket.

**Step 10 — Submit the order.** `shopper-orders.createOrder`

- **Method/path:** `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders?siteId={siteId}`
- **Spec:** https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- **Request:** body `{"basketId": "<basketId>"}` — that's the only required field
- **Produces:** `Order` object with `orderNo`, status, applied coupon items confirming the promo carried through

---

### Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

# ---- env vars (fill in before running) ----
SHORT_CODE="xxxx-001"           # your instance's short code
ORG_ID="f_ecom_zz00_001"        # organizationId (from Business Manager)
SITE_ID="RefArch"               # siteId
CLIENT_ID="your-slas-client-id"
CLIENT_SECRET="your-slas-client-secret"
SHOPPER_USER="shopper@example.com"
SHOPPER_PASS="shopperpassword"
COUPON_CODE="PROMO10"
PRODUCT_ID="701644033398M"
REDIRECT_URI="https://localhost"
BASE_URL="https://${SHORT_CODE}.api.commercecloud.salesforce.com"

# ---- PKCE (generate once per flow) ----
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')

# Step 1 – authenticateCustomer (get auth code)
echo "==> Step 1: authenticate shopper"
AUTH_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/login?channel_id=${SITE_ID}&redirect_uri=${REDIRECT_URI}&response_type=code" \
  -H "Authorization: Basic $(echo -n "${CLIENT_ID}:${CLIENT_SECRET}" | base64)" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${SHOPPER_USER}\",\"password\":\"${SHOPPER_PASS}\",\"code_challenge\":\"${CODE_CHALLENGE}\"}")
AUTH_CODE=$(echo "$AUTH_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).authorization_code||JSON.parse(d).code))")
echo "    auth_code: ${AUTH_CODE}"

# Step 2 – getAccessToken (exchange code for access_token)
echo "==> Step 2: get access token"
TOKEN_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/token" \
  -H "Authorization: Basic $(echo -n "${CLIENT_ID}:${CLIENT_SECRET}" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code_pkce&code=${AUTH_CODE}&code_verifier=${CODE_VERIFIER}&redirect_uri=${REDIRECT_URI}&channel_id=${SITE_ID}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).access_token))")
echo "    access_token: ${ACCESS_TOKEN:0:40}..."

# Step 3 – createBasket
echo "==> Step 3: create basket"
BASKET=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}')
BASKET_ID=$(echo "$BASKET" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).basketId))")
SHIPMENT_ID=$(echo "$BASKET" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).shipments[0].shipmentId))")
echo "    basketId: ${BASKET_ID}  shipmentId: ${SHIPMENT_ID}"

# Step 4 – addItemToBasket
echo "==> Step 4: add product item"
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}]" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);console.log('    items:',b.productItems?.length)})"

# Step 5 – addCouponToBasket
echo "==> Step 5: add coupon ${COUPON_CODE}"
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/coupons?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"${COUPON_CODE}\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);console.log('    coupons:',JSON.stringify(b.couponItems))})"

# Step 6 – updateBillingAddressForBasket
echo "==> Step 6: set billing address"
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/billing-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"5 Wall St","city":"Burlington","stateCode":"MA","countryCode":"US","postalCode":"01803"}' > /dev/null
echo "    done"

# Step 7 – updateShippingAddressForShipment
echo "==> Step 7: set shipping address"
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"5 Wall St","city":"Burlington","stateCode":"MA","countryCode":"US","postalCode":"01803"}' > /dev/null
echo "    done"

# Step 8 – updateShippingMethodForShipment  (replace SHIPPING_METHOD_ID with a valid ID for your site)
SHIPPING_METHOD_ID="001"   # <- get from getShippingMethodsForShipment if unsure
echo "==> Step 8: set shipping method ${SHIPPING_METHOD_ID}"
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"${SHIPPING_METHOD_ID}\"}" > /dev/null
echo "    done"

# Step 9 – addPaymentInstrumentToBasket  (CREDIT_CARD assumed; adapt to your site config)
echo "==> Step 9: add payment instrument"
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethodId":"CREDIT_CARD","paymentCard":{"cardType":"Visa","number":"4111111111111111","expirationMonth":12,"expirationYear":2030,"holder":"Test Shopper"},"amount":0}' > /dev/null
echo "    done"

# Step 10 – createOrder
echo "==> Step 10: submit order"
ORDER=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\":\"${BASKET_ID}\"}")
echo "$ORDER" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log('    orderNo:',o.orderNo,'status:',o.status,'coupons:',JSON.stringify(o.couponItems))})"
```

---

### Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authenticateCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addCouponToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**Scope summary:** every basket and order op in this flow shares the same scope — `sfcc.shopper-baskets-orders.rw` is the only grant your SLAS client needs (or configure `sfcc.shopper-standard` to cover that plus all other shopper scopes in one shot).

**Known variable you'll need to look up before running step 8:** your instance's valid shipping method ID — call `GET .../baskets/{basketId}/shipments/{shipmentId}/shipping-methods` to get the list if `001` doesn't work for your site.

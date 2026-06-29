## Prompt

> target op is `shopper-orders.createOrder`. what are the prerequisites -- which calls have to happen first and where does the basketId come from?

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-createorder-basketid-threading` (run 1 of `iteration-auth-code-capture`, Sonnet 4.6, strict-pass). One parenthetical from the raw capture was dropped: it suggested `useAsShipping=true` on the shipping-address step, but that query param lives on `updateBillingAddressForBasket`, not `updateShippingAddressForShipment` – a misattribution, removed rather than reproduced. Everything else is verbatim; all spec quotes verified against the live scrape cache.

## Answer

---

## Scenario: Guest shopper creates an order from a prepared basket

**Target:** `POST /organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
**References involved:** `auth` (Shopper Login / SLAS), `shopper-baskets`, `shopper-orders`
**Combined SLAS client scopes required:** `sfcc.shopper-baskets-orders.rw`

Alternatively, configure your SLAS client with `sfcc.shopper-standard` – a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1a – Authorize (get an authorization code via PKCE).**  `auth.authorizeCustomer`
- Method/path: `GET /organizations/{organizationId}/oauth2/authorize`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/{organizationId}/oauth2/authorize`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- Produces: authorization `code` in the `Location` 303 redirect header (as a query param on `redirect_uri`)
- Required params: `redirect_uri`, `response_type=code`, `client_id`, `code_challenge` (PKCE), `hint=guest`
- Why: `createOrder` declares `ShopperToken` security; a SLAS shopper token is required. The guest flow sends `hint=guest` to bypass IDP selection – the platform issues an authorization code via 303 redirect without a login page.

**Step 1b – Exchange code for access token.** `auth.getAccessToken`
- Method/path: `POST /organizations/{organizationId}/oauth2/token`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token` (JWT bearer token)
- Body: `grant_type=authorization_code_pkce`, `code=<from step 1a>`, `code_verifier=<from PKCE>`, `client_id`, `redirect_uri`, `channel_id`
- Why: `createOrder` requires `ShopperToken`; `authorizeCustomer` produces a code but not a token – `getAccessToken` exchanges code + verifier for the bearer token.

**Step 2 – Create a basket.** `shopper-baskets.createBasket`
- Method/path: `POST /organizations/{organizationId}/baskets`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- Produces: `basketId` (in the response body, e.g. `"basketId": "a10ff320829cb0eef93ca5310a"`)
- Why: `createOrder` states "The only considered value from the request body is `basketId`." The basket must exist before the order can be placed – this is where `basketId` comes from. The spec example for `createOrder`'s request body is `{"basketId": "a10ff320829cb0eef93ca5310a"}`, matching the value returned by `createBasket`.

**Step 3 – Add at least one item to the basket.** `shopper-baskets.addItemToBasket`
- Method/path: `POST /organizations/{organizationId}/baskets/{basketId}/items`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/items?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- Produces: updated `Basket` with `productItems[]`
- Why: `createOrder` returns `400` for "an invalid product item" and "a product item is not available." A basket with no items will produce a basket with flashes – the spec's `400` explicitly lists "the basket contains flashes (validation errors that prevent order placement)" as a failure cause.

**Step 4 – Set a shipping address.** `shopper-baskets.updateShippingAddressForShipment`
- Method/path: `PUT /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/shipments/me/shipping-address?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- Produces: updated basket shipment with `shippingAddress`
- Why: A missing shipping address is a basket flash. `shipmentId` is `me` for the default shipment (created automatically by `createBasket`).

**Step 5 – Set a shipping method.** `shopper-baskets.updateShippingMethodForShipment`
- Method/path: `PUT /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/shipments/me/shipping-method?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- Produces: updated basket shipment with `shippingMethod` and `shippingTotal`
- Why: A missing shipping method is a basket flash. Use `getShippingMethodsForShipment` first if you need to discover valid method IDs for the site.

**Step 6 – Set a billing address.** `shopper-baskets.updateBillingAddressForBasket`
- Method/path: `PUT /organizations/{organizationId}/baskets/{basketId}/billing-address`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/billing-address?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- Produces: updated basket with `billingAddress`
- Why: A missing billing address is a basket flash.

**Step 7 – Add a payment instrument.** `shopper-baskets.addPaymentInstrumentToBasket`
- Method/path: `POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/payment-instruments?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- Produces: updated basket with `paymentInstruments[]`
- Why: No payment instrument = basket flash; `createOrder` will fail at the "basket contains flashes" check.

**Step 8 – Submit the order.** `shopper-orders.createOrder`
- Method/path: `POST /organizations/{organizationId}/orders`
- Full URL form: `https://{shortCode}.api.commercecloud.salesforce.com/checkout/shopper-orders/v1/organizations/{organizationId}/orders?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Body: `{"basketId": "<from step 2>"}`
- Produces: `Order` with `orderNo`, `orderToken`, `status: "created"`
- Why: The spec states "Submits an order based on a prepared basket. The only considered value from the request body is `basketId`." Steps 2–7 are the "prepared basket" contract.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

# Prerequisites for shopper-orders.createOrder
# Scopes: sfcc.shopper-baskets-orders.rw

# -- Env vars to set before running --
# BASE_URL: e.g. https://zz00-001.dx.commercecloud.salesforce.com
# SHORT_CODE: e.g. kv7kzm78
# ORG_ID: e.g. f_ecom_zz00_001
# SITE_ID: e.g. RefArch
# CLIENT_ID: your SLAS public client ID
# REDIRECT_URI: a registered redirect URI for your SLAS client (can be localhost)
# SHIPPING_METHOD_ID: valid method ID for your site (run getShippingMethodsForShipment if unsure)
# PRODUCT_ID: a valid product ID on the site

# -- Step 1a: PKCE setup --
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

# -- Step 1a: Authorize (guest, PKCE) -> capture authorization code --
AUTH_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/${ORG_ID}/oauth2/authorize?redirect_uri=${REDIRECT_URI}&response_type=code&client_id=${CLIENT_ID}&hint=guest&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256&channel_id=${SITE_ID}")
AUTH_CODE=$(echo "$AUTH_LOCATION" | grep -oE 'code=[^&]+' | cut -d= -f2)
USID=$(echo "$AUTH_LOCATION" | grep -oE 'usid=[^&]+' | cut -d= -f2)

# -- Step 1b: Exchange code for access token --
TOKEN_RESPONSE=$(curl -sS -X POST \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/${ORG_ID}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code_pkce" \
  --data-urlencode "code=${AUTH_CODE}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "channel_id=${SITE_ID}" \
  --data-urlencode "usid=${USID}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).access_token))")

# -- Step 2: Create basket -> capture basketId --
BASKET_RESPONSE=$(curl -sS -X POST \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"currency":"USD"}')
BASKET_ID=$(echo "$BASKET_RESPONSE" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).basketId))")

# -- Step 3: Add item --
curl -sS -X POST \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}]" > /dev/null

# -- Step 4: Set shipping address --
curl -sS -X PUT \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"123 Main St","city":"Boston","stateCode":"MA","postalCode":"02101","countryCode":"US"}' > /dev/null

# -- Step 5: Set shipping method --
curl -sS -X PUT \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"${SHIPPING_METHOD_ID}\"}" > /dev/null

# -- Step 6: Set billing address --
curl -sS -X PUT \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/billing-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"Shopper","address1":"123 Main St","city":"Boston","stateCode":"MA","postalCode":"02101","countryCode":"US"}' > /dev/null

# -- Step 7: Add payment instrument --
curl -sS -X POST \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethodId":"CREDIT_CARD","amount":0,"paymentCard":{"cardType":"Visa","number":"4111111111111111","expirationMonth":12,"expirationYear":2030,"securityCode":"123","holder":"Test Shopper"}}' > /dev/null

# -- Step 8: Create order --
ORDER_RESPONSE=$(curl -sS -X POST \
  "https://${SHORT_CODE}.api.commercecloud.salesforce.com/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\":\"${BASKET_ID}\"}")
echo "Order created: $(echo "$ORDER_RESPONSE" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{ const o=JSON.parse(d); console.log('orderNo='+o.orderNo+' status='+o.status) })")"
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**Where `basketId` comes from:** `shopper-baskets.createBasket` (step 2) returns it in the response body. The `createOrder` spec is explicit: "The only considered value from the request body is `basketId`" – it's the one wire between the basket and order references.

**Why the basket must be "prepared" first:** `createOrder` returns `400` when the basket has flashes. Basket flashes are validation errors that block order placement – missing items, missing shipping address/method, missing billing address, missing payment instrument. The spec doesn't enumerate an exhaustive list, but the items above are the standard set for a physical-goods storefront flow. If your site has custom flash conditions (tax calculation required, etc.), a `getBasket` call after each step will show any active flashes in the response.

## Prompt

> target op is `shopper-orders.createOrder`. what are the prerequisites -- which calls have to happen first and where does the basketId come from?

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-createorder-basketid-threading` (run 2 of `iteration-runnable-jq`, Sonnet 4.6, strict-pass). Verbatim except one softened attribution: the raw capture put quote marks around a Shipment-schema sentence ("The default value is 'me'") that isn't verbatim in the spec – `me` as the default shipment ID is documented platform behavior, so it's stated as fact here, unquoted. Every other spec quote verified against the live scrape cache.

## Answer

---

## Scenario: Guest shopper creates a basket and submits it as an order

**Target:** `POST /organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
**References involved:** `auth` (Shopper Login / SLAS), `shopper-baskets`, `shopper-orders`
**Combined SLAS client scopes required:** `sfcc.shopper-baskets-orders.rw`

> Alternatively, configure your SLAS client with `sfcc.shopper-standard` – a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1a. Authorize the guest shopper (get the authorization code).** `authorizeCustomer`
- Method/path: `GET /shopper/auth/v1/organizations/{organizationId}/oauth2/authorize`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- Produces: `code` (in the `Location` 303 redirect header), `usid`
- Why: `createOrder` declares `security: [ShopperToken]`; the Shopper Orders Summary states "The Shopper Orders API requires a shopper access token from the Shopper Login and API Access Service (SLAS)." This leg obtains the authorization code via `hint=guest`.

**Step 1b. Exchange the authorization code for an access token.** `getAccessToken`
- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token`, `refresh_token`
- Why: exchanges the `code` from Step 1a for the Bearer token that all subsequent calls require. `grant_type=authorization_code_pkce`.

**Step 2. Create the basket.** `shopper-baskets.createBasket`
- Method/path: `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- Produces: `Basket` object – including `basketId` (read-only string, e.g. `"a10ff320829cb0eef93ca5310a"`), `shipments[0].shipmentId` (default shipment, ID `"me"`)
- Why: the Shopper Baskets Summary states "The endpoint creates the basket in the B2C Commerce system and returns a JSON representation of the basket with a `basketId` property." `createOrder` requires `basketId` in its request body per its own description: "The only considered value from the request body is basketId." Structural producer: `createBasket → Basket → basketId`.

**Step 3. Add at least one item to the basket.** `shopper-baskets.addItemToBasket`
- Method/path: `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/items`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- Produces: updated `Basket`
- Why: a basket with no line items cannot be submitted as an order. Business logic constraint – no explicit spec sentence, but an empty basket would fail at checkout. `basketId` comes from Step 2's response.

**Step 4. Set a shipping address on the default shipment.** `shopper-baskets.updateShippingAddressForShipment`
- Method/path: `PUT /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- Produces: updated `Basket`
- Why: order submission requires a shipping address. `basketId` from Step 2; `shipmentId` is `"me"` (the default shipment created with every basket – a platform default, not unique to SCAPI).

**Step 5. Select a shipping method.** `shopper-baskets.updateShippingMethodForShipment`
- Method/path: `PUT /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- Produces: updated `Basket`
- Why: an unset shipping method blocks checkout. To discover valid shipping method IDs for the site, call `getShippingMethodsForShipment` first (Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment); use `applicableShippingMethods[0].id` from that response.

**Step 6. Add a billing address.** `shopper-baskets.updateBillingAddressForBasket`
- Method/path: `PUT /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/billing-address`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- Produces: updated `Basket`
- Why: order submission requires a billing address.

**Step 7. Add a payment instrument.** `shopper-baskets.addPaymentInstrumentToBasket`
- Method/path: `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/payment-instruments`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- Produces: updated `Basket`
- Why: order submission requires payment. Steps 4–7 are all basket-preparation requirements; no explicit ordering constraint exists *between* them – the Shopper Baskets Summary states "You can create a basket and gradually populate it with data using subsequent API requests." The structural order here is conventional, not mandated by the spec.

**Step 8. Submit the order.** `shopper-orders.createOrder`
- Method/path: `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Produces: `Order` (with `orderNo`, `status`, etc.)
- Why: the Shopper Orders Summary states "Create orders based on baskets prepared using the Shopper Baskets API." The description states "The only considered value from the request body is basketId."

---

## Where `basketId` comes from

`createBasket` (Step 2) returns a `Basket` object. The `basketId` field in that response is **read-only** (generated server-side – you cannot supply it). It threads as a path parameter into every `shopper-baskets` operation in Steps 3–7, and as the lone request body field in `createOrder` (Step 8).

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail
command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# -- Placeholders --
# BASE_URL        your SCAPI base, e.g. https://zz00-001.dx.commercecloud.salesforce.com
# ORG_ID          f_ecom_<realm>_<instance>
# SITE_ID         e.g. RefArch
# CLIENT_ID       your SLAS public client ID
# REDIRECT_URI    registered redirect URI, e.g. http://localhost:3000/callback
# PRODUCT_ID      a valid product ID on your site, e.g. green-bag
# SHIPPING_ID     from getShippingMethodsForShipment; set after Step 5a

# Step 1a -- PKCE setup + authorizeCustomer (guest)
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

AUTH_REDIRECT=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&hint=guest&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256")
AUTH_CODE=$(printf '%s' "$AUTH_REDIRECT" | grep -o 'code=[^&]*' | cut -d= -f2)
USID=$(printf '%s' "$AUTH_REDIRECT" | grep -o 'usid=[^&]*' | cut -d= -f2)

# Step 1b -- getAccessToken (authorization_code_pkce)
TOKEN_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code_pkce&code=${AUTH_CODE}&redirect_uri=${REDIRECT_URI}&client_id=${CLIENT_ID}&code_verifier=${CODE_VERIFIER}&usid=${USID}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)

# Step 2 -- createBasket
BASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}')
BASKET_ID=$(echo "$BASKET_RESPONSE" | jq -r .basketId)
SHIPMENT_ID="me"   # default shipment

# Step 3 -- addItemToBasket
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 1}]"

# Step 4 -- updateShippingAddressForShipment
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Stephanie","lastName":"Miller","address1":"104 Presidential Way","city":"Woburn","stateCode":"MA","postalCode":"01801","countryCode":"US"}'

# Step 5a -- getShippingMethodsForShipment (discover valid IDs)
SHIPPING_METHODS_RESPONSE=$(curl -sS \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-methods?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")
SHIPPING_ID=$(echo "$SHIPPING_METHODS_RESPONSE" | jq -r '.applicableShippingMethods[0].id')

# Step 5b -- updateShippingMethodForShipment
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${SHIPPING_ID}\"}"

# Step 6 -- updateBillingAddressForBasket
curl -sS -X PUT \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/billing-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Stephanie","lastName":"Miller","address1":"104 Presidential Way","city":"Woburn","stateCode":"MA","postalCode":"01801","countryCode":"US"}'

# Step 7 -- addPaymentInstrumentToBasket
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"amount": 0, "paymentMethodId": "CREDIT_CARD", "paymentCard": {"cardType": "Visa", "creditCardToken": "<tokenized-card>"}}'

# Step 8 -- createOrder
ORDER_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\": \"${BASKET_ID}\"}")
echo "$ORDER_RESPONSE" | jq '{orderNo: .orderNo, status: .status, total: .orderTotal}'
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingAddressForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

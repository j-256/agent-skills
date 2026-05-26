## Prompt

> target op is `shopper-orders.createOrder`. what are the prerequisites -- which calls have to happen first and where does the basketId come from?

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-createorder-basketid-threading` (run 4 of `iteration-ocapi-path-prefix-fix`).

## Answer

---

## Scenario: Prepare a basket and submit an order

**Target:** `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
**References involved:** `shopper-login` (SLAS/auth), `shopper-baskets`, `shopper-orders`
**Combined scopes required:** `sfcc.shopper-baskets-orders.rw`

---

## Plan

The spec states: *"Submits an order based on a prepared basket. The only considered value from the request body is `basketId`."* — so everything below is about getting a `basketId` that's ready to submit.

The `shopper-orders` Summary states: *"Create orders based on baskets prepared using the Shopper Baskets API."*

The `shopper-baskets` Summary states: *"When your basket is fully populated, you can use its `basketId` property to create an order with the Shopper Orders API."*

### Step 1 — Authenticate (SLAS guest or registered shopper token)

Get a shopper access token. For a guest flow this is a two-leg exchange (authorize → token); for a registered shopper it's the same flow after the user authenticates against your IDP.

**1a. `authorizeCustomer` (or guest authorization)**
- Method/path: `GET /shopper/auth/v1/organizations/{organizationId}/oauth2/authorize`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login?meta=authorizeCustomer
- Produces: `code` (authorization code, returned via redirect)

**1b. `getAccessToken`**
- Method/path: `POST /shopper/auth/v1/organizations/{organizationId}/oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login?meta=getAccessToken
- Produces: `access_token` (Bearer token required by all subsequent calls)

---

### Step 2 — Create a basket (`shopper-baskets.createBasket`)

- Method/path: `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- Produces: **`basketId`** — this is the value threaded into every subsequent basket call and ultimately into `createOrder`
- Why: `createOrder` accepts only `basketId` in its request body; this step is the structural producer of that ID. The `shopper-baskets` Summary states: *"The endpoint creates the basket in the B2C Commerce system and returns a JSON representation of the basket with a `basketId` property."*

---

### Step 3 — Add item(s) to the basket (`shopper-baskets.addItemToBasket`)

- Method/path: `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/items?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- Consumes: `basketId` (from Step 2), `productId`, `quantity`
- Why: A basket with no line items cannot be submitted as an order. Structural requirement — no basket content, no order.

---

### Step 4 — Set billing address and customer info (`shopper-baskets.updateBasket`)

- Method/path: `PATCH /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBasket
- Consumes: `basketId`
- Body fields: `billingAddress`, `customerInfo` (email required for guest checkout)
- Why: `createOrder` will fail if billing address or customer email is missing; the basket must be "fully populated" per the Summary.

---

### Step 5 — Set shipping address and shipping method

**5a. Update default shipment with a shipping address** — use `updateBasket` or `createShipmentForBasket`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createShipmentForBasket

**5b. Get available shipping methods** (`getShippingMethodsForShipment`)
- Method/path: `GET /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-methods?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- Produces: list of valid `shippingMethodId` values

**5c. Apply the chosen method** — `updateBasket` with `shipments[].shippingMethod.id`

---

### Step 6 — Add a payment instrument (`shopper-baskets.addPaymentInstrumentToBasket`)

- Method/path: `POST /checkout/shopper-baskets/v1/organizations/{organizationId}/baskets/{basketId}/payment-instruments?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- Consumes: `basketId`, payment type + amount
- Why: `createOrder` requires a payment instrument on the basket to proceed. The `shopper-orders` Summary states: *"Add a customer's payment instrument to an order."* — but payment must be attached at basket stage before submit.

---

### Step 7 — Submit the order (`shopper-orders.createOrder`)

- Method/path: `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders?siteId={siteId}`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Body: `{ "basketId": "<from Step 2>" }`
- Produces: `orderNo` (the created order number)

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

# Prerequisites — fill these in for your sandbox:
BASE_URL="https://${SHORT_CODE}.api.commercecloud.salesforce.com"
ORG_ID="f_ecom_xxxx_xxx"          # your org ID
SITE_ID="RefArch"                  # your site ID
CLIENT_ID="your-slas-client-id"
CLIENT_SECRET="your-client-secret" # private client only
PRODUCT_ID="701644329260M"         # any valid product on the site

# ── Step 1: SLAS guest token (public client / PKCE omitted for brevity) ──
# For a quick sandbox test with a private client:
ACCESS_TOKEN=$(curl -sS -X POST \
  "${BASE_URL}/shopper/auth/v1/organizations/${ORG_ID}/oauth2/token" \
  -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -d "grant_type=client_credentials&channel_id=${SITE_ID}" \
  | jq -r '.access_token')

echo "Access token: ${ACCESS_TOKEN:0:40}..."

# ── Step 2: Create basket ──
BASKET=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}')

BASKET_ID=$(echo "$BASKET" | jq -r '.basketId')
echo "Basket ID: ${BASKET_ID}"

# ── Step 3: Add item ──
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 1}]"

# ── Step 4: Set billing address + customer email ──
curl -sS -X PATCH \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "customerInfo": {"email": "shopper@example.com"},
    "billingAddress": {
      "firstName": "Test", "lastName": "Shopper",
      "address1": "1 Commerce Dr", "city": "Burlington",
      "stateCode": "MA", "postalCode": "01803", "countryCode": "US"
    }
  }'

# ── Step 5: Get shipping methods, then apply one ──
SHIPMENT_ID="me"  # default shipment ID
SHIPPING_METHODS=$(curl -sS \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/${SHIPMENT_ID}/shipping-methods?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

SHIPPING_METHOD_ID=$(echo "$SHIPPING_METHODS" | jq -r '.applicableShippingMethods[0].id')
echo "Shipping method: ${SHIPPING_METHOD_ID}"

curl -sS -X PATCH \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"shipments\": [{
      \"id\": \"${SHIPMENT_ID}\",
      \"shippingAddress\": {
        \"firstName\": \"Test\", \"lastName\": \"Shopper\",
        \"address1\": \"1 Commerce Dr\", \"city\": \"Burlington\",
        \"stateCode\": \"MA\", \"postalCode\": \"01803\", \"countryCode\": \"US\"
      },
      \"shippingMethod\": {\"id\": \"${SHIPPING_METHOD_ID}\"}
    }]
  }"

# ── Step 6: Add payment instrument ──
curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"amount": 0, "paymentMethodId": "CREDIT_CARD",
       "paymentCard": {"cardType": "Visa", "expirationMonth": 12, "expirationYear": 2030,
                       "holder": "Test Shopper", "maskedNumber": "411111XXXXXX1111",
                       "numberLastDigits": "1111"}}'

# ── Step 7: Submit the order ──
ORDER=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\": \"${BASKET_ID}\"}")

ORDER_NO=$(echo "$ORDER" | jq -r '.orderNo')
echo "Order created: ${ORDER_NO}"
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login?meta=authorizeCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=Summary
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**Where `basketId` comes from:** `createBasket` (Step 2) returns it in the response JSON as `.basketId`. It threads through every subsequent basket mutation and is the only field `createOrder` reads from its request body.

**One scope covers everything:** `sfcc.shopper-baskets-orders.rw` — both the `shopper-baskets` and `shopper-orders` Summary docs list the same scope requirement, so a single SLAS client configured with that scope handles the full flow.

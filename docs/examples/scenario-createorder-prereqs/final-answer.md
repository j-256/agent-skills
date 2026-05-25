I have everything needed. Here's the complete scenario:

---

## Scenario: Guest shopper creates an order from a basket

**Target:** `POST /organizations/{organizationId}/orders` — `shopper-orders.createOrder`  
**References involved:** `shopper-baskets`, `shopper-orders`  
**Combined scopes required:** `sfcc.shopper-baskets-orders.rw` (covers both APIs)

The spec states: *"The only considered value from the request body is `basketId`."* So the entire prerequisite chain is about building a basket that's ready to submit.

---

## Plan

**1. Obtain a shopper access token (SLAS)**  
This is an external input — not part of either reference. You need a shopper JWT from SLAS before any basket call. See [SLAS reference](https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-login) for the guest or registered login flow. All calls below use this token.

**2. Create a basket** — `shopper-baskets.createBasket`  
`POST /organizations/{organizationId}/baskets`  
Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket  
Produces: `basketId` (top-level field in the response), a default shipment with `shipmentId = "me"`  
Why: The Shopper Baskets Summary states: *"To create a basket, start with the [Create basket] endpoint. The endpoint creates the basket in the B2C Commerce system and returns a JSON representation of the basket with a `basketId` property."* You can optionally pass a fully-populated body and skip steps 3–6; the gradual approach below lets you validate each piece.

**3. Add a product** — `shopper-baskets.addItemToBasket`  
`POST /organizations/{organizationId}/baskets/{basketId}/items`  
Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket  
Produces: updated basket (same `basketId` threads through)  
Why: `basketId` from step 2 required in path; body needs `productId` + `quantity`.

**4. Set a billing address** — `shopper-baskets.updateBillingAddressForBasket`  
`PUT /organizations/{organizationId}/baskets/{basketId}/billing-address`  
Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket  
Why: `createOrder` validates the basket is checkout-ready; a missing billing address will fail submission.

**5. Set a shipping method** — `shopper-baskets.updateShippingMethodForShipment`  
`PUT /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method`  
Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment  
Why: `shipmentId` is `"me"` (the default shipment created in step 2). Use `getShippingMethodsForShipment` (step 5a below) to discover valid IDs first.

> **5a. (Optional lookup)** — `shopper-baskets.getShippingMethodsForShipment`  
> `GET /organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-methods`  
> Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment  
> Returns `applicableShippingMethods[].id` and `defaultShippingMethodId`.

**6. Add a payment instrument** — `shopper-baskets.addPaymentInstrumentToBasket`  
`POST /organizations/{organizationId}/baskets/{basketId}/payment-instruments`  
Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket  
Why: basket must have a payment method before `createOrder` accepts it.

**7. Submit the order** — `shopper-orders.createOrder`  
`POST /organizations/{organizationId}/orders`  
Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder  
Body: `{"basketId": "<value from step 2>"}` — per spec, that's the only field read.  
Produces: `orderNo`, full `Order` object.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------
# Placeholders — set these before running:
#   BASE_URL       e.g. https://zz00-001.dx.commercecloud.salesforce.com
#   SHORT_CODE     e.g. kv7kzm78  (from your AM / BM instance settings)
#   ORG_ID         e.g. f_ecom_zz00_001
#   SITE_ID        e.g. RefArch
#   ACCESS_TOKEN   shopper JWT from SLAS guest or registered flow
#   PRODUCT_ID     e.g. green-bag (a valid product ID in your catalog)
#   SHIPPING_ID    e.g. 001 (use step 5a to discover; 001 = Ground in sandbox)
# -------------------------------------------------------

API="https://${SHORT_CODE}.api.commercecloud.salesforce.com"

# --- Step 2: Create basket ---
BASKET=$(curl -sS -X POST \
  "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "customerInfo": { "email": "shopper@example.com" }
  }')
BASKET_ID=$(echo "$BASKET" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).basketId))")
echo "basketId: $BASKET_ID"

# --- Step 3: Add a product ---
curl -sS -X POST \
  "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/items?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "[{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 1}]"

# --- Step 4: Billing address ---
curl -sS -X PUT \
  "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/billing-address?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Stephanie", "lastName": "Miller",
    "address1": "104 Presidential Way",
    "city": "Woburn", "postalCode": "01801",
    "stateCode": "MA", "countryCode": "US"
  }'

# --- Step 5a: Discover shipping methods (optional) ---
curl -sS \
  "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-methods?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"

# --- Step 5: Set shipping method ---
curl -sS -X PUT \
  "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/shipments/me/shipping-method?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${SHIPPING_ID}\"}"

# --- Step 6: Add payment instrument ---
curl -sS -X POST \
  "${API}/checkout/shopper-baskets/v1/organizations/${ORG_ID}/baskets/${BASKET_ID}/payment-instruments?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentMethodId": "CREDIT_CARD",
    "paymentCard": { "cardType": "Visa", "maskedNumber": "*********1234",
                     "holder": "Stephanie Miller",
                     "expirationMonth": 12, "expirationYear": 2030 }
  }'

# --- Step 7: Create order ---
ORDER=$(curl -sS -X POST \
  "${API}/checkout/shopper-orders/v1/organizations/${ORG_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\": \"${BASKET_ID}\"}")
echo "$ORDER" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);console.log('orderNo:', o.orderNo)})"
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=Summary
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addItemToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateBillingAddressForBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=getShippingMethodsForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=updateShippingMethodForShipment
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets?meta=addPaymentInstrumentToBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

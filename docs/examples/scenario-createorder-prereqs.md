## Prompt

> target op is `shopper-orders.createOrder`. what are the prerequisites -- which calls have to happen first and where does the basketId come from?

Skill: `dsc-scenario`. Captured from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-createorder-basketid-threading` (run 1 of `iteration-submittability-registry`, Sonnet 4.6, strict-pass – the post-registry capture that replaces the pre-design version). Verbatim except one field correction verified against a live instance: the captured `paymentInstruments` entry was `{"paymentMethodId": "CREDIT_CARD", "amount": 0}`, which `createBasket` rejects with 400 "Invalid Payment Method Id" – a `CREDIT_CARD` instrument needs a `paymentCard` object. Corrected here to the verified-working shape (a `paymentCard` with `cardType`/`maskedNumber`/expiry/holder), confirmed to reach `createOrder` 200 on sandbox RefArch. Everything else – the plan structure, the curated business-rule framing, the per-field 400s, the citations – is the model's verbatim output. The five-field submittable-minimum is curated runtime knowledge (the spec's `Basket.required` is `null`); each field was empirically verified individually required in `iteration-submittability-registry`.

## Answer

---

## Scenario: Guest shopper creates an order from a prepared basket

Target: `POST /organizations/{organizationId}/orders` (`shopper-orders.createOrder`)
References involved: Shopper Login (SLAS) (`auth`), Shopper Baskets V2 (`shopper-baskets-v2`), Shopper Orders (`shopper-orders`)

Combined SLAS client scopes required:
  `sfcc.shopper-baskets-orders.rw`

Alternatively, configure your SLAS client with `sfcc.shopper-standard` – a meta-scope that includes everything above plus 19 others. Simpler setup, broader permissions; both are accepted by every operation in this plan.

---

## Plan

**Step 1 – Authorize (SLAS guest, PKCE leg 1).** `authorizeCustomer` with `hint=guest`.
- Method/path: `GET /oauth2/authorize`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- Produces: authorization code (in the `Location` header of the `303` redirect, as a `code=` query param)
- Why: `createOrder` declares `ShopperToken` security; the shopper token comes from SLAS. This leg obtains the authorization code via the guest hint, bypassing IDP selection. The code is in the `Location` redirect header – not a JSON body.

**Step 2 – Exchange code for token (SLAS PKCE leg 2).** `getAccessToken` with `grant_type=authorization_code_pkce`.
- Method/path: `POST /oauth2/token`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- Produces: `access_token` (shopper JWT), `usid`
- Why: structural – `createOrder` requires `Authorization: Bearer <access_token>`.

**Step 3 – Create a populated basket.** `shopper-baskets-v2.createBasket`.
- Method/path: `POST /checkout/shopper-baskets/v2/organizations/{organizationId}/baskets`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- Produces: `Basket` → `basketId` (threaded into Step 4's request body)
- Why: `createOrder` takes a `basketId` in its request body; `createBasket` is the from-nothing producer. **The basket must be populated at creation** – this is a checkout business-rule (curated, not stated in the spec; `Basket.required` is `null` in the machine-readable spec). Each missing field causes a distinct 400 at `createOrder` time, not at `createBasket` time:
  - `productItems` – at least one line item; `createOrder` returns 400 "Product Items Required" otherwise.
  - `shipments[].shippingMethod` – a shipping method on the default shipment (`id: "me"`); without it `createOrder` returns 400 "Order total missing, calculation failed."
  - `shipments[].shippingAddress` – shipping address on the shipment; `createOrder` returns 400 "Empty Shipping Address" otherwise.
  - `billingAddress` – with both first and last name; `createOrder` returns 400 "Empty Billing Address" or 400 "Invalid Billing Address" if a name is missing (exact required address fields are merchant-configurable).
  - `paymentInstruments` – a payment instrument (e.g. `paymentMethodId: CREDIT_CARD`); `createOrder` returns 400 "Missing Payment Method Id" without one.

  Provenance: empirically verified on a live B2C Commerce instance. See https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder.

**Step 4 – Create the order.** `shopper-orders.createOrder`.
- Method/path: `POST /checkout/shopper-orders/v1/organizations/{organizationId}/orders`
- Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
- Produces: `Order`
- Why: target operation. Requires the `basketId` from Step 3 in the request body.

> No explicit ordering constraint found beyond the structural dependency – structural order only.

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail
command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# ---- PKCE setup ----
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '=\n' | tr '+/' '-_')
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl enc -base64 | tr -d '=\n' | tr '+/' '-_')

# Step 1 – authorizeCustomer (guest, PKCE leg 1)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
# The 303 Location header carries the authorization code as code=<value>
AUTH_LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  "${SLAS_BASE_URL}/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&hint=guest&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256")
AUTH_CODE=$(printf '%s' "$AUTH_LOCATION" | grep -oE 'code=[^&]+' | cut -d= -f2)
USID=$(printf '%s' "$AUTH_LOCATION" | grep -oE 'usid=[^&]+' | cut -d= -f2)

# Step 2 – getAccessToken (PKCE leg 2)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
TOKEN_RESPONSE=$(curl -sS -X POST \
  "${SLAS_BASE_URL}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code_pkce&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&code=${AUTH_CODE}&code_verifier=${CODE_VERIFIER}&usid=${USID}")
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)

# Step 3 – createBasket (shopper-baskets-v2)
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
# ⚠ Checkout business-rule (curated): basket must be populated here;
#   createBasket accepts anything but createOrder rejects an unpopulated basket with distinct 400s.
CREATEBASKET_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-baskets/v2/organizations/${ORGANIZATION_ID}/baskets?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "productItems": [
      { "productId": "YOUR_PRODUCT_ID", "quantity": 1 }
    ],
    "shipments": [
      {
        "id": "me",
        "shippingMethod": { "id": "YOUR_SHIPPING_METHOD_ID" },
        "shippingAddress": {
          "firstName": "Jane", "lastName": "Doe",
          "address1": "1 Market St", "city": "San Francisco",
          "stateCode": "CA", "postalCode": "94105", "countryCode": "US"
        }
      }
    ],
    "billingAddress": {
      "firstName": "Jane", "lastName": "Doe",
      "address1": "1 Market St", "city": "San Francisco",
      "stateCode": "CA", "postalCode": "94105", "countryCode": "US"
    },
    "paymentInstruments": [
      {
        "paymentMethodId": "CREDIT_CARD",
        "paymentCard": {
          "cardType": "Visa",
          "maskedNumber": "************1111",
          "expirationMonth": 12,
          "expirationYear": 2030,
          "holder": "Jane Doe"
        }
      }
    ]
  }')
BASKET_ID=$(echo "$CREATEBASKET_RESPONSE" | jq -r .basketId)

# Step 4 – createOrder
# Spec: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder
CREATEORDER_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/checkout/shopper-orders/v1/organizations/${ORGANIZATION_ID}/orders?siteId=${SITE_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"basketId\": \"${BASKET_ID}\"}")

echo "$CREATEORDER_RESPONSE" | jq .

# ----------------------------------------------------------
# Placeholders:
#   BASE_URL:       your instance root, e.g. https://zz00-001.dx.commercecloud.salesforce.com
#   SLAS_BASE_URL:  SLAS tenant root, e.g. https://zz00-001.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/${ORGANIZATION_ID}
#   ORGANIZATION_ID: f_ecom_zz00_001  (your org ID)
#   SITE_ID:        RefArch  (your site ID)
#   CLIENT_ID:      your SLAS public client ID
#   REDIRECT_URI:   your registered redirect URI (must be registered on the SLAS client)
#   YOUR_PRODUCT_ID:         a valid product ID on your instance
#   YOUR_SHIPPING_METHOD_ID: a valid shipping method ID (call getShippingMethodsForShipment to enumerate)
```

---

## Sources
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=authorizeCustomer
- https://developer.salesforce.com/docs/commerce/commerce-api/references/auth?meta=getAccessToken
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=createBasket
- https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder

---

**The `basketId` answer:** it comes from `createBasket`'s response body (`$.basketId`). There is no other structural path – `createOrder` takes a `Basket` type in its request body, and `createBasket` is the only from-nothing producer of that type (`transferBasket` and `mergeBasket` both presuppose an existing basket). The `basketId` from `createBasket`'s response threads directly into `createOrder`'s body as `{"basketId": "..."}`.

The key non-obvious thing: `createBasket` never rejects an empty body (it always returns 200), but `createOrder` will 400 on an unpopulated basket. The five fields in Step 3's body (`productItems`, `shipments[].shippingMethod`, `shipments[].shippingAddress`, `billingAddress`, `paymentInstruments`) are required by `createOrder`, not by `createBasket` – so you won't see the errors until you hit the order endpoint.

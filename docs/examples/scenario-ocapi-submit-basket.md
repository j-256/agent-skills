## Prompt

> target op is OCAPI shop-orders `Submit basket` (POST /orders). what are the prerequisites -- which calls have to happen first and where does the basket_id come from? is the basket -> order chain the same as SCAPI?

Skill: `dsc-scenario`. Captured verbatim from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-ocapi-submit-basket` (run 1 of `iteration-honest-trophies`, Sonnet, strict-pass). The emitted OCAPI-native runnable was executed verbatim against a live B2C Commerce sandbox (site `RefArch`, API `v25_6`) and placed a real order with zero edits to the emitted structure. The only addition is a trailing `jq` display line that surfaces the captured `$POST_ORDERS_RESPONSE` (it does not alter any request). The guest JWT is captured from the `customers/auth` response `Authorization` header, the single populated `POST /baskets` body uses `payment_card.masked_number` (a raw `number` is rejected) with `card_type` the only required card leaf, and `${BASKET_ID}` threads into `POST /orders` via an expansion-safe heredoc – all rendered deterministically by scenario.js.

## Answer

## Scenario: Guest shopper creates and submits a basket to place an order (OCAPI Shop)

Target: `POST /orders`  (`ocapi-shop-orders.post-orders`)
References involved: `ocapi-shop-customers`, `ocapi-shop-baskets`, `ocapi-shop-orders`
Combined scopes required: *(none — OCAPI uses a Business Manager allowlist, not SLAS client scopes)*

---

## Plan

**Step 1. Obtain a shopper token via OCAPI-native `customers/auth`.**
- Method/path: `POST /customers/auth`
- Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-customers?meta=post-customers-auth
- Produces: a JWT bearer token — returned in the **response `Authorization` header**, not a JSON body
- Why: every OCAPI Shop write (`/baskets`, `/orders`) requires a shopper bearer + `?client_id=`. The token is captured by grepping the response headers for `Authorization:`
- Instance-config note: the client must be enabled in Business Manager → Administration → Site Development → Open Commerce API Settings for each Shop API resource you call. OCAPI access is a BM allowlist; a missing entry returns 401 regardless of token validity.
- Registered shopper? Swap `{"type":"guest"}` → `{"type":"credentials"}` and add `Authorization: Basic base64(<user>:<pass>)` to the same request.

**Step 2. Create and populate a basket in a single `POST /baskets` call.**
- Method/path: `POST /baskets`
- Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets?meta=post-baskets
- Produces: `basket` — response body contains `basket_id`, which threads directly into Step 3
- Why: `post-orders` requires a `basket_id` in its request body; `post-baskets` is the from-nothing producer of that id (structural dependency).
- **Submittability — checkout business-rule (curated, not stated in the spec).** The OCAPI basket type declares no `required` set, but `POST /orders` will 400 on an under-populated basket. The basket must carry:
  - `product_items` — at least one line item; `POST /orders` returns a 400 fault without one
  - `shipments[].shipping_method` — a shipping method on the default shipment (id `"me"`); without it the order total can't be calculated and `POST /orders` returns a 400 fault
  - `shipments[].shipping_address` — a shipping address on the shipment; `POST /orders` returns a 400 fault (empty shipping address) otherwise
  - `billing_address` — with both `first_name` and `last_name`; `POST /orders` returns a 400 fault without one or with missing names (required fields are merchant-configurable)
  - `payment_instruments` — `payment_method_id` (e.g. `CREDIT_CARD`) + a `payment_card`; `POST /orders` returns a 400 fault (missing payment) without one
  - **OCAPI-specific payment twist (verified live):** in the `POST /baskets` create body, `payment_card` must use `masked_number` — a raw card `number` is rejected with `400 UnknownPropertyException: unknown property number`. To send a raw card number, use the `POST /baskets/{id}/payment_instruments` sub-resource instead. `card_type` is the only required `payment_card` leaf; `expiration_month`/`expiration_year` are above the minimum (drop-one verified: basket creates and order places without them).
  - Provenance: runtime-verified end-to-end on a live B2C Commerce sandbox (RefArch, v25.6) on 2026-07-11. This is curated runtime knowledge, not spec-derived.

**Step 3. Submit the basket to place an order.**
- Method/path: `POST /orders`
- Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders
- Produces: `order`
- Why: `post-orders` requires `basket_id` in the request body; `basket_id` comes from Step 2's response (structural dependency via `basket.basket_id`)

---

### Is the basket → order chain the same as SCAPI?

The **concept** is identical: create a basket, populate it with items/shipping/billing/payment, then submit it with the basket id to place the order. The **mechanics** differ:

| | OCAPI Shop | SCAPI (Shopper Baskets v2 + Shopper Orders) |
|---|---|---|
| Field casing | `snake_case` (`basket_id`, `product_items`, `billing_address`) | `camelCase` (`basketId`, `productItems`, `billingAddress`) |
| Auth | OCAPI `customers/auth` → JWT in response `Authorization` header | SLAS PKCE/registered flow → bearer in JSON body |
| `client_id` | Required as `?client_id=` on every call | Not needed |
| Scopes | BM allowlist (no SLAS scopes) | SLAS client scopes (`sfcc.shopper-baskets`, `sfcc.shopper-orders`, etc.) |
| Payment number in create body | `masked_number` only — raw `number` field rejected with 400 | `number` accepted directly |
| Basket id field | `basket_id` | `basketId` |

---

## Run it

```bash
#!/usr/bin/env bash
set -euo pipefail
command -v jq >/dev/null || { echo "this script needs jq (brew install jq, or apt-get install jq)"; exit 1; }

# ---- Fill in your connection values ----
BASE_URL=""              # your instance API base, e.g. https://<short-code>.api.commercecloud.salesforce.com
SITE_ID=""              # your site id, e.g. RefArch
CLIENT_ID=""              # your SLAS/OCAPI client id
PRODUCT_ID=""              # supply from your environment (no structural producer found)
SHIPPING_METHOD_ID=""              # supply from your environment (no structural producer found)
: "${BASE_URL:?fill in BASE_URL above}" "${SITE_ID:?fill in SITE_ID above}" "${CLIENT_ID:?fill in CLIENT_ID above}" "${PRODUCT_ID:?fill in PRODUCT_ID above}" "${SHIPPING_METHOD_ID:?fill in SHIPPING_METHOD_ID above}"

# Reproduce: post-orders (reference: ocapi-shop-orders)
# Combined scopes required: 

# Auth -- OCAPI-native customers/auth (guest JWT in the response Authorization header)
# Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-customers?meta=post-customers-auth
AUTH_HEADERS=$(curl -sS -D - -o /dev/null -X POST \
  "${BASE_URL}/s/${SITE_ID}/dw/shop/v25_6/customers/auth?client_id=${CLIENT_ID}" \
  -H "Content-Type: application/json" \
  -d '{"type":"guest"}')
ACCESS_TOKEN=$(printf '%s' "$AUTH_HEADERS" | grep -i '^authorization:' | sed 's/^[Aa]uthorization: *[Bb]earer *//' | tr -d '\r')
# Registered shopper? change {"type":"guest"} to {"type":"credentials"} and add:
#   -H "Authorization: Basic $(printf '%s:%s' "$SHOPPER_USER" "$SHOPPER_PASS" | base64)"

# POST /baskets  -- post-baskets
# Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets?meta=post-baskets
# ⚠ Checkout business-rule (curated), NOT stated in the spec: basket must be populated
#   below for the target to accept it. The spec enumerates no required-set; this is
#   curated runtime knowledge.
#   - product_items: at least one line item; POST /orders returns a 400 fault without one
#   - shipments[].shipping_method: a shipping method on the default shipment (id "me"); without it the order total can't be calculated and POST /orders returns a 400 fault
#   - shipments[].shipping_address: a shipping address on the shipment; POST /orders returns a 400 fault (empty shipping address) otherwise
#   - billing_address: a billing address with both first and last name; POST /orders returns a 400 fault (empty/invalid billing address) with none or a missing name (required address fields are merchant-configurable)
#   - payment_instruments: a payment instrument (payment_method_id e.g. CREDIT_CARD + a payment_card); POST /orders returns a 400 fault (missing payment) without one. In the create body the payment_card must use masked_number -- a raw number is rejected there (400 UnknownPropertyException); to send a raw card number use the payment_instruments sub-resource (POST /baskets/{id}/payment_instruments) instead
POST_BASKETS_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/s/${SITE_ID}/dw/shop/v25_6/baskets?client_id=${CLIENT_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "product_items": [
    {
      "product_id": "${PRODUCT_ID}",
      "quantity": 1
    }
  ],
  "shipments": [
    {
      "shipping_method": {
        "id": "${SHIPPING_METHOD_ID}"
      },
      "shipping_address": {
        "first_name": "Jane",
        "last_name": "Doe",
        "address1": "1 Market St",
        "city": "San Francisco",
        "state_code": "CA",
        "postal_code": "94105",
        "country_code": "US"
      }
    }
  ],
  "billing_address": {
    "first_name": "Jane",
    "last_name": "Doe",
    "address1": "1 Market St",
    "city": "San Francisco",
    "state_code": "CA",
    "postal_code": "94105",
    "country_code": "US"
  },
  "payment_instruments": [
    {
      "payment_method_id": "CREDIT_CARD",
      "payment_card": {
        "card_type": "Visa",
        "masked_number": "************4242"
      }
    }
  ]
}
JSON
)

BASKET_ID=$(echo "$POST_BASKETS_RESPONSE" | jq -r .basket_id)

# POST /orders  -- post-orders
# Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders
POST_ORDERS_RESPONSE=$(curl -sS -X POST \
  "${BASE_URL}/s/${SITE_ID}/dw/shop/v25_6/orders?client_id=${CLIENT_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "basket_id": "${BASKET_ID}"
}
JSON
)

echo "$POST_ORDERS_RESPONSE" | jq '{order_no, status, creation_date}'
```

---

## Sources

- https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-customers?meta=post-customers-auth
- https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets?meta=post-baskets
- https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders

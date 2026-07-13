## Prompt

> target op is OCAPI shop-orders `Submit basket` (POST /orders). what are the prerequisites -- which calls have to happen first and where does the basket_id come from? is the basket -> order chain the same as SCAPI?

Skill: `dsc-scenario`. Captured verbatim from `evals/dsc-scenario/synthesis-eval.json` fixture `synthesis-scenario-ocapi-submit-basket` (`iteration-unify-curated-facts`, Sonnet, strict-pass 5/5), executed against a live B2C Commerce sandbox (site RefArch, v25_6). Everything below `## Answer` is byte-for-byte as the skill composed it; the only edits permitted are scrubbing the sandbox realm to a placeholder and dropping a leading reasoning preamble.

## Answer (verbatim skill output)

## Scenario: Submit a basket as a placed order via OCAPI Shop

Target: `POST /orders`   (`ocapi-shop-orders.post-orders`)
References involved: `ocapi-shop-customers`, `ocapi-shop-baskets`, `ocapi-shop-orders`
Combined scopes required: _(none — OCAPI Shop uses the Business Manager client allowlist, not SLAS scopes)_

---

**Instance-config prerequisite:** The client you use must be enabled in Business Manager > Administration > Site Development > Open Commerce API Settings for the Shop API resources you call. OCAPI access is a BM allowlist; denied by default.

---

## Plan

**Step 1 – Obtain a shopper token (OCAPI-native `customers/auth`).**
`POST /customers/auth` on `ocapi-shop-customers`.
- Method/path: `POST /s/{siteId}/dw/shop/v25_6/customers/auth?client_id={CLIENT_ID}`
- Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-customers?meta=post-customers-auth
- Produces: a guest shopper JWT in the **response `Authorization` header** (not the body — the rendered capture dumps headers and greps for it)
- Why: `post-orders` requires a bearer token; `post-baskets` does too. OCAPI Shop's native auth flow is `customers/auth` — body `{"type":"guest"}` for a guest shopper. For a registered shopper, swap the body to `{"type":"credentials"}` and add `Authorization: Basic base64(<user>:<pass>)`.

**Step 2 – Create a basket (populated to the submittable minimum).** `POST /baskets` on `ocapi-shop-baskets`.
- Method/path: `POST /s/{siteId}/dw/shop/v25_6/baskets?client_id={CLIENT_ID}`
- Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets?meta=post-baskets
- Produces: `basket` — the response `basket_id` threads into `POST /orders`
- Why (structural): `post-orders` requires a `basket_id` in the request body; this step's response provides it.
- **The basket must be populated before `POST /orders` accepts it — this is a checkout business-rule (curated), not stated in the spec. The `basket` type declares no `required` fields; this minimum is verified live on a B2C Commerce sandbox (site RefArch, API v25_6). See:** https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders

  Fields that must be present in the create body (each absence → 400 at submit, not at basket create):

  | Field | Why |
  |---|---|
  | `product_items` | at least one line item; `POST /orders` returns a 400 fault without one |
  | `shipments[].shipping_method.id` | shipping method on the shipment; without it the order total can't be calculated → 400 |
  | `shipments[].shipping_address` | shipping address on the shipment → 400 (empty shipping address) |
  | `billing_address` (both `first_name` + `last_name`) | billing address with both names required → 400 |
  | `payment_instruments[].payment_method_id` + `payment_card.card_type` | payment instrument required → 400; `card_type` is the only required leaf (drop-one verified) |
  | `payment_instruments[].payment_card.masked_number` | **OCAPI-specific:** the create body rejects a raw card `number` with 400 `UnknownPropertyException`; use `masked_number` here. To send a real card number, use the `POST /baskets/{id}/payment_instruments` sub-resource instead. |

**Step 3 – Submit the basket as a placed order.** `POST /orders` on `ocapi-shop-orders`.
- Method/path: `POST /s/{siteId}/dw/shop/v25_6/orders?client_id={CLIENT_ID}`
- Spec: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders
- Produces: `order` (the placed order document)
- Why (structural): consumes `basket_id` from Step 2's response; the basket is consumed and a new order resource is created.

---

## SCAPI vs OCAPI — is the chain the same?

**Conceptually yes: prepare basket → submit → order.** Both APIs gate on the same submittable minimum (items, shipping method + address, billing address, payment). But the differences matter for a repro:

| Dimension | OCAPI Shop | SCAPI (Shopper Baskets + Shopper Orders) |
|---|---|---|
| Auth | OCAPI-native `customers/auth` (JWT from response header) | SLAS PKCE / `customers-auth` → bearer token |
| Basket create | `POST /baskets` | `POST /baskets` (Shopper Baskets V2) |
| Field casing | `snake_case` (`product_items`, `billing_address`) | `camelCase` (`productItems`, `billingAddress`) |
| Payment in basket body | `masked_number` only; raw `number` → 400 | raw card number accepted |
| Client param | `?client_id=` on every call | not required |
| Scope config | BM OCAPI allowlist | SLAS client scopes |
| Order submit | `POST /orders` (body: `{"basket_id":"..."}`) | `POST /orders` (body: `{"basketId":"..."}`) |

The submit shape is structurally identical — one call with the basket id, basket is consumed, order is returned. The prep work is the same concept set but spelled differently.

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
#   curated runtime knowledge. Provenance:
#   OCAPI analog of the SCAPI Basket entry, verified live on a B2C Commerce sandbox (site RefArch): the submittable-minimum is the same concept set (items, shipping, billing, payment); OCAPI differs in snake_case casing and the payment shape. Runtime-verified end to end: a single POST /baskets body with product_items + shipments(method+address) + billing_address + payment_instruments(payment_card.card_type + masked_number) submits to a placed order; a raw card number in the create-body payment_card 400s (UnknownPropertyException) and must go through the payment_instruments sub-resource. The payment_card sub-shape was drop-one verified on a live B2C Commerce sandbox (site RefArch, API v25_6) on 2026-07-11: with payment_method_id CREDIT_CARD, card_type is the ONLY required payment_card leaf -- dropping it 400s InvalidPaymentMethodIdException (CREDIT_CARD (unknown)) at basket create, while expiration_month and expiration_year each individually drop with the order STILL placing, so they are above the minimum and are not shipped. masked_number is retained (not a holder/expiry-class drop candidate): it is the card-number field in its runtime-verified masked form -- raw `number` is rejected at create, the masked_number correction -- and the certainty-layer inverse-validated citizen (test-submittability-schema.js). The OCAPI basket type declares no required-set, so this is curated runtime knowledge, not spec-derived. General citation that an OCAPI order is submitted from a prepared basket: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders
#   - product_items: at least one line item; POST /orders returns a 400 fault without one
#   - shipments[].shipping_method: a shipping method on the default shipment (id "me"); without it the order total can't be calculated and POST /orders returns a 400 fault
#   - shipments[].shipping_address: a shipping address on the shipment; POST /orders returns a 400 fault (empty shipping address) otherwise
#   - billing_address: a billing address with both first and last name; POST /orders returns a 400 fault (empty/invalid billing address) with none or a missing name (both names required -- platform order-validation behavior, re-verify on a platform release)
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
```

---

## Sources
- https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-customers?meta=post-customers-auth
- https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets?meta=post-baskets
- https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders

---

**The short answer on SCAPI parity:** same 3-step conceptual chain (auth → create basket → submit), same submittable-minimum gate (items + shipping + billing + payment), but OCAPI differs in three ways worth knowing before you start typing: snake_case field names, `masked_number` (not raw `number`) in the basket create body, and `?client_id=` on every call. The `basket_id` comes from `POST /baskets`'s response in both APIs.
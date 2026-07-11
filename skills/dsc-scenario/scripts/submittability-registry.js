'use strict';

// Curated submittability registry DATA (converted from the former JSON data file).
// Same species as lib/b2c-corrections.js: curated + version-controlled + cited =
// an ENCODED FACT, not model fabrication. The CONSUMER is scripts/submittability.js
// (applySubmittability); this file is data only.
//
// Keys are the spec's REQUEST-body type names, and they are CASE-SENSITIVE:
//   "Basket"  -> SCAPI  (area commerce_commerce-api)   -- capital B
//   "basket"  -> OCAPI  (area commerce_b2c-commerce)   -- lowercase b   (!!)
// A miscased key silently no-ops the registry lookup, so each entry now carries an
// explicit `family` ('SCAPI'|'OCAPI') that this file's validator checks. A future
// schema-validation test (tests/test-submittability-schema.js) will add the
// family-guard proper: it will assert each entry's declared family matches the cache
// area its type loads from, catching a mis-cased/mis-filed entry.

// The address shape recurs 4x (SCAPI billing+shipping, OCAPI billing+shipping).
// Author the 7 required address fields once; snake toggles casing. Both first +
// last name are required (createOrder returns 400 "Invalid Billing Address" on a
// missing name -- see the Basket provenance).
const addr = (base, { snake }) => {
  const fields = snake
    ? ['first_name', 'last_name', 'address1', 'city', 'state_code', 'postal_code', 'country_code']
    : ['firstName', 'lastName', 'address1', 'city', 'stateCode', 'postalCode', 'countryCode'];
  return fields.map((f) => `${base}.${f}`);
};

const SUBMITTABILITY = {
  Basket: {
    note: `createBasket always returns 200 and never enforces submittability; the entire required-set is gated at createOrder. The spec's Basket.required is null and the basket-prep prose states no hard required-set, so this minimum is curated runtime knowledge, not derivable from the reference. It is satisfied by populating the createBasket request body (the maintainer's preferred single-call shape), not by separate populate calls.`,
    submittableVia: 'producer-body',
    needed: [],
    bodyContents: [
      { field: 'productItems', why: `at least one line item; createOrder returns 400 "Product Items Required" otherwise` },
      { field: 'shipments[].shippingMethod', why: `a shipping method on the default shipment (id "me"); without it createOrder returns 400 Validation "Order total missing, calculation failed" (shipping cost is an order-total component)` },
      { field: 'shipments[].shippingAddress', why: `a shipping address on the shipment; createOrder returns 400 "Empty Shipping Address" otherwise` },
      { field: 'billingAddress', why: `a billing address with both first and last name; createOrder returns 400 "Empty Billing Address" with none, and 400 "Invalid Billing Address" if a name is missing (required address fields are merchant-configurable, so the exact name requirement is instance-observed)` },
      { field: 'paymentInstruments', why: `a payment instrument (e.g. paymentMethodId CREDIT_CARD); createOrder returns 400 "Missing Payment Method Id" without one` },
    ],
    provenance: `Empirically verified on a live B2C Commerce instance (drop-one testing against shopper-baskets-v2 + shopper-orders): each top-level + address field above is individually required by createOrder, which returns a distinct 400 when it is absent. The paymentCard sub-shape was itself drop-one verified on realm abcd_001, site RefArch, API v25_6 (RefArch v25_6) on 2026-07-11: with paymentMethodId CREDIT_CARD, cardType is the ONLY required paymentCard leaf -- dropping it 400s "Invalid Payment Method Id" (CREDIT_CARD (unknown)) at basket create, while holder, expirationMonth, and expirationYear each individually drop with the order STILL placing, so they are above the minimum and are not shipped. Neither the machine-readable spec (Basket.required is null) nor the basket-prep prose enumerates this set. General citation that orders are built from prepared baskets: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder`,
    confidence: 'curated',
    family: 'SCAPI',
    // Nested leaf paths encode the submittable body STRUCTURE. [] = array element,
    // . = nesting. Values are resolved by _shared/body-values.js at render time.
    // Card sub-shape is DROP-ONE LIVE-VERIFIED (Task 8, abcd_001 / RefArch v25_6,
    // 2026-07-11): cardType is the only required paymentCard leaf; holder +
    // expiration* each dropped with the order still placing, so they are NOT
    // shipped. cardType + top-level + address are all pinned by that verification
    // (see `provenance`).
    leaves: [
      'productItems[].productId',
      'productItems[].quantity',
      'shipments[].shippingMethod.id',
      ...addr('shipments[].shippingAddress', { snake: false }),
      ...addr('billingAddress', { snake: false }),
      'paymentInstruments[].paymentMethodId',
      'paymentInstruments[].paymentCard.cardType',
    ],
    // TEST-ONLY: the request root type (Basket) is response-shaped -- traversing it
    // lands on RESPONSE element types (OrderPaymentInstrument, PaymentCard) that
    // coincidentally share leaf names. These pins tell the validation test which
    // REQUEST type is truthful at the payment boundary. The renderer never reads this.
    elementTypes: {
      'paymentInstruments[]': 'BasketPaymentInstrumentRequest',
      'paymentInstruments[].paymentCard': 'OrderPaymentCardRequest',
    },
  },
  basket: {
    note: `OCAPI's Submit basket (POST /orders) enforces the same submittable-minimum as SCAPI's createOrder: the basket must carry line items, a shipping method + address, a billing address, and a payment instrument before the order is accepted. The gate is at order submit, not basket creation (POST /baskets always returns the basket). Field casing is snake_case (product_items, billing_address, ...). Payment has an OCAPI-specific twist verified live: in the single POST /baskets create body the payment_card takes masked_number and REJECTS a raw number (400 UnknownPropertyException 'unknown property number'); a raw card number only works on the payment_instruments sub-resource (POST /baskets/{id}/payment_instruments). So the single-call default populates payment_card.masked_number; the raw-number path is the separate sub-resource POST. This minimum is curated runtime knowledge -- the OCAPI basket type declares no required-set -- not derivable from the reference.`,
    submittableVia: 'producer-body',
    needed: [],
    bodyContents: [
      { field: 'product_items', why: `at least one line item; POST /orders returns a 400 fault without one` },
      { field: 'shipments[].shipping_method', why: `a shipping method on the default shipment (id "me"); without it the order total can't be calculated and POST /orders returns a 400 fault` },
      { field: 'shipments[].shipping_address', why: `a shipping address on the shipment; POST /orders returns a 400 fault (empty shipping address) otherwise` },
      { field: 'billing_address', why: `a billing address with both first and last name; POST /orders returns a 400 fault (empty/invalid billing address) with none or a missing name (required address fields are merchant-configurable)` },
      { field: 'payment_instruments', why: `a payment instrument (payment_method_id e.g. CREDIT_CARD + a payment_card); POST /orders returns a 400 fault (missing payment) without one. In the create body the payment_card must use masked_number -- a raw number is rejected there (400 UnknownPropertyException); to send a raw card number use the payment_instruments sub-resource (POST /baskets/{id}/payment_instruments) instead` },
    ],
    provenance: `OCAPI analog of the SCAPI Basket entry, verified live on a B2C Commerce instance (RefArch): the submittable-minimum is the same concept set (items, shipping, billing, payment); OCAPI differs in snake_case casing and the payment shape. Runtime-verified end to end: a single POST /baskets body with product_items + shipments(method+address) + billing_address + payment_instruments(payment_card.card_type + masked_number) submits to a placed order; a raw card number in the create-body payment_card 400s (UnknownPropertyException) and must go through the payment_instruments sub-resource. The payment_card sub-shape was drop-one verified on realm abcd_001, site RefArch, API v25_6 (RefArch v25_6) on 2026-07-11: with payment_method_id CREDIT_CARD, card_type is the ONLY required payment_card leaf -- dropping it 400s InvalidPaymentMethodIdException (CREDIT_CARD (unknown)) at basket create, while expiration_month and expiration_year each individually drop with the order STILL placing, so they are above the minimum and are not shipped. masked_number is retained (not a holder/expiry-class drop candidate): it is the card-number field in its runtime-verified masked form -- raw \`number\` is rejected at create, the masked_number correction -- and the certainty-layer inverse-validated citizen (test-submittability-schema.js). The OCAPI basket type declares no required-set, so this is curated runtime knowledge, not spec-derived. General citation that an OCAPI order is submitted from a prepared basket: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders`,
    confidence: 'curated',
    family: 'OCAPI',
    // Card sub-shape DROP-ONE LIVE-VERIFIED (Task 8, abcd_001 / RefArch v25_6,
    // 2026-07-11): card_type is the only required payment_card leaf; expiration_*
    // each dropped with the order still placing, so they are NOT shipped.
    // masked_number stays -- it is the masked_number correction citizen (raw
    // `number` 400s), not a drop candidate (see `provenance`).
    leaves: [
      'product_items[].product_id',
      'product_items[].quantity',
      'shipments[].shipping_method.id',
      ...addr('shipments[].shipping_address', { snake: true }),
      ...addr('billing_address', { snake: true }),
      'payment_instruments[].payment_method_id',
      'payment_instruments[].payment_card.card_type',
      'payment_instruments[].payment_card.masked_number', // NOT raw `number` (see masked_number correction)
    ],
    elementTypes: {
      'payment_instruments[]': 'basket_payment_instrument_request',
      'payment_instruments[].payment_card': 'order_payment_card_request',
    },
  },
};

// Load-time integrity check, mirroring assertCorrectionsWellFormed. Validates the
// preserved shape plus the family/leaves/elementTypes fields each entry carries.
function assertRegistryWellFormed(reg) {
  if (!reg || typeof reg !== 'object') throw new Error('SUBMITTABILITY must be an object');
  for (const [key, e] of Object.entries(reg)) {
    const where = `submittability entry '${key}'`;
    if (!Array.isArray(e.bodyContents) || e.bodyContents.length === 0) {
      throw new Error(`${where}: bodyContents must be a non-empty array`);
    }
    for (const c of e.bodyContents) {
      if (!c || !c.field || !c.why) throw new Error(`${where}: each bodyContents entry needs field + why`);
    }
    if (typeof e.provenance !== 'string' || !/developer\.salesforce\.com/.test(e.provenance)) {
      throw new Error(`${where}: provenance must cite a public developer.salesforce.com URL`);
    }
    if (e.confidence !== 'curated') throw new Error(`${where}: confidence must be 'curated'`);
    if (e.family !== 'SCAPI' && e.family !== 'OCAPI') throw new Error(`${where}: family must be SCAPI|OCAPI`);
    if (!Array.isArray(e.leaves) || e.leaves.length === 0) throw new Error(`${where}: leaves must be a non-empty array`);
    for (const p of e.leaves) {
      if (typeof p !== 'string' || !p) throw new Error(`${where}: each leaf is a non-empty path string`);
    }
    for (const prefix of Object.keys(e.elementTypes || {})) {
      if (!e.leaves.some((p) => p === prefix || p.startsWith(`${prefix}.`))) {
        throw new Error(`${where}: elementTypes prefix '${prefix}' names no leaf`);
      }
    }
  }
}

assertRegistryWellFormed(SUBMITTABILITY);

module.exports = { SUBMITTABILITY, assertRegistryWellFormed };

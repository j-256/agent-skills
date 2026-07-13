'use strict';

// B2C Commerce spec-correction registry -- the product-specific DATA the generic
// verifier in auth-providers.js consumes. Each correction asserts a fact that
// OVERRIDES what a spec declares, and (where a spec field exists to watch) carries
// a specAnchor so it SELF-INVALIDATES when that field drifts. See
// docs/commerce-auth-matrix.md "Spec corrections and their self-invalidation".
//
// Volatility is DERIVED from shape (deriveVolatility), never stored:
//   - specAnchor present  -> spec-divergence (watch the field; the drift-prone class)
//   - infraInvariant flag -> infra-invariant (no spec field to watch; e.g. an auth host)
//   - otherwise           -> platform-behavior (a dated runtime fact; re-verify on cadence)
//
// The two citizens below are two DIFFERENT field kinds, proving the framework
// general with real facts rather than a promise:
//   1. auth-admin      -- an INLINE security[] field; anchor watches a wrong VALUE
//   2. masked_number   -- a $ref-resolved SCHEMA field; anchor watches a wrong PROPERTY still present

const { typeHasProperty, loadType, normalizeSchema } = require('./spec-traversal.js');

// Every scope under a BearerToken scheme is a *_ADMIN role. Both the observed
// forms ([SLAS_SERVICE_ADMIN] and [SLAS_SERVICE_ADMIN, SLAS_ORGANIZATION_ADMIN])
// satisfy it; a spec that regenerates to name the real gate (e.g. CCDX_SBX_USER)
// stops matching -> drifted -> re-verify.
const ADMIN_ROLE = /^SLAS_.*_ADMIN$/;

// The address shape recurs 4x (SCAPI billing+shipping, OCAPI billing+shipping).
// Author the 7 required address fields once; snake toggles casing. Both first +
// last name are required (createOrder returns 400 "Invalid Billing Address" on a
// missing name -- see the Basket provenance). Used by the producer-body leaves below.
const addr = (base, { snake }) => {
  const fields = snake
    ? ['first_name', 'last_name', 'address1', 'city', 'state_code', 'postal_code', 'country_code']
    : ['firstName', 'lastName', 'address1', 'city', 'stateCode', 'postalCode', 'countryCode'];
  return fields.map((f) => `${base}.${f}`);
};

const B2C_CURATED_FACTS = [
  {
    attach: 'note',
    id: 'auth-admin-sandbox-api-user',
    // SLAS Admin control-plane API. SCAPI area, auth-admin reference.
    match: (c) => c && c.area === 'commerce_commerce-api' && c.reference === 'auth-admin',
    claim: 'auth-admin (SLAS Admin) is gated by the Account Manager "Sandbox API User" role (CCDX_SBX_USER), '
      + 'filtered to the target instance -- NOT the SLAS_SERVICE_ADMIN / SLAS_ORGANIZATION_ADMIN roles its '
      + 'security[] declares. Mint a plain AM client_credentials token (scope SALESFORCE_COMMERCE_API:<tenant>) '
      + 'whose API client holds that role with the instance in its filter; a token with no SLAS-admin role returns 200.',
    basis: 'runtime-verified',
    verifiedOn: [
      { date: '2026-07-02', coords: { tenant: 'abcd_001', instanceType: 'ods-sandbox', apiVersion: 'v1' } },
    ],
    scope: 'Verified on an on-demand sandbox (ODS) only; production/PIG behavior not independently characterized -- re-verify if your instance type differs.',
    specAnchor: {
      field: 'security',
      saw: 'BearerToken: every scope matches /^SLAS_.*_ADMIN$/ (the declared-but-not-enforced admin roles)',
      // Inline field: read the op's own security[]. compose supplies ctx.opDoc.
      read: (ctx) => (ctx && ctx.opDoc && ctx.opDoc.endpoint && ctx.opDoc.endpoint.security) || null,
      holds: (security) => {
        if (!Array.isArray(security)) return false;
        const bearer = security.find((s) => s && s.scheme === 'BearerToken');
        if (!bearer || !Array.isArray(bearer.scopes) || bearer.scopes.length === 0) return false;
        return bearer.scopes.every((s) => ADMIN_ROLE.test(s));
      },
    },
    provenance: 'docs/commerce-auth-matrix.md "SLAS Admin (auth-admin)" section; runtime-verified end to end '
      + '(retrieveTenant / retrieveClients returned 200 with a Sandbox-API-User token and no SLAS-admin role).',
    cite: 'https://developer.salesforce.com/docs/commerce/commerce-api/guide/authorization-for-admin-apis.html',
  },
  {
    attach: 'note',
    id: 'ocapi-create-body-masked-number',
    // OCAPI Shop baskets, the create-body payment card shape.
    match: (c) => c && c.area === 'commerce_b2c-commerce' && c.reference === 'ocapi-shop-baskets'
      && (c.method || '').toUpperCase() === 'POST',
    claim: 'In the OCAPI POST /baskets create body, payment_card requires masked_number; a raw number is rejected '
      + 'there (400 UnknownPropertyException "unknown property number"). To send a raw card number, use the '
      + 'payment_instruments sub-resource (POST /baskets/{id}/payment_instruments) instead.',
    basis: 'runtime-verified',
    verifiedOn: [
      { date: '2026-07-02', coords: { tenant: 'abcd_001', instanceType: 'ods-sandbox', release: 'v25_6', site: 'RefArch' } },
    ],
    scope: 'Verified on an ODS sandbox (RefArch, v25_6); the raw-vs-masked split is per-endpoint (create body vs sub-resource), not per-product -- re-verify on a platform release.',
    specAnchor: {
      field: 'order_payment_card_request.number',
      saw: 'the create-body card leaf type order_payment_card_request declares a raw `number` property (which runtime rejects)',
      // Schema field: the create-body payment_card $ref resolves to order_payment_card_request, whose raw
      // `number` property is the thing runtime refuses. Anchor holds while the spec keeps offering it.
      // ctx carries cacheRoot/area/reference; typeHasProperty reads the leaf type directly (no $ref chase --
      // order_payment_card_request IS the leaf and declares `number` as a direct property).
      read: (ctx) => typeHasProperty(ctx.cacheRoot, ctx.reference, 'order_payment_card_request', 'number', ctx.area),
      holds: (hasRawNumber) => hasRawNumber === true,
    },
    provenance: 'docs/commerce-auth-matrix.md request-shape table + "Payment shape" note; runtime-verified '
      + '(create-body masked_number places an order; raw number 400s and works only via the payment_instruments sub-resource).',
    cite: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-baskets?meta=post-baskets',
  },
  {
    attach: 'producer-body',
    id: 'scapi-basket-submittable-minimum',
    // SCAPI Basket producer body: the createBasket request-body minimum that
    // createOrder gates on. producesType (capital-B `Basket`) replaces the former
    // registry object KEY; family binds it to the SCAPI cache area.
    producesType: 'Basket',
    family: 'SCAPI',
    claim: 'The SCAPI createOrder submittable-minimum -- the Basket fields createBasket must populate '
      + '(at least one line item, a shipping method + address, a billing address, a payment instrument) -- '
      + 'is curated runtime knowledge, not in the reference (Basket.required is null and the basket-prep prose '
      + 'states no hard required-set).',
    note: `createBasket always returns 200 and never enforces submittability; the entire required-set is gated at createOrder. The spec's Basket.required is null and the basket-prep prose states no hard required-set, so this minimum is curated runtime knowledge, not derivable from the reference. It is satisfied by populating the createBasket request body (the maintainer's preferred single-call shape), not by separate populate calls.`,
    submittableVia: 'producer-body',
    needed: [],
    bodyContents: [
      { field: 'productItems', why: `at least one line item; createOrder returns 400 "Product Items Required" otherwise` },
      { field: 'shipments[].shippingMethod', why: `a shipping method on the default shipment (id "me"); without it createOrder returns 400 Validation "Order total missing, calculation failed" (shipping cost is an order-total component)` },
      { field: 'shipments[].shippingAddress', why: `a shipping address on the shipment; createOrder returns 400 "Empty Shipping Address" otherwise` },
      { field: 'billingAddress', why: `a billing address with both first and last name; createOrder returns 400 "Empty Billing Address" with none, and 400 "Invalid Billing Address" if a name is missing (both names required -- drop-one verified first-only and last-only each 400, both 200; platform order-validation behavior, re-verify on a platform release)` },
      { field: 'paymentInstruments', why: `a payment instrument (e.g. paymentMethodId CREDIT_CARD); createOrder returns 400 "Missing Payment Method Id" without one` },
    ],
    // Nested leaf paths encode the submittable body STRUCTURE. [] = array element,
    // . = nesting. Values are resolved by _shared/body-values.js at render time.
    // Card sub-shape is DROP-ONE LIVE-VERIFIED (RefArch v25_6, 2026-07-11):
    // cardType is the only required paymentCard leaf; holder + expiration* each
    // dropped with the order still placing, so they are NOT shipped. cardType +
    // top-level + address are all pinned by that verification (see `provenance`).
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
    confidence: 'curated',
    basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-11', coords: { site: 'RefArch', release: 'v25_6' } }],
    scope: 'Drop-one verified on a live B2C Commerce ODS sandbox (site RefArch, API v25_6) on 2026-07-11; this is platform order-validation behavior (the gate is at createOrder, not per-instance config) -- re-verify on a platform release.',
    provenance: `Empirically verified on a live B2C Commerce sandbox (drop-one testing against shopper-baskets-v2 + shopper-orders, site RefArch): each top-level + address field above is individually required by createOrder, which returns a distinct 400 when it is absent. The paymentCard sub-shape was itself drop-one verified on a live B2C Commerce sandbox (site RefArch, API v25_6) on 2026-07-11: with paymentMethodId CREDIT_CARD, cardType is the ONLY required paymentCard leaf -- dropping it 400s "Invalid Payment Method Id" (CREDIT_CARD (unknown)) at basket create, while holder, expirationMonth, and expirationYear each individually drop with the order STILL placing, so they are above the minimum and are not shipped. Neither the machine-readable spec (Basket.required is null) nor the basket-prep prose enumerates this set. General citation that orders are built from prepared baskets: https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder`,
    cite: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-orders?meta=createOrder',
  },
  {
    attach: 'producer-body',
    id: 'ocapi-basket-submittable-minimum',
    // OCAPI basket producer body: the POST /baskets create-body minimum that
    // POST /orders (Submit basket) gates on. producesType (lowercase `basket`)
    // replaces the former registry object KEY; family binds it to the OCAPI area.
    producesType: 'basket',
    family: 'OCAPI',
    // Cross-reference to the masked_number NOTE citizen: the OCAPI create-body
    // payment_card takes masked_number (raw `number` 400s). Points at the note that
    // explains and self-invalidates that split. Validated to name an existing fact id.
    seeAlso: 'ocapi-create-body-masked-number',
    claim: 'The OCAPI Submit-basket (POST /orders) submittable-minimum -- the basket fields the create body must '
      + 'populate (product_items, a shipping method + address, a billing address, payment_instruments with '
      + 'payment_card.masked_number) -- is curated runtime knowledge, not in the reference (the OCAPI basket type '
      + 'declares no required-set).',
    note: `OCAPI's Submit basket (POST /orders) enforces the same submittable-minimum as SCAPI's createOrder: the basket must carry line items, a shipping method + address, a billing address, and a payment instrument before the order is accepted. The gate is at order submit, not basket creation (POST /baskets always returns the basket). Field casing is snake_case (product_items, billing_address, ...). Payment has an OCAPI-specific twist verified live: in the single POST /baskets create body the payment_card takes masked_number and REJECTS a raw number (400 UnknownPropertyException 'unknown property number'); a raw card number only works on the payment_instruments sub-resource (POST /baskets/{id}/payment_instruments). So the single-call default populates payment_card.masked_number; the raw-number path is the separate sub-resource POST. This minimum is curated runtime knowledge -- the OCAPI basket type declares no required-set -- not derivable from the reference.`,
    submittableVia: 'producer-body',
    needed: [],
    bodyContents: [
      { field: 'product_items', why: `at least one line item; POST /orders returns a 400 fault without one` },
      { field: 'shipments[].shipping_method', why: `a shipping method on the default shipment (id "me"); without it the order total can't be calculated and POST /orders returns a 400 fault` },
      { field: 'shipments[].shipping_address', why: `a shipping address on the shipment; POST /orders returns a 400 fault (empty shipping address) otherwise` },
      { field: 'billing_address', why: `a billing address with both first and last name; POST /orders returns a 400 fault (empty/invalid billing address) with none or a missing name (both names required -- platform order-validation behavior, re-verify on a platform release)` },
      { field: 'payment_instruments', why: `a payment instrument (payment_method_id e.g. CREDIT_CARD + a payment_card); POST /orders returns a 400 fault (missing payment) without one. In the create body the payment_card must use masked_number -- a raw number is rejected there (400 UnknownPropertyException); to send a raw card number use the payment_instruments sub-resource (POST /baskets/{id}/payment_instruments) instead` },
    ],
    // Card sub-shape DROP-ONE LIVE-VERIFIED (RefArch v25_6, 2026-07-11): card_type
    // is the only required payment_card leaf; expiration_* each dropped with the
    // order still placing, so they are NOT shipped. masked_number stays -- it is
    // the masked_number correction citizen (raw `number` 400s), not a drop
    // candidate (see `provenance`).
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
    confidence: 'curated',
    basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-11', coords: { site: 'RefArch', release: 'v25_6' } }],
    scope: 'Drop-one verified on a live B2C Commerce ODS sandbox (site RefArch, API v25_6) on 2026-07-11; this is platform order-validation behavior (the gate is at POST /orders, not per-instance config), and the raw-vs-masked payment split is per-endpoint (create body vs payment_instruments sub-resource) -- re-verify on a platform release.',
    provenance: `OCAPI analog of the SCAPI Basket entry, verified live on a B2C Commerce sandbox (site RefArch): the submittable-minimum is the same concept set (items, shipping, billing, payment); OCAPI differs in snake_case casing and the payment shape. Runtime-verified end to end: a single POST /baskets body with product_items + shipments(method+address) + billing_address + payment_instruments(payment_card.card_type + masked_number) submits to a placed order; a raw card number in the create-body payment_card 400s (UnknownPropertyException) and must go through the payment_instruments sub-resource. The payment_card sub-shape was drop-one verified on a live B2C Commerce sandbox (site RefArch, API v25_6) on 2026-07-11: with payment_method_id CREDIT_CARD, card_type is the ONLY required payment_card leaf -- dropping it 400s InvalidPaymentMethodIdException (CREDIT_CARD (unknown)) at basket create, while expiration_month and expiration_year each individually drop with the order STILL placing, so they are above the minimum and are not shipped. masked_number is retained (not a holder/expiry-class drop candidate): it is the card-number field in its runtime-verified masked form -- raw \`number\` is rejected at create, the masked_number correction -- and the certainty-layer inverse-validated citizen (test-submittability-schema.js). The OCAPI basket type declares no required-set, so this is curated runtime knowledge, not spec-derived. General citation that an OCAPI order is submitted from a prepared basket: https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders`,
    cite: 'https://developer.salesforce.com/docs/commerce/b2c-commerce/references/ocapi-shop-orders?meta=post-orders',
  },
  {
    id: 'scapi-add-payment-instrument-body',
    attach: 'op-body',
    family: 'SCAPI',
    // Match the addPaymentInstrumentToBasket REST identity (same identity shape the
    // note corrections use). Path-regex is stable across version families.
    match: (c) => c && c.area === 'commerce_commerce-api'
      && /^shopper-baskets(-v\d+)?$/.test(c.reference || '')
      && (c.method || '').toUpperCase() === 'POST'
      && /\/baskets\/\{basketId\}\/payment-instruments$/.test(c.path || ''),
    claim: 'addPaymentInstrumentToBasket requires a request body at runtime: although its request type '
      + 'BasketPaymentInstrumentRequest enumerates no required properties (so the type-graph walk emits no '
      + 'body), a bodyless call returns 400 "The null value constraint for parameter Body was violated." '
      + 'The live-verified minimum is paymentMethodId + paymentCard.cardType.',
    basis: 'runtime-verified',
    verifiedOn: [{ date: '2026-07-12', coords: { site: 'RefArch', release: 'v25_6' } }],
    scope: 'Verified on an ODS sandbox (site RefArch, v25_6); this is platform runtime behavior (a bodyless call 400s at the API layer, not per-instance config) -- re-verify on a platform release.',
    leaves: ['paymentMethodId', 'paymentCard.cardType'],
    bodyContents: [
      { field: 'paymentMethodId', why: 'the payment method (e.g. CREDIT_CARD); a bodyless call 400s the null-Body constraint' },
      { field: 'paymentCard.cardType', why: 'cardType is the runtime-required card leaf -- paymentMethodId alone adds nothing' },
    ],
    specAnchor: {
      field: 'BasketPaymentInstrumentRequest.required',
      saw: 'the request type declares NO required properties (the spec marks the body itself required:true '
        + 'but enumerates no required fields), so the type-graph walk emits no body',
      // Read the request type's normalized `required` array (or [] if absent). ctx carries
      // cacheRoot/area/reference. shopper-baskets-v2 is the SCAPI reference for this op.
      read: (ctx) => {
        const doc = loadType(ctx.cacheRoot, ctx.reference, 'BasketPaymentInstrumentRequest', ctx.area);
        if (!doc) return null; // can't read -> drifted -> re-verify (never silent trust)
        const s = normalizeSchema(doc.type && doc.type.schema) || {};
        return Array.isArray(s.required) ? s.required : [];
      },
      // Holds while no property is required. A regen that adds a required prop -> the walk
      // would surface it structurally, and this fact must re-verify.
      holds: (req) => (Array.isArray(req) ? req.length === 0 : req == null),
    },
    provenance: 'Runtime-verified on a live B2C Commerce sandbox (RefArch, v25_6, 2026-07-12): a bodyless '
      + 'addPaymentInstrumentToBasket 400s the null-Body constraint; {paymentMethodId:CREDIT_CARD, '
      + 'paymentCard:{cardType:Visa}} adds an instrument. cardType is required -- paymentMethodId alone '
      + 'adds nothing. General citation: '
      + 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket',
    cite: 'https://developer.salesforce.com/docs/commerce/commerce-api/references/shopper-baskets-v2?meta=addPaymentInstrumentToBasket',
  },
];

// Conditional-completeness validator. Not field-presence theater: the requiredness
// encodes what each class of fact demands, so an author cannot ship an under-specified
// correction. Runs at module load (below) AND as a standalone test.
function assertCuratedFactsWellFormed(facts) {
  if (!Array.isArray(facts)) throw new Error('B2C_CURATED_FACTS must be an array');
  for (const c of facts) {
    const where = `curated-fact '${c && c.id ? c.id : '(no id)'}'`;
    if (!c || typeof c.id !== 'string' || !c.id) throw new Error(`${where}: missing id`);
    const attach = c.attach;
    if (!['note', 'producer-body', 'op-body'].includes(attach)) {
      throw new Error(`${where}: attach must be note|producer-body|op-body (got ${attach})`);
    }
    // Common spine: every fact carries claim/provenance/basis/cite.
    if (typeof c.claim !== 'string' || !c.claim) throw new Error(`${where}: missing claim`);
    if (typeof c.provenance !== 'string' || !c.provenance) throw new Error(`${where}: missing provenance`);
    if (!['runtime-verified', 'doc-stated', 'platform-owner'].includes(c.basis)) {
      throw new Error(`${where}: basis must be runtime-verified|doc-stated|platform-owner`);
    }
    if (c.basis === 'runtime-verified' && !(Array.isArray(c.verifiedOn) && c.verifiedOn.length > 0)) {
      throw new Error(`${where}: runtime-verified needs a non-empty verifiedOn`);
    }
    if (!('cite' in c)) throw new Error(`${where}: cite is required (a URL, or explicit null)`);
    // Match is required for match-triggered modes (note, op-body); producer-body
    // triggers on producesType instead (Task 2).
    if ((attach === 'note' || attach === 'op-body') && typeof c.match !== 'function') {
      throw new Error(`${where}: ${attach} requires a match function`);
    }
    // specAnchor conditional-completeness (unchanged from today; applies to any anchored fact).
    if (c.specAnchor) {
      const a = c.specAnchor;
      if (typeof a.field !== 'string' || !a.field) throw new Error(`${where}: specAnchor.field required`);
      if (typeof a.saw !== 'string' || !a.saw) throw new Error(`${where}: specAnchor.saw (readable snapshot) required`);
      if (typeof a.read !== 'function') throw new Error(`${where}: specAnchor.read must be a function`);
      if (typeof a.holds !== 'function') throw new Error(`${where}: specAnchor.holds must be a function`);
      if (typeof c.scope !== 'string' || !c.scope) throw new Error(`${where}: an anchored fact needs an explicit scope bounds string`);
    }
    if (attach === 'producer-body' || attach === 'op-body') {
      if (attach === 'producer-body' && (typeof c.producesType !== 'string' || !c.producesType)) {
        throw new Error(`${where}: producer-body requires producesType (the produced body-type name)`);
      }
      if (c.family !== 'SCAPI' && c.family !== 'OCAPI') throw new Error(`${where}: body mode requires family SCAPI|OCAPI`);
      // Body-mode provenance renders into the user-facing curl banner (curl-block.js),
      // so it MUST cite a public developer.salesforce.com URL -- a ~/.cache or skill-file
      // path would leak a non-shareable location. (note facts are exempt: their
      // provenance legitimately cites docs/commerce-auth-matrix.md and is never rendered.)
      if (!/developer\.salesforce\.com/.test(c.provenance)) {
        throw new Error(`${where}: body-mode provenance must cite a public developer.salesforce.com URL`);
      }
      if (!Array.isArray(c.leaves) || c.leaves.length === 0) throw new Error(`${where}: body mode requires a non-empty leaves[]`);
      for (const p of c.leaves) if (typeof p !== 'string' || !p) throw new Error(`${where}: each leaf is a non-empty path string`);
      if (!Array.isArray(c.bodyContents) || c.bodyContents.length === 0) throw new Error(`${where}: body mode requires a non-empty bodyContents[]`);
      for (const bc of c.bodyContents) if (!bc || !bc.field || !bc.why) throw new Error(`${where}: each bodyContents entry needs field + why`);
      for (const prefix of Object.keys(c.elementTypes || {})) {
        if (!c.leaves.some((p) => p === prefix || p.startsWith(`${prefix}.`))) {
          throw new Error(`${where}: elementTypes prefix '${prefix}' names no leaf`);
        }
      }
    }
  }
  // seeAlso (optional) must name an existing fact id -- a whole-registry cross-ref
  // pass, so a cross-reference cannot outlive the fact it points at (drift guard).
  const ids = new Set(facts.map((c) => c.id));
  for (const c of facts) {
    if (c.seeAlso != null && !ids.has(c.seeAlso)) {
      throw new Error(`curated-fact '${c.id}': seeAlso '${c.seeAlso}' names no existing fact`);
    }
  }
}

assertCuratedFactsWellFormed(B2C_CURATED_FACTS);

module.exports = { B2C_CURATED_FACTS, assertCuratedFactsWellFormed };

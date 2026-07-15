# Commerce auth model: SCAPI vs OCAPI

**Audience:** contributors extending `dsc-scenario` (and the future runtime-triage skills). This documents how authentication differs across the four B2C Commerce API planes, and how the skill's auth-provider registry routes between them. The facts here are empirical – verified against a live B2C Commerce sandbox by minting each token type and calling each plane – not spec-derived: the machine-readable specs declare the *scheme* per endpoint but not the cross-plane runtime behavior.

The code that encodes this lives in `skills/_shared/auth-providers.js` (the product-neutral registry) and `skills/_shared/b2c-auth-providers.js` (B2C's provider set). This doc is the "why" behind that data.

## The four planes

| Plane | Reference family | Declared scheme(s) | Token needed |
|---|---|---|---|
| SCAPI Shopper | `shopper-*` (`commerce_commerce-api`) | `ShopperToken` | SLAS shopper token |
| SCAPI Admin | `orders`, etc. (`commerce_commerce-api`) | `AmOAuth2` (or `BearerToken`+`SLAS_*`) | AM app token |
| OCAPI Shop | `ocapi-shop-*` (`commerce_b2c-commerce`) | `customers_auth`, `oauth2_application`, `client_id` | any shopper-identity bearer |
| OCAPI Data | `ocapi-data-*` (`commerce_b2c-commerce`) | `oauth2_application` (+`client_id`) | any valid AM app token |

The decisive routing fact: **OCAPI Shop and OCAPI Data declare the same schemes**, so the declared scheme cannot disambiguate them. Route on the reference family (`ocapi-shop-*` vs `ocapi-data-*`), not the scheme. SCAPI, by contrast, is routable by scheme (`ShopperToken` vs `AmOAuth2`).

## Token types

- **SLAS shopper token** – from Shopper Login (SLAS): guest via public-client PKCE or private-client `client_credentials`; registered via `authenticateCustomer`/`authorizeCustomer` + `getAccessToken`. Carries a *shopper* identity. The guest `/token` exchange **requires `channel_id`** (omitting it returns `400 "Guest token requires a channel_id parameter"`).
- **AM app token** – from `https://account.demandware.com/dwsso/oauth2/access_token` (`client_credentials`). An *app* token, no shopper identity. Host is `account.demandware.com` (the `.net` variant does not resolve).
- **OCAPI customer JWT** – from OCAPI `POST /customers/auth` on `ocapi-shop-customers` (`{"type":"guest"}`, or `{"type":"credentials"}` + a Basic shopper header). Returned in the **response `Authorization` header**, not the body. Carries a shopper identity. This is the OCAPI-native shopper flow the skill emits by default for OCAPI Shop.
- **TSOB shopper token** (trusted-system-on-behalf-of) – from SLAS `POST /organizations/{org}/oauth2/trusted-system/token`, Basic auth with a SLAS **private** client id:secret (public clients are rejected), form-encoded `grant_type=client_credentials` + `hint=ts_ext_on_behalf_of` + a real `login_id` + `idp_origin` + `channel_id`. Requires the private client to hold the `sfcc.ts_ext_on_behalf_of` scope. Mints a *shopper* JWT on behalf of a registered shopper without their credentials; the JWT's `isb` claim is the composite issuer-subject (`uido:...::upn:<login>::...::rcid:<26-char id>`) and must stay under 256 chars. A non-existent `login_id` returns `404 "External user not found"` (an existence check, not an auth failure), so it needs a real registered shopper.

AM and SLAS are **separate token stores.** SLAS lets you supply the client UUID rather than generate one, so a SLAS client can share its UUID with an AM client.

## OCAPI OAuth grant types

OCAPI documents four OAuth grant types (source: the DSC OCAPI OAuth reference). Two are runtime-relevant to the skill today:

| # | Grant | Endpoint | grant_type | Identity carried |
|---|---|---|---|---|
| 1 | Client Credentials | `POST account.demandware.com/dwsso/oauth2/access_token` | `client_credentials` | app (no user/shopper) |
| 2 | Business Manager User Grant | `POST /dw/oauth2/access_token?client_id=<id>` on the **instance** | `urn:demandware:params:oauth:grant-type:client-id:dwsid:dwsecuretoken` | a **BM user** (JWT `usr` claim) |
| 3 | Authorization Code | `GET /dwsso/oauth2/authorize` -> `POST .../access_token` | `authorization_code` | delegated user |
| 4 | JWT Bearer (client assertion) | `POST /dwsso/oauth2/access_token` | `client_credentials` + signed `client_assertion` | app (keypair, no password) |

Grant #1 is what the skill emits for OCAPI Data (and SCAPI Admin). The **Business Manager User Grant** (#2) is a genuinely distinct tier: the token is obtained from the *instance* (not Account Manager), uses a three-part Basic header (`BMuser:BMpassword:clientPassword`), and carries a BM-user identity (JWT `usr` claim) the client-credentials app token lacks. That user identity passes the OCAPI Shop "authenticated user" gate that a plain app token fails (an app token on OCAPI Shop returns `403 AccessWithoutUserForbiddenException`). It produces an *agent basket* (`agent_basket: true`) rather than an ordinary shopper basket – the OOBO / CSR-acting-on-behalf-of-a-customer context. The grant is verified to work and carry the user identity; the exact set of elevated operations its BM permissions unlock (beyond what a shopper token can do) is documented-but-not-independently-characterized. It is modeled as a *future* provider/tier, not the default for either plane.

## What the runtime testing established

- **OCAPI Shop gates on shopper-identity, full stop.** A SLAS shopper token (guest or registered) *and* an OCAPI-native customer JWT all work; app tokens fail `AccessWithoutUserForbiddenException`. Once you hold a valid shopper bearer, the ecom app server validates it and OCAPI Shop does not care which store minted it.
- **OCAPI Data gates on a valid AM app token.** Either AM client works; shopper tokens fail (401).
- **There is NO role-based exclusion on OCAPI.** Proven by revocation, not inferred: an AM SCAPI-client token (carrying `roles: ["SALESFORCE_COMMERCE_API"]`) returned 200 on OCAPI Data while its client was in the BM OCAPI allowlist, and `403 ClientAccessForbiddenException` for the same token on the same call after the client was removed from the allowlist. The role claim never changed; only allowlist membership did. **Do not model "SCAPI role blocks OCAPI" – it is not a thing; model the allowlist prerequisite instead.**
- **`client_id` must be PRESENT but its value is not the authz gate.** A call with no `client_id` at all returns `400 MissingClientIdException` (the floor, always required). But when a valid token is attached, the `client_id` *value* isn't authz-checked. So: always emit `client_id`; don't model its value as the gate (the token + BM allowlist is).
- **SLAS is NOT walled off from OCAPI.** A SLAS shopper token calls OCAPI Shop successfully when the client is allowlisted (it is still not the *emitted* OCAPI default – see routing rule 3, and the "Traps" section for why the xor intuition is false).
- **The only real exclusions are by token TYPE + identity:** app token -> SCAPI Shopper = 401; app token -> OCAPI Shop = 403 no-shopper; shopper token -> SCAPI Admin / OCAPI Data = 401; OCAPI customer JWT -> any SCAPI = 401. Route on these, never on role.
- **SLAS Admin (`auth-admin`) gates on the Sandbox API User role, instance-filtered** – NOT on the roles its spec declares. Runtime-verified; see the dedicated "SLAS Admin" section below for the full requirement and the spec-vs-runtime divergence.

## The OCAPI Shop three-tier ladder

OCAPI Shop is not one flow – it's a ladder, and the skill emits the **lightest sufficient** tier:

- **Tier 1 – `client_id` only, NO token:** read ops succeed. `GET /products/{id}`, `/categories/{id}`, `/site` all return 200 with only `?client_id=`, no `Authorization` header.
- **Tier 2 – shopper token + `client_id`:** shopper-state ops require it. `POST /baskets` with no token returns `401 AuthorizationHeaderMissingException`; with an OCAPI-native or SLAS shopper token it returns 200.
- **Floor:** `client_id` always required (a bare call returns 400).

**The Tier 1 / Tier 2 boundary is NOT derivable from the `security[]` array** – this is the load-bearing finding. The OCAPI security OR-list is aspirational, not enforced: `post-baskets` *lists* `client_id` as an accepted scheme, yet a client_id-only call 401s at runtime. And the array shape doesn't track read/write (some GETs carry `oauth2_application`, some don't; writes are irregular). So "does client_id-alone suffice?" cannot be answered from the JSON.

Consequence for the skill: the tier can't be inferred structurally, so the code takes the **conservative** stance – default every Shop op to the shopper tier (never under-auth), and drop to Tier 1 only for a **curated list of proven-public reads** (`ocapi-shop-products` / `ocapi-shop-categories` / `ocapi-shop-site` GETs, verified 200 with client_id only). That curated list is the per-op override the generic registry explicitly allows where a pattern would be wrong. See `OCAPI_SHOP_PUBLIC_READS` in `b2c-auth-providers.js`.

## SLAS Admin (`auth-admin`)

The SLAS **control-plane** API: manage SLAS clients, tenants, IDPs, and password-action templates, and delete shoppers (`basePath /shopper/auth-admin/v1`; a browser SLAS Admin UI also exists at `https://{short-code}.api.commercecloud.salesforce.com/shopper/auth-admin/v1/ui/`). It configures SLAS; it does not authenticate shoppers. It is a SCAPI Admin plane and authenticates like the others.

**The requirement (runtime-verified end to end):** an Account Manager `client_credentials` token, minted with `scope=SALESFORCE_COMMERCE_API:<tenant>`, whose API client holds the **Sandbox API User** role filtered to the target instance. With that, `retrieveTenant` and `retrieveClients` return `200` (the latter listed the sandbox's registered SLAS clients). In the token this presents as `roles` including `CCDX_SBX_USER`, with the role's tenant filter covering the instance being called. The grant is plain `client_credentials` – the [admin-auth guide](https://developer.salesforce.com/docs/commerce/commerce-api/guide/authorization-for-admin-apis.html) is explicit that it is the only grant supported for SCAPI Admin APIs, and the role rides in the token's claims. No user login / `authorization_code` flow is involved (`client_credentials` cannot carry a user identity).

**The one non-obvious part – the instance filter:** the `Sandbox API User` role is commonly left scoped to *all* sandboxes (that broad scope is what the unrelated **Sandbox API** wants, and it's the natural default). But SCAPI-family role authorization always requires a *specific* instance in the role's filter. If `Sandbox API User` isn't filtered to include the tenant you're calling, `auth-admin` returns `401 UnauthApiAccessException "no access"` even though the role is present. Add the instance to the role's filter on the client.

**Spec-vs-runtime divergence (the reason to read this rather than the spec):** The `auth-admin` reference has **no document-level `security`**; each operation declares its own, and they are not uniform. Most ops (all writes/deletes, `retrieveTenant`, `retrievePwdActionTemplate`, `retrieveIdentityProvider`) declare `BearerToken: [SLAS_SERVICE_ADMIN, SLAS_ORGANIZATION_ADMIN]`; three read ops (`retrieveClients`, `retrieveClient`, `retrieveIdentityProviders`) declare only `[SLAS_SERVICE_ADMIN]`. Neither form is what the endpoint enforces – both are declared-but-not-operative (the enforced gate is the Sandbox API User role, above). The point stands across the variance: a token carrying `Sandbox API User` and no SLAS-admin role returns 200. The authoritative source is the prose guide's line – "Calls to SLAS Admin APIs require the role Sandbox API User" – confirmed by runtime, not the machine-readable `security` block. This is the same lesson as the OCAPI Shop tier ladder above and the OCAPI `client_id` finding: **a spec `security[]` array describes intent, not enforced behavior; verify against a live call.** (Not tested: whether the spec-declared SLAS-admin roles would *also* grant access as an alternative path – only that they are not required.)

**Skill implication:** an `auth-admin` target routes to the AM `client_credentials` branch correctly, but the branch's generic prerequisite note (scope `SALESFORCE_COMMERCE_API:<tenant>`) is incomplete for it – the client also needs the `Sandbox API User` role filtered to the instance. See the iteration note's OPEN DECISION for the targeted-prerequisite fix.

## Critical runtime-vs-spec defects (encoded, not spec-derivable)

Two facts the emitted runnable *reads* right but fails on without – the same class as the AM `.net`->`.com` host defect (a runnable that looks correct but 403s/400s live):

- **AM scope needs the tenant suffix.** A SCAPI `AmOAuth2` target requires the AM token scope to be `SALESFORCE_COMMERCE_API:<tenantId>` (e.g. `:abcd_001`), space-separated from the API scopes – not the bare role string. Verified: bare role -> 403 at the resource; tenant-scoped -> 200. SCAPI clients are instance-scoped and the suffix is mandatory. The tenant is the instance, derivable from the org id `f_ecom_<instance>`. Encoded in `slas-flows.js` (`amRoleScope`, `tenantFromOrg`) and surfaced as the `am`-branch prerequisite note.
- **OCAPI success responses live under the `default` response code.** OCAPI's Swagger-2 specs put the success payload schema under the `default` response and reserve the numbered codes for faults (`400/404 -> fault`, `default -> the success type`). SCAPI/OAS uses an explicit `2xx`. The type-graph walk's producer detection must accept `default` alongside `2xx`, or every OCAPI producer is invisible and the cross-reference bridge (`post-baskets` -> `post-orders`) silently returns nothing. Encoded in `walk-types.js` (`isSuccessResponse`); it's a strict no-op on SCAPI (which never emits `default`).

## Routing rules (how the registry decides)

Pick the branch from the target's identity, **reference family first, then declared scheme:**

1. scheme `ShopperToken` -> `shopper-slas`.
2. scheme `AmOAuth2`, or `BearerToken` with `SLAS_*` scopes -> `am` (emit the `SALESFORCE_COMMERCE_API:<tenant>` scope, not the bare role).
3. reference family `ocapi-shop-*` -> `ocapi-shop`, lightest sufficient tier. The emitted shopper flow default is **OCAPI-native `customers/auth`**, NOT SLAS: the person asking about OCAPI already has an OCAPI client; defaulting to SLAS would force a second client (or UUID reuse) and violates the stay-in-family rule. SLAS is named as a one-line prose migration alternative, never the emitted runnable.
4. reference family `ocapi-data-*` -> `ocapi-data`, AM app token + Data request shape.
5. anything else -> `unknown` (no auth-step block; plan still composes).

The SCAPI scheme classifier (`pickAuthBranch` in `slas-flows.js`) deliberately returns `unknown` for the OCAPI multi-scheme set – OCAPI routing is the reference-family providers' job. Do NOT reintroduce a "collapse any OCAPI scheme to shopper-slas" clause; that was the over-auth bug (a read-only product lookup got a full SLAS PKCE flow, and OCAPI Data was mis-routed to a shopper token).

## Request-shape differences

| | SCAPI | OCAPI |
|---|---|---|
| Path | `/checkout/<ref>/v{n}/organizations/{org}/...` | Shop `/s/{siteId}/dw/shop/v{ver}/...`; Data `/s/-/dw/data/v{ver}/...` (literal `-`, no site) |
| Field casing | camelCase (`basketId`, `paymentMethodId`) | snake_case (`basket_id`, `payment_method_id`) |
| Payment card (create body) | requires `maskedNumber` | `payment_card` requires `masked_number` (rejects raw `number` -> 400 `UnknownPropertyException`) |
| Payment card (raw number) | n/a | only via the `payment_instruments` sub-resource (`POST /baskets/{id}/payment_instruments`) |
| Shopper-token capture | SLAS 303 `Location` header (auth code) | `customers/auth` response `Authorization` header (JWT) |
| `client_id` query param | never | on every call (the floor) |

The full basket->order submittable-minimum (>=1 line item, shipping method + address, billing address with both names, payment instrument) holds on both planes; only casing and the payment shape differ. The gate is at order submit, not basket creation, on both. This is why the curated-fact registry (`skills/_shared/b2c-curated-facts.js`) carries two `producer-body` entries: `Basket` (SCAPI, camelCase, `maskedNumber`) and `basket` (OCAPI, snake_case).

**Payment shape (runtime-verified, do not re-derive from the spec).** The raw-vs-masked card-number split is per-ENDPOINT, not per-product: in the single `POST /baskets` create body OCAPI's `payment_card` takes `masked_number` and rejects a raw `number` (`400 UnknownPropertyException "unknown property 'number'"`); a raw card number works only through the `payment_instruments` sub-resource. Both paths reach a placed order (masked-inline single-call; raw-via-sub-resource). This is only observable by executing the *verbatim emitted runnable* – inspecting its shape, or exercising the API via the incremental multi-call path, both miss it (the incremental path uses the sub-resource, which does take a raw number).

## Architecture: product-neutral, metadata-driven auth enrichment

The auth machinery must not bake in B2C assumptions – B2C is ONE product whose API family registers auth providers; another product would register its own without touching B2C code or the generic layer.

- **`skills/_shared/auth-providers.js`** – the product-neutral registry. `resolveAuthProvider({context, providers})` runs each provider's `match(context)` predicate (a pattern over area / reference-family / declared `security[]` / method / path) and returns the first match's resolved auth: `{branch, tier, requestAuth:{query,bearer}, token, prerequisites}`. Knows nothing about B2C.
- **`skills/_shared/b2c-auth-providers.js`** – B2C's four providers (`shopper-slas`, `am`, `ocapi-shop`, `ocapi-data`). SCAPI providers key off the scheme (via `pickAuthBranch`); OCAPI providers key off the reference-family regex. Ordered SCAPI-first so a (hypothetical) `ShopperToken` in the OCAPI area still routes `shopper-slas`.

Design principles: **combine code + convention** (a provider's `match` is a predicate, not a 1:1 op list), but **allow explicit per-op overrides** where a pattern would be wrong (the OCAPI Shop tier boundary is the example – a curated proven-public read list, since the tier isn't spec-derivable). **Determinism first:** branch, tier, token URL, request shape, and capture idiom are all metadata the renderer consumes verbatim; the model chooses nothing.

The **non-deterministic residual** – facts the skill can't verify for a given instance – is surfaced as structured, on-demand `prerequisites` notes, `{kind, text, cite}`, attached to the resolved branch and shown only when that branch fires (so a SCAPI Shopper plan never carries OCAPI prose). `kind:"instance-config"` = a fact the user must confirm; `cite` is a `developer.salesforce.com` URL where one exists, `null` where the fact is undocumented on DSC (AM, OCAPI settings) – there the note itself is the citation contract, the same rule the AM-URL framing follows.

## Coverage gaps and deliberately-untested edges

Flagged honestly so the matrix isn't read as 100% runtime-proven:

- **registered-federated** SLAS – needs an external IDP; not configurable on a bare sandbox. The non-federated registered (registered-b2c) flow is verified.
- **BM User Grant elevated-op set** – the grant itself is verified (carries the BM user, passes the needs-a-user gate, produces an agent basket); the exact set of permission-gated operations it unlocks beyond a shopper token is documented-but-not-characterized.
- **OCAPI grants #3 (authorization_code) and #4 (JWT bearer)** – DSC-documented only.

## Traps (plausible-but-wrong; do not re-derive)

Facts that look one way from the spec or from a partial test but are settled the other way. Each is a mistake worth not repeating.

- **AM token host is `account.demandware.com`, not `.net`.** The `.net` host does not resolve; only `.com` issues the token.
- **Session bridging is not an OCAPI↔SCAPI bridge.** `getSessionBridgeAccessToken` bridges a storefront session and a REST-API session (cookie ↔ bearer); it predates SCAPI and is irrelevant to family routing. Its description mentions "OCAPI" and the `dwsid` cookie, which reads like a cross-plane bridge – it is not. Don't wire it into OCAPI auth.
- **The `SALESFORCE_COMMERCE_API` role does not gate OCAPI.** It is orthogonal to OCAPI access (the BM allowlist is the gate) – a client-config property, not a resource rule. There is no AM role for OCAPI.
- **SLAS is not the OCAPI Shop default.** SLAS-default is correct for the SCAPI *shopper* branch only; OCAPI Shop's emitted default is OCAPI-native `customers/auth` (routing rule 3).
- **A SLAS token is not walled off from OCAPI.** A SLAS shopper token calls OCAPI Shop successfully when the client is allowlisted (the "a client is SCAPI xor OCAPI" intuition is a false generalization from a single pre-allowlist 403). It is still not the *emitted* OCAPI default – see rule 3.
- **OCAPI's create-body payment card is masked, not raw.** In the `POST /baskets` create body `payment_card` takes `masked_number`; a raw `number` is rejected there (`400 UnknownPropertyException`) and works only via the `payment_instruments` sub-resource. The raw/masked split is per-endpoint, not per-product (see the request-shape table).
- **A spec `security[]` array is intent, not enforcement – verify against a live call.** Three independent cases in this doc prove it: OCAPI Shop's tier boundary isn't in `security[]`; OCAPI's `client_id`-listed ops still 401 without a shopper token; and `auth-admin` declares `SLAS_SERVICE_ADMIN`/`SLAS_ORGANIZATION_ADMIN` but actually enforces the `Sandbox API User` role. When a prose guide and the machine-readable spec disagree, runtime has sided with the guide. This is *why* the auth registry is curated from runtime + prose, not derived from `security[]`.

## Spec corrections and their self-invalidation

Several facts in this matrix OVERRIDE what a machine-readable spec declares – the enforced auth-admin gate vs its `security[]`, the OCAPI create-body payment shape vs its schema, the AM host. Because an override is trusted *more* than the spec, a stale override fails confidently, which is worse than declining. So a correction carries the basis of its own expiry.

The mechanism (encoded in `skills/_shared/auth-providers.js` + `skills/_shared/b2c-curated-facts.js`): a correction may record a `specAnchor` – the exact spec field it overrides plus a predicate for what that field said when the correction was authored (`read` extracts the field, `holds` judges the premise, `saw` is the human-readable snapshot). Every run re-evaluates the anchor against the freshly-scraped spec. If the field still matches, the correction's premise holds and its claim renders. If not, the skill flags "this correction predates a spec change – re-verify" and stops applying the override. Whether the spec converged to the correction or moved to a third thing, the safe move is identical: surface, do not silently override.

Volatility is derived from a correction's shape, not declared:

- **spec-divergence** – has a `specAnchor`; the watched field is spec-visible and drift-prone (auth-admin's `security[]`; the OCAPI create-body card type's raw `number`). This is the dangerous, self-invalidating class.
- **platform-behavior** – a runtime fact with no spec field to anchor (a dated observation); re-verify on cadence via its `verifiedOn` record.
- **infra-invariant** – explicitly flagged; ~never stale and has no spec surface (the AM token host). Expiry is by dated assertion.

Not everything is anchorable, and the absence of an anchor is a modeled class, not a gap: a fact with no spec field to watch (a host) is classified infra-invariant or platform-behavior and leans on its dated evidence, rather than pretending to self-invalidate.

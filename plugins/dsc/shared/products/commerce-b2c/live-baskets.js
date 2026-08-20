'use strict';

// Bash-snippet builder: clear a shopper's existing baskets so a live run does not hit
// the per-customer basket quota (a registered test shopper accumulates baskets across
// runs; guest customers accumulate too, just not shared). Shopper Baskets has no
// list-my-baskets op, so this uses the create->quota-fault->delete loop: attempt a
// createBasket; on the "Customer Baskets Quota Exceeded" fault the detail names the
// blocking basket id in parens, so delete that and retry; once a create succeeds the
// quota has room, so delete that fresh basket too and stop. Expects $TOKEN + $BASE (the
// SCAPI edge base) + $ORG + $SITE already set in the surrounding script. Emits nothing
// secret (only truncated basket-id prefixes). `verBase` is the shopper-baskets version
// path segment (e.g. checkout/shopper-baskets/v2).
function clearBasketsSnippet({ verBase = 'checkout/shopper-baskets/v2' } = {}) {
  return [
    '# --- basket-quota cleanup (idempotent; no list op exists, so create/parse-fault/delete) ---',
    'for _i in $(seq 1 25); do',
    `  _R=$(curl -sS -X POST "$BASE/${verBase}/organizations/$ORG/baskets?siteId=$SITE" \\`,
    '    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")',
    "  _BID=$(printf '%s' \"$_R\" | jq -r '.basketId // empty')",
    '  if [ -n "$_BID" ]; then',
    `    curl -sS -o /dev/null -X DELETE "$BASE/${verBase}/organizations/$ORG/baskets/$_BID?siteId=$SITE" -H "Authorization: Bearer $TOKEN"`,
    '    echo "basket-cleanup: quota clear"; break',
    '  fi',
    "  _DEL=$(printf '%s' \"$_R\" | jq -r '.detail // empty' | grep -oE '\\(([0-9a-f]+)\\)' | tr -d '()' | head -1)",
    '  if [ -z "$_DEL" ]; then echo "basket-cleanup: nothing to clear"; break; fi',
    `  curl -sS -o /dev/null -X DELETE "$BASE/${verBase}/organizations/$ORG/baskets/$_DEL?siteId=$SITE" -H "Authorization: Bearer $TOKEN"`,
    '  echo "basket-cleanup: freed ${_DEL:0:8}"',
    'done',
  ].join('\n');
}

module.exports = { clearBasketsSnippet };

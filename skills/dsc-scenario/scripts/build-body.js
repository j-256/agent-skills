'use strict';

// Pure structure assembly for deterministic request bodies. Folds a flat list of
// nested leaf-path strings (from the submittability registry) into a nested JS
// object, taking each terminal value from an injected resolveLeafValue callback.
// No cache, no I/O -- the renderer stays a pure function of the plan. Path grammar:
//   foo            -> key at the current level
//   foo.bar        -> object nesting {foo:{bar:...}}
//   foo[].bar      -> single-element array {foo:[{bar:...}]}
// Single-element arrays are deliberate: every submittable-minimum gate is
// "at least one", so one representative element suffices and keeps the body
// compact + pasteable.

// Parse a path into ordered segments, each {key, isArray}.
// 'paymentInstruments[].paymentCard.cardType' ->
//   [{key:'paymentInstruments',isArray:true},{key:'paymentCard',isArray:false},{key:'cardType',isArray:false}]
function parseSegments(path) {
  return String(path).split('.').map((raw) => {
    const isArray = raw.endsWith('[]');
    return { key: isArray ? raw.slice(0, -2) : raw, isArray };
  });
}

function ownValue(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key) ? Reflect.get(record, key) : undefined;
}

function setOwn(record, key, value) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

// Fold each leaf path into `root`, walking segment by segment with a `cursor`.
// For a non-leaf array segment, ensure a single-element array and descend into
// its [0]; for a non-leaf object segment, ensure an object and descend into it;
// the leaf segment places the resolved value instead of descending.
function buildSkeleton(leafPaths, resolveLeafValue) {
  const root = {};
  for (const path of leafPaths) {
    const segs = parseSegments(path);
    let cursor = root;
    for (let i = 0; i < segs.length; i++) {
      const { key, isArray } = segs[i];
      const isLeaf = i === segs.length - 1;
      if (isLeaf) {
        // Terminal: place the value (into the array element if this segment is [],
        // though in practice the leaf segment is a scalar field, not an array).
        if (isArray) {
          if (!Array.isArray(ownValue(cursor, key))) setOwn(cursor, key, [resolveLeafValue(path)]);
        } else {
          setOwn(cursor, key, resolveLeafValue(path));
        }
      } else if (isArray) {
        if (!Array.isArray(ownValue(cursor, key))) setOwn(cursor, key, [{}]);
        cursor = ownValue(cursor, key)[0];
      } else {
        const next = ownValue(cursor, key);
        if (typeof next !== 'object' || next === null || Array.isArray(next)) {
          setOwn(cursor, key, {});
        }
        cursor = ownValue(cursor, key);
      }
    }
  }
  return root;
}

// Merge `source` onto `target` in place; source wins per-key. Plain objects merge
// recursively; arrays and scalars from source REPLACE target's value (so a nested
// skeleton array replaces a flat `<field>` placeholder). Keys only in target
// survive -- this is what preserves a spec-required body field the skeleton does
// not name.
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sourceValue = ownValue(source, key);
    const targetValue = ownValue(target, key);
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      setOwn(target, key, sourceValue);
    }
  }
  return target;
}

module.exports = { buildSkeleton, deepMerge };

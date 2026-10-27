import type { JsonObject } from './types.js';

const anchorCache = new WeakMap<JsonObject, Map<string, unknown>>();

/** Map each `$anchor` / `$dynamicAnchor` name in the document to its node. */
function anchorTargets({ document }: { document: JsonObject }): Map<string, unknown> {
  const cached = anchorCache.get(document);
  if (cached) return cached;
  const targets = new Map<string, unknown>();
  anchorCache.set(document, targets);
  const visited = new Set<object>();
  const stack: unknown[] = [document];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if (!Array.isArray(value)) {
      for (const key of ['$anchor', '$dynamicAnchor'] as const) {
        const name = (value as JsonObject)[key];
        if (typeof name === 'string' && !targets.has(name)) targets.set(name, value);
      }
    }
    const children = Object.values(value as JsonObject);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return targets;
}

/**
 * Resolve a local JSON Pointer (`#/a/b`) or plain-name anchor (`#Name`)
 * against the document. Prototype-safe: inherited members (`toString`,
 * `__proto__`, ...) never count as present, and URI-fragment
 * percent-encoding is decoded.
 */
export function resolveJsonPointer({
  document,
  ref,
}: {
  document: JsonObject;
  ref: string;
}): unknown {
  if (ref === '#') return document;
  if (ref.startsWith('#') && !ref.startsWith('#/')) {
    // A plain-name fragment (`#PetAnchor`) names a schema that declares
    // `$anchor` in the same document (JSON Schema 2020-12, OpenAPI 3.1).
    // It is a local reference, not an external one.
    let name: string;
    try {
      name = decodeURIComponent(ref.slice(1));
    } catch {
      name = ref.slice(1);
    }
    if (!/^[A-Za-z_][-A-Za-z0-9._]*$/.test(name)) return undefined;
    return anchorTargets({ document }).get(name);
  }
  if (!ref.startsWith('#/')) return undefined;
  let value: unknown = document;
  for (const part of ref.slice(2).split('/')) {
    // RFC 6901 order: decode the URI-fragment percent-encoding first,
    // then undo the pointer escapes. `%7E1` must become `~1` and only
    // then `/`; the reverse order leaves a literal `~1` in the key.
    let key: string;
    try {
      key = decodeURIComponent(part);
    } catch {
      // Keep the raw segment when it is not valid percent-encoding.
      key = part;
    }
    key = key.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof value !== 'object' || value === null) return undefined;
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as JsonObject)[key];
  }
  return value;
}

export type RefResolution =
  | { object: JsonObject; ref?: undefined; reason?: undefined }
  | { object: null; ref: string; reason: 'external' | 'dangling' | 'cycle' };

/**
 * Resolved chains, memoised per document. A chain S0 -> S1 -> ... -> SN
 * otherwise costs O(N) pointer walks for every link, so auditing a spec
 * with N chained schemas costs O(N^2). Callers treat the document as
 * immutable for the duration of an audit, so a cached resolution stays
 * valid; the WeakMap lets the cache die with the document.
 */
const chainCache = new WeakMap<JsonObject, Map<string, RefResolution>>();

/** Follow a (possibly chained) local `$ref` to its target object. */
export function resolveRefChain({
  document,
  value,
}: {
  document: JsonObject;
  value: unknown;
}): RefResolution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { object: null, ref: '', reason: 'dangling' };
  }
  let cache = chainCache.get(document);
  if (!cache) {
    cache = new Map();
    chainCache.set(document, cache);
  }
  let current = value as JsonObject;
  const seen = new Set<string>();
  // Every ref visited on this walk resolves to the same final result, so
  // the whole path can be cached once the walk ends (path compression).
  const path: string[] = [];
  const finish = (resolution: RefResolution): RefResolution => {
    for (const entry of path) cache.set(entry, resolution);
    return resolution;
  };
  for (;;) {
    const ref = current['$ref'];
    if (typeof ref !== 'string') return finish({ object: current });
    const hit = cache.get(ref);
    if (hit) return finish(hit);
    if (seen.has(ref)) {
      // Only the repeated ref itself has this exact resolution; refs that
      // merely lead into the cycle resolve to a cycle at a different ref.
      const resolution: RefResolution = { object: null, ref, reason: 'cycle' };
      cache.set(ref, resolution);
      return resolution;
    }
    seen.add(ref);
    path.push(ref);
    if (!ref.startsWith('#')) return finish({ object: null, ref, reason: 'external' });
    const target = resolveJsonPointer({ document, ref });
    if (
      target === undefined ||
      typeof target !== 'object' ||
      target === null ||
      Array.isArray(target)
    ) {
      return finish({ object: null, ref, reason: 'dangling' });
    }
    current = target as JsonObject;
  }
}

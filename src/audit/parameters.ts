import { resolveRefChain } from './refs.js';
import type { JsonObject } from './types.js';

export type CollectedParameter = {
  param: JsonObject;
  source: 'pathItem' | 'operation';
  /** Position in the source `parameters` array. Builds the JSON Pointer. */
  index: number;
  /** Present when the parameter `$ref` could not be resolved. */
  resolution?: { ref: string; reason: 'external' | 'dangling' | 'cycle' };
};

function parameterKey({ param }: { param: JsonObject }): string | null {
  const name = typeof param['name'] === 'string' ? param['name'] : '';
  const location = typeof param['in'] === 'string' ? param['in'] : '';
  // Only a name plus a location can override another parameter. A
  // parameter with either field missing or empty is malformed, and a
  // shared empty key would let it silently replace (or be replaced by)
  // the next malformed parameter in the merge below.
  if (name.length === 0 || location.length === 0) return null;
  return `${location}:${name}`;
}

// Collected results, memoised per document by the identity of the two
// source lists. One shared path item (a $ref or a YAML alias) serves many
// operations, so re-walking its parameter list for every operation makes
// the audit cost grow with paths × parameters while the merged result
// stays small. Callers treat the document as immutable for the duration
// of an audit, as the $ref chain cache in refs.ts already does, and no
// caller mutates the returned array or its entries.
const noList: object = {};
const collectedByDocument = new WeakMap<
  JsonObject,
  WeakMap<object, WeakMap<object, CollectedParameter[]>>
>();

/**
 * The single parameter collector for the whole audit.
 * Merges PathItem + operation parameters (the operation wins on the same
 * `name` + `in`, per the OpenAPI spec) and resolves `$ref` parameters.
 * Every consumer — inventory, operation checks, schema checks — uses this,
 * so the three can never disagree about which parameters an operation has.
 */
export function collectParameters({
  document,
  pathItem,
  operation,
}: {
  document: JsonObject;
  pathItem: JsonObject;
  operation: JsonObject;
}): CollectedParameter[] {
  const pathList = pathItem['parameters'];
  const operationList = operation['parameters'];
  let byPathList = collectedByDocument.get(document);
  if (!byPathList) {
    byPathList = new WeakMap();
    collectedByDocument.set(document, byPathList);
  }
  const pathKey: object = Array.isArray(pathList) ? pathList : noList;
  let byOperationList = byPathList.get(pathKey);
  if (!byOperationList) {
    byOperationList = new WeakMap();
    byPathList.set(pathKey, byOperationList);
  }
  const operationKey: object = Array.isArray(operationList) ? operationList : noList;
  const cached = byOperationList.get(operationKey);
  if (cached) return cached;

  const merged = new Map<string, CollectedParameter>();
  const addFrom = (list: unknown, source: 'pathItem' | 'operation') => {
    if (!Array.isArray(list)) return;
    list.forEach((raw, index) => {
      const resolved = resolveRefChain({ document, value: raw });
      if (!resolved.object) {
        const ref = resolved.ref ?? '';
        merged.set(`$ref:${ref}`, {
          param: typeof raw === 'object' && raw !== null ? (raw as JsonObject) : {},
          source,
          index,
          resolution: { ref, reason: resolved.reason ?? 'dangling' },
        });
        return;
      }
      merged.set(parameterKey({ param: resolved.object }) ?? `$malformed:${source}:${index}`, {
        param: resolved.object,
        source,
        index,
      });
    });
  };
  addFrom(pathList, 'pathItem');
  addFrom(operationList, 'operation');
  const collected = [...merged.values()];
  byOperationList.set(operationKey, collected);
  return collected;
}

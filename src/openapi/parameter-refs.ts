import { METHODS, type JsonObject } from './metadata.js';

const PARAMETERS_PREFIX = '#/components/parameters/';

// Returns the same object; zod's record parser returns a copy, which would lose in-place edits.
function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function inlineParameters({
  owner,
  location,
  defined,
}: {
  owner: JsonObject;
  location: string;
  defined: JsonObject;
}): void {
  const list = owner['parameters'];
  if (!Array.isArray(list)) return;
  owner['parameters'] = list.map((entry: unknown) => {
    const reference = asRecord(entry)?.['$ref'];
    if (reference === undefined) return entry;
    if (typeof reference !== 'string' || !reference.startsWith(PARAMETERS_PREFIX))
      throw new Error(`${location}: unsupported parameter reference ${String(reference)}`);
    const name = reference.slice(PARAMETERS_PREFIX.length).replace(/~1/g, '/').replace(/~0/g, '~');
    const target = Object.hasOwn(defined, name) ? asRecord(defined[name]) : undefined;
    if (!target) throw new Error(`${location}: parameter reference not found: ${reference}`);
    if (target['$ref'] !== undefined)
      throw new Error(`${location}: parameter reference points at another reference: ${reference}`);
    return structuredClone(target);
  });
}

/**
 * Replaces local `#/components/parameters/*` references on path items and
 * operations with copies of the parameter they name, so the request compiler
 * only ever sees plain parameters.
 */
export function resolveParameterRefs(document: JsonObject): void {
  const defined = asRecord(asRecord(document['components'])?.['parameters']) ?? {};
  for (const [path, value] of Object.entries(asRecord(document['paths']) ?? {})) {
    const item = asRecord(value);
    if (!item) continue;
    inlineParameters({ owner: item, location: path, defined });
    for (const method of METHODS) {
      const operation = asRecord(item[method]);
      if (operation)
        inlineParameters({
          owner: operation,
          location: `${method.toUpperCase()} ${path}`,
          defined,
        });
    }
  }
}

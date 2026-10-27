import { resolveJsonPointer, resolveRefChain } from './refs.js';
import type { Finding, JsonObject } from './types.js';

export type Push = (finding: Finding) => void;

/** Schema keywords the baseline (OpenComp-derived) generator handles faithfully. */
export const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'allOf',
  'oneOf',
  'anyOf',
  'nullable',
  'default',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'description',
  'title',
  'example',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/** Keywords that only exist in JSON Schema 2020-12 / OpenAPI 3.1. */
export const KEYWORDS_31 = new Set([
  'const',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'if',
  'then',
  'else',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  '$schema',
  '$id',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$vocabulary',
  '$comment',
  '$defs',
]);

export const STRING_FORMATS = new Set(['date-time', 'date', 'email', 'uuid', 'uri', 'password']);
export const NUMERIC_FORMATS = new Set(['int32', 'int64', 'float', 'double']);
export const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

export function checkRef({
  ref,
  location,
  document,
  is31,
  push,
}: {
  ref: string;
  location: string;
  document: JsonObject;
  is31: boolean;
  push: Push;
}): void {
  const resolution = resolveRefChain({ document, value: { $ref: ref } });
  if (resolution.object) return;
  const failingRef = resolution.ref ?? ref;
  // A boolean is a valid schema in 3.1, so a ref to one is not dangling.
  if (is31 && typeof resolveJsonPointer({ document, ref: failingRef }) === 'boolean') return;
  if (resolution.reason === 'external') {
    push({
      code: 'SCHEMA_REF_EXTERNAL',
      severity: 'blocker',
      category: 'schema',
      message: `External reference is not followed: ${failingRef}`,
      location,
    });
  } else if (resolution.reason === 'cycle') {
    push({
      code: 'SCHEMA_REF_CYCLE',
      severity: 'blocker',
      category: 'schema',
      message: `Unproductive reference-only cycle at ${failingRef}`,
      location,
    });
  } else {
    push({
      code: 'SCHEMA_REF_DANGLING',
      severity: 'blocker',
      category: 'schema',
      message: `Dangling local reference: ${failingRef}`,
      location,
    });
  }
}

/** Boolean schemas are JSON Schema 2020-12; a 3.0 schema must be an object. */
export function pushBooleanSchema({
  location,
  push,
  is31,
}: {
  location: string;
  push: Push;
  is31: boolean;
}): void {
  push({
    code: 'SPEC31_BOOLEAN_SCHEMA',
    severity: is31 ? 'compat31' : 'blocker',
    category: 'openapi-3.1',
    message: is31
      ? 'Boolean schema is a JSON Schema 2020-12 construct; it needs 3.1-native handling'
      : 'Boolean schema requires JSON Schema 2020-12 (OpenAPI 3.1); use an object schema',
    location,
  });
}

import { escapePointer } from './inventory.js';
import {
  KEYWORDS_31,
  NUMERIC_FORMATS,
  STRING_FORMATS,
  SUPPORTED_KEYWORDS,
  TYPES,
  checkRef,
  pushBooleanSchema,
  type Push,
} from './schema-keywords.js';
import type { JsonObject } from './types.js';

const MAX_SCHEMA_DEPTH = 100;

type WalkState = {
  visited: Set<object>;
  active: Set<object>;
  incomplete: Set<object>;
  depthLimited: boolean;
};

function schemaKind({ value }: { value: unknown }): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function pushInvalidSchema({
  location,
  push,
  message,
}: {
  location: string;
  push: Push;
  message: string;
}): void {
  push({ code: 'SCHEMA_INVALID', severity: 'blocker', category: 'schema', message, location });
}

// Schemas whose own node was checked but whose subtree hit the depth
// limit, keyed by the shared visited set that outlives one walk. A
// later, shallower walk of the same object resumes at its children
// instead of skipping the schema as fully checked.
const incompleteByVisited = new WeakMap<Set<object>, Set<object>>();

function checkSchema({
  schema,
  location,
  document,
  is31,
  push,
  state,
  depth,
}: {
  schema: JsonObject;
  location: string;
  document: JsonObject;
  is31: boolean;
  push: Push;
  state: WalkState;
  depth: number;
}): boolean {
  // YAML anchors/aliases can make the parsed graph cyclic, and deeply
  // nested schemas can overflow the stack. Guard both before recursing.
  // The depth check runs before the visited mark: an aliased schema first
  // reached past the limit must still be checked when a later, shallower
  // path reaches the same object.
  if (state.active.has(schema)) return false;
  const alreadyChecked = state.visited.has(schema);
  if (alreadyChecked && !state.incomplete.has(schema)) return false;
  if (depth > MAX_SCHEMA_DEPTH) {
    if (!state.depthLimited) {
      state.depthLimited = true;
      push({
        code: 'SCHEMA_DEPTH_EXCEEDED',
        severity: 'blocker',
        category: 'schema',
        message: `Schema nesting exceeds ${MAX_SCHEMA_DEPTH} levels; the audit stops descending here`,
        location,
      });
    }
    return true;
  }
  state.active.add(schema);
  let truncated = false;
  try {
    if (!alreadyChecked) {
      state.visited.add(schema);
      for (const key of Object.keys(schema)) {
        if (key.startsWith('x-') || SUPPORTED_KEYWORDS.has(key)) continue;
        if (KEYWORDS_31.has(key)) {
          push({
            code: 'SPEC31_KEYWORD',
            severity: is31 ? 'compat31' : 'blocker',
            category: 'openapi-3.1',
            message: `JSON Schema 2020-12 keyword requires 3.1-native handling: ${key}`,
            location,
          });
          continue;
        }
        push({
          code: 'SCHEMA_KEYWORD_UNSUPPORTED',
          severity: 'blocker',
          category: 'schema',
          message: `Unsupported schema keyword: ${key}`,
          location,
        });
      }
      const ref = schema['$ref'];
      if (typeof ref === 'string') checkRef({ ref, location, document, is31, push });
      else if (ref !== undefined) {
        pushInvalidSchema({
          location,
          push,
          message: `$ref is not a string (got ${schemaKind({ value: ref })}); its target cannot be resolved`,
        });
      }
      const type = schema['type'];
      if (Array.isArray(type)) {
        push({
          code: 'SPEC31_TYPE_ARRAY',
          severity: is31 ? 'compat31' : 'blocker',
          category: 'openapi-3.1',
          message: `Type array (3.1 nullable form): ${type.map(String).join(', ')}`,
          location,
        });
        for (const member of type) {
          if (typeof member !== 'string' || !TYPES.has(member)) {
            push({
              code: 'SCHEMA_TYPE_UNSUPPORTED',
              severity: 'blocker',
              category: 'schema',
              message: `Unsupported schema type: ${String(member)}`,
              location,
            });
          }
        }
      } else if (type !== undefined && typeof type !== 'string') {
        push({
          code: 'SCHEMA_TYPE_UNSUPPORTED',
          severity: 'blocker',
          category: 'schema',
          message: `Unsupported schema type: ${String(type)}`,
          location,
        });
      } else if (typeof type === 'string' && !TYPES.has(type)) {
        push({
          code: 'SCHEMA_TYPE_UNSUPPORTED',
          severity: 'blocker',
          category: 'schema',
          message: `Unsupported schema type: ${type}`,
          location,
        });
      } else if (typeof type === 'string' && type === 'null') {
        // 'null' as a type belongs to JSON Schema 2020-12; 3.0 expresses the
        // same thing with nullable, and the baseline compiler rejects the type.
        push(
          is31
            ? {
                code: 'SPEC31_TYPE_NULL',
                severity: 'compat31',
                category: 'openapi-3.1',
                message:
                  'Solo null type is a JSON Schema 2020-12 construct; it needs 3.1-native handling',
                location,
              }
            : {
                code: 'SCHEMA_TYPE_UNSUPPORTED',
                severity: 'blocker',
                category: 'schema',
                message: 'Unsupported schema type in an OpenAPI 3.0 document: null (use nullable)',
                location,
              },
        );
      }
      for (const key of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
        const bound = schema[key];
        if (typeof bound === 'number') {
          push({
            code: 'SPEC31_EXCLUSIVE_BOUND',
            severity: is31 ? 'compat31' : 'blocker',
            category: 'openapi-3.1',
            message: `${key} is numeric (3.1 form), not boolean`,
            location,
          });
        } else if (is31 && typeof bound === 'boolean') {
          push({
            code: 'SPEC31_EXCLUSIVE_BOOLEAN',
            severity: 'warning',
            category: 'openapi-3.1',
            message: `${key} uses the removed 3.0 boolean form in a 3.1 document`,
            location,
          });
        } else if (bound !== undefined && typeof bound !== 'boolean') {
          // A bound that is neither the 3.1 numeric form nor the 3.0 boolean
          // form (text, null, an object) has no meaning in either dialect.
          push({
            code: 'SCHEMA_EXCLUSIVE_BOUND_UNSUPPORTED',
            severity: 'blocker',
            category: 'schema',
            message: `Invalid ${key}: expected a number in 3.1 or a boolean in 3.0, got ${typeof bound}`,
            location,
          });
        }
      }
      const format = schema['format'];
      if (typeof format === 'string') {
        const typeNames = Array.isArray(type)
          ? type.map(String)
          : typeof type === 'string'
            ? [type]
            : [];
        // Judge the format against the set for the declared type only. With no
        // declared type there is nothing to mismatch, so accept either set.
        const allowed = new Set<string>();
        if (typeNames.length === 0) {
          for (const value of [...STRING_FORMATS, ...NUMERIC_FORMATS]) allowed.add(value);
        }
        for (const name of typeNames) {
          const set = name === 'number' || name === 'integer' ? NUMERIC_FORMATS : STRING_FORMATS;
          for (const value of set) allowed.add(value);
        }
        if (!allowed.has(format)) {
          push({
            code: 'SCHEMA_FORMAT_UNSUPPORTED',
            severity: 'blocker',
            category: 'schema',
            message: `Unsupported format for the baseline generator: ${format}`,
            location,
          });
        }
      }
    }
    const recurse = (value: unknown, childLocation: string): boolean => {
      // An absent value is no schema at all (a parameter without a
      // schema, an operation without items); a present value that is
      // neither an object nor a boolean schema is a broken schema node.
      if (value === undefined) return false;
      if (typeof value === 'boolean') {
        pushBooleanSchema({ location: childLocation, push, is31 });
        return false;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return checkSchema({
          schema: value as JsonObject,
          location: childLocation,
          document,
          is31,
          push,
          state,
          depth: depth + 1,
        });
      }
      pushInvalidSchema({
        location: childLocation,
        push,
        message: `Schema is not an object (got ${schemaKind({ value })}); it cannot be mapped to a tool argument type`,
      });
      return false;
    };
    const properties = schema['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [name, value] of Object.entries(properties as JsonObject)) {
        truncated = recurse(value, `${location}/properties/${escapePointer(name)}`) || truncated;
      }
    }
    truncated = recurse(schema['items'], `${location}/items`) || truncated;
    if (Array.isArray(schema['prefixItems'])) {
      schema['prefixItems'].forEach((value, index) => {
        truncated = recurse(value, `${location}/prefixItems/${index}`) || truncated;
      });
    }
    // A boolean additionalProperties is a plain allow/deny flag in both
    // dialects, not a boolean schema, so it keeps its existing pass. Any
    // other non-object value in that position is a broken schema node.
    if (typeof schema['additionalProperties'] !== 'boolean') {
      truncated =
        recurse(schema['additionalProperties'], `${location}/additionalProperties`) || truncated;
    }
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      if (Array.isArray(schema[key])) {
        (schema[key] as unknown[]).forEach((value, index) => {
          truncated = recurse(value, `${location}/${key}/${index}`) || truncated;
        });
      } else if (schema[key] !== undefined) {
        // A combinator that holds one schema object instead of a list
        // still holds a schema; walk it (or flag its shape) here.
        truncated = recurse(schema[key], `${location}/${key}`) || truncated;
      }
    }
    for (const key of ['not', 'if', 'then', 'else', 'contains', 'propertyNames'] as const) {
      truncated = recurse(schema[key], `${location}/${key}`) || truncated;
    }
    const dependent = schema['dependentSchemas'];
    if (typeof dependent === 'object' && dependent !== null) {
      for (const [name, value] of Object.entries(dependent as JsonObject)) {
        truncated =
          recurse(value, `${location}/dependentSchemas/${escapePointer(name)}`) || truncated;
      }
    }
    for (const key of ['$defs', 'patternProperties'] as const) {
      const defs = schema[key];
      if (typeof defs === 'object' && defs !== null) {
        for (const [name, value] of Object.entries(defs as JsonObject)) {
          truncated = recurse(value, `${location}/${key}/${escapePointer(name)}`) || truncated;
        }
      }
    }
    for (const key of ['unevaluatedProperties', 'unevaluatedItems', 'contentSchema'] as const) {
      truncated = recurse(schema[key], `${location}/${key}`) || truncated;
    }
  } finally {
    state.active.delete(schema);
  }
  // A schema stays incomplete until a walk reaches every descendant.
  // The next shallower walk then resumes at the children above without
  // reporting this node's own findings a second time.
  if (truncated) state.incomplete.add(schema);
  else state.incomplete.delete(schema);
  return truncated;
}

/**
 * Entry point for one schema tree; each tree gets a fresh cycle guard.
 * Callers that walk many trees over one document pass a shared `visited`
 * set so a schema object reused in a nested position (a YAML anchor, say)
 * is checked once, not once per tree that reaches it.
 */
export function walkSchema({
  schema,
  location,
  document,
  is31,
  push,
  visited,
}: {
  schema: unknown;
  location: string;
  document: JsonObject;
  is31: boolean;
  push: Push;
  visited?: Set<object>;
}): void {
  if (typeof schema === 'boolean') {
    pushBooleanSchema({ location, push, is31 });
    return;
  }
  // Callers pass undefined for an absent schema (a parameter or media
  // type without one); that is not a finding. Any other non-object value
  // in a schema position is a broken schema node.
  if (schema === undefined) return;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    pushInvalidSchema({
      location,
      push,
      message: `Schema is not an object (got ${schemaKind({ value: schema })}); it cannot be mapped to a tool argument type`,
    });
    return;
  }
  const visitedSet = visited ?? new Set<object>();
  let incomplete = incompleteByVisited.get(visitedSet);
  if (!incomplete) {
    incomplete = new Set<object>();
    incompleteByVisited.set(visitedSet, incomplete);
  }
  checkSchema({
    schema: schema as JsonObject,
    location,
    document,
    is31,
    push,
    state: { visited: visitedSet, active: new Set(), incomplete, depthLimited: false },
    depth: 0,
  });
}

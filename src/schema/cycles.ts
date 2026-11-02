import { JsonObject, objectSchema } from '../openapi/metadata.js';
import { readDiscriminator } from './discriminator.js';

type Resolve = (input: { ref: string; location: string }) => JsonObject;

const sameValueKeys = ['allOf', 'oneOf', 'anyOf'] as const;
const conditionalKeys = ['if', 'then', 'else'] as const;

/**
 * Returns a `$ref` that reaches itself through `$ref`, `allOf`/`oneOf`/`anyOf` or
 * `if`/`then`/`else` alone. Those branches all parse the same value, so such a cycle
 * recurses forever; a cycle through `properties` or `items` consumes structure and is fine.
 */
export function createCompositionCycleFinder(resolve: Resolve) {
  const acyclic = new Set<string>();

  function walk({
    schema,
    location,
    stack,
  }: {
    schema: JsonObject;
    location: string;
    stack: string[];
  }): string | undefined {
    const ref = schema['$ref'];
    if (typeof ref === 'string') {
      if (stack.includes(ref)) return ref;
      if (acyclic.has(ref)) return undefined;
      stack.push(ref);
      const hit = walk({ schema: resolve({ ref, location }), location, stack });
      stack.pop();
      if (hit === undefined) acyclic.add(ref);
      return hit;
    }
    const members: unknown[] = [];
    for (const key of sameValueKeys) {
      const value = schema[key];
      if (Array.isArray(value)) members.push(...value);
    }
    for (const key of conditionalKeys) members.push(schema[key]);
    // The compiler routes to mapping targets only when a oneOf/anyOf is present.
    if (schema['oneOf'] !== undefined || schema['anyOf'] !== undefined) {
      for (const target of readDiscriminator({ schema, location })?.refs.values() ?? []) {
        members.push({ $ref: target });
      }
    }
    for (const member of members) {
      const parsed = objectSchema.safeParse(member);
      if (!parsed.success) continue;
      const hit = walk({ schema: parsed.data, location, stack });
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  return ({ schema, location }: { schema: JsonObject; location: string }) =>
    walk({ schema, location, stack: [] });
}

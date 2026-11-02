import { discriminatorMappingRefs } from './discriminator.js';
import { resolveRefChain } from './refs.js';
import type { JsonObject } from './types.js';

const MAX_DEPTH = 1000;

type State = { done: WeakSet<object>; reported: WeakSet<object> };
const states = new WeakMap<JsonObject, State>();

function sameValueMembers({ schema }: { schema: JsonObject }): JsonObject[] {
  const members: unknown[] = [];
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const value = schema[key];
    if (Array.isArray(value)) members.push(...value);
  }
  // The compiler routes to mapping targets only when a oneOf/anyOf is present.
  if (Array.isArray(schema['oneOf']) || Array.isArray(schema['anyOf'])) {
    for (const { ref } of discriminatorMappingRefs({ schema })) members.push({ $ref: ref });
  }
  for (const key of ['if', 'then', 'else'] as const) members.push(schema[key]);
  return members.filter(
    (member): member is JsonObject =>
      typeof member === 'object' && member !== null && !Array.isArray(member),
  );
}

/**
 * Finds a schema that reaches itself through `$ref`, `allOf`/`oneOf`/`anyOf` or
 * `if`/`then`/`else` alone; those branches all see the same value, so the cycle never
 * consumes structure. Each cycle is returned once per document. Reference-only cycles
 * are left to `checkRef`.
 */
export function findCompositionCycle({
  schema,
  document,
}: {
  schema: JsonObject;
  document: JsonObject;
}): string | undefined {
  let state = states.get(document);
  if (!state) {
    state = { done: new WeakSet(), reported: new WeakSet() };
    states.set(document, state);
  }
  const { done, reported } = state;
  const path: object[] = [];
  const onPath = new Set<object>();

  const visit = ({ node, depth }: { node: JsonObject; depth: number }): string | undefined => {
    if (depth > MAX_DEPTH) return undefined;
    const ref = node['$ref'];
    let target = node;
    if (typeof ref === 'string') {
      const resolution = resolveRefChain({ document, value: node });
      if (!resolution.object) return undefined;
      target = resolution.object;
    }
    if (done.has(target)) return undefined;
    if (onPath.has(target)) {
      const cycle = path.slice(path.indexOf(target));
      if (cycle.some((member) => reported.has(member))) return undefined;
      for (const member of cycle) reported.add(member);
      return typeof ref === 'string' ? ref : 'an aliased schema';
    }
    path.push(target);
    onPath.add(target);
    for (const member of sameValueMembers({ schema: target })) {
      const hit = visit({ node: member, depth: depth + 1 });
      if (hit !== undefined) return hit;
    }
    path.pop();
    onPath.delete(target);
    done.add(target);
    return undefined;
  };

  return visit({ node: schema, depth: 0 });
}

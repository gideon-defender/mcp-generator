import type { JsonObject } from './types.js';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why the compiler would reject this schema's `discriminator`, or undefined when it is fine. */
export function discriminatorProblem({ schema }: { schema: JsonObject }): string | undefined {
  const discriminator = schema['discriminator'];
  if (discriminator === undefined) return undefined;
  if (!isObject(discriminator)) return 'discriminator must be an object';
  const name = discriminator['propertyName'];
  if (typeof name !== 'string' || name === '') {
    return 'discriminator.propertyName must be a non-empty string';
  }
  const mapping = discriminator['mapping'];
  if (mapping === undefined) return undefined;
  if (!isObject(mapping) || Object.values(mapping).some((target) => typeof target !== 'string')) {
    return 'discriminator.mapping must map strings to strings';
  }
  return undefined;
}

/** `$ref` for each mapping target; a bare name is a component schema, as in the compiler. */
export function discriminatorMappingRefs({
  schema,
}: {
  schema: JsonObject;
}): { tag: string; ref: string }[] {
  const discriminator = schema['discriminator'];
  const mapping = isObject(discriminator) ? discriminator['mapping'] : undefined;
  if (!isObject(mapping)) return [];
  const refs: { tag: string; ref: string }[] = [];
  for (const [tag, target] of Object.entries(mapping)) {
    if (typeof target !== 'string') continue;
    const ref = target.startsWith('#/')
      ? target
      : /^[\w.-]+$/.test(target)
        ? `#/components/schemas/${target}`
        : target;
    refs.push({ tag, ref });
  }
  return refs;
}

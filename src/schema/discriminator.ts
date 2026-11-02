import { z } from 'zod';
import { JsonObject, objectSchema } from '../openapi/metadata.js';

const discriminatorSchema = z.object({
  propertyName: z.string().min(1),
  mapping: z.record(z.string(), z.string()).optional(),
});

export type DiscriminatorTargets = { propertyName: string; refs: Map<string, string> };

function toRef(value: string): string {
  if (value.startsWith('#/')) return value;
  // Component names allow only [A-Za-z0-9._-]; anything else is a URI and stays external.
  return /^[\w.-]+$/.test(value) ? `#/components/schemas/${value}` : value;
}

function implicitName(ref: string): string {
  const last = ref.split('/').pop() ?? ref;
  return decodeURIComponent(last).replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Maps discriminator values to local schema refs; explicit mapping wins over implicit `$ref` names. */
export function readDiscriminator({
  schema,
  location,
}: {
  schema: JsonObject;
  location: string;
}): DiscriminatorTargets | undefined {
  if (schema['discriminator'] === undefined) return undefined;
  const parsed = discriminatorSchema.safeParse(schema['discriminator']);
  if (!parsed.success) throw new Error(`${location}: invalid discriminator`);
  const refs = new Map<string, string>();
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (schema[key] === undefined) continue;
    for (const member of z.array(objectSchema).parse(schema[key])) {
      if (typeof member['$ref'] === 'string')
        refs.set(implicitName(member['$ref']), member['$ref']);
    }
  }
  for (const [value, target] of Object.entries(parsed.data.mapping ?? {})) {
    refs.set(value, toRef(target));
  }
  return { propertyName: parsed.data.propertyName, refs };
}

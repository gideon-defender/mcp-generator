import { z } from 'zod';
import { JsonObject, objectSchema } from '../openapi/metadata.js';
import { compileValue, canonicalJson } from './value.js';
import { readDiscriminator } from './discriminator.js';
import { createCompositionCycleFinder } from './cycles.js';

const keywords = new Set([
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
  // Phase 3: OpenAPI 3.1 / JSON Schema 2020-12 support
  'const',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'discriminator',
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
]);

export type CompileSchema = (input: { source: unknown; location: string }) => z.ZodType;

/** Local references stay lazy; validate the graph first so lazy schemas cannot hide failures. */
export function createSchemaCompiler(document: JsonObject): CompileSchema {
  const cache = new Map<string, z.ZodType>();
  const checked = new Set<string>();
  // Routing in progress, so a subtype that extends its parent does not route back into itself.
  const routing = new Set<string>();

  function resolve({ ref, location }: { ref: string; location: string }): JsonObject {
    if (!ref.startsWith('#/')) throw new Error(`${location}: external reference ${ref}`);
    let value: unknown = document;
    for (const part of ref.slice(2).split('/')) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
      value = objectSchema.parse(value)[key];
    }
    const parsed = objectSchema.safeParse(value);
    if (!parsed.success) throw new Error(`${location}: dangling reference ${ref}`);
    return parsed.data;
  }

  const findCompositionCycle = createCompositionCycleFinder(resolve);

  function validate({ source, location }: { source: unknown; location: string }): void {
    const schema = objectSchema.parse(source);
    for (const key of ['nullable', 'readOnly', 'writeOnly', 'deprecated']) {
      if (schema[key] !== undefined) z.boolean().parse(schema[key]);
    }
    // Phase 3: exclusiveMinimum/exclusiveMaximum can be boolean (3.0) or number (3.1)
    // so we don't validate their type here; the value compiler handles both forms

    // Phase 4 advanced keywords are validated and compiled below where they have semantics.

    for (const key of Object.keys(schema)) {
      if (!keywords.has(key) && !key.startsWith('x-')) {
        throw new Error(`${location}: unsupported schema keyword ${key}`);
      }
    }
    const unsupportedPhase4Keywords = [
      'prefixItems',
      'contains',
      'minContains',
      'maxContains',
      'propertyNames',
      'dependentRequired',
      'dependentSchemas',
      'unevaluatedProperties',
      'unevaluatedItems',
      'contentEncoding',
      'contentMediaType',
      'contentSchema',
    ];
    for (const key of unsupportedPhase4Keywords) {
      if (schema[key] !== undefined) throw new Error(`${location}: ${key} is not yet supported`);
    }
    if (schema['$ref'] !== undefined) {
      const ref = z.string().parse(schema['$ref']);
      const target = resolve({ ref, location });
      const aliases = new Set([ref]);
      let alias = target;
      while (typeof alias['$ref'] === 'string') {
        const next = alias['$ref'];
        if (aliases.has(next)) throw new Error(`${location}: unproductive reference cycle ${next}`);
        aliases.add(next);
        alias = resolve({ ref: next, location });
      }
      if (
        Object.keys(schema).some(
          (key) =>
            ![
              '$ref',
              'description',
              'nullable',
              'default',
              'title',
              'example',
              'examples',
              'readOnly',
              'writeOnly',
              'deprecated',
            ].includes(key) && !key.startsWith('x-'),
        )
      ) {
        throw new Error(`${location}: unsupported constraint beside $ref`);
      }
      if (!checked.has(ref)) {
        checked.add(ref);
        validate({ source: target, location: `${location} -> ${ref}` });
      }
    }
    const cycle = findCompositionCycle({ schema, location });
    if (cycle !== undefined) {
      throw new Error(`${location}: unproductive composition cycle through ${cycle}`);
    }
    for (const ref of readDiscriminator({ schema, location })?.refs.values() ?? []) {
      validate({ source: { $ref: ref }, location: `${location}/discriminator` });
    }
    for (const key of ['properties'] as const) {
      if (schema[key] === undefined) continue;
      for (const [name, value] of Object.entries(objectSchema.parse(schema[key]))) {
        validate({ source: value, location: `${location}/${key}/${name}` });
      }
    }
    for (const key of ['items', 'additionalProperties'] as const) {
      if (schema[key] === undefined || typeof schema[key] === 'boolean') continue;
      validate({ source: schema[key], location: `${location}/${key}` });
    }
    for (const key of ['if', 'then', 'else'] as const) {
      if (schema[key] === undefined) continue;
      const member = z.union([z.boolean(), objectSchema]).parse(schema[key]);
      if (typeof member === 'boolean') continue;
      validate({ source: member, location: `${location}/${key}` });
    }
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      if (schema[key] === undefined) continue;
      const members = z.array(objectSchema).min(1).parse(schema[key]);
      members.forEach((value, index) =>
        validate({ source: value, location: `${location}/${key}/${index}` }),
      );
    }
    // Eagerly compile non-reference constraints, even inside an optional or recursive field.
    compileValue({
      schema,
      location,
      compile: ({ source: child, location: childLocation }) => {
        validate({ source: child, location: childLocation });
        return z.unknown();
      },
    });
  }

  function compile({ source, location }: { source: unknown; location: string }): z.ZodType {
    const schema = objectSchema.parse(source);
    let result: z.ZodType;
    if (schema['$ref'] !== undefined) {
      const ref = z.string().parse(schema['$ref']);
      let target = cache.get(ref);
      if (!target) {
        target = z.lazy(() => compile({ source: resolve({ ref, location }), location: ref }));
        cache.set(ref, target);
      }
      result = target;
    } else {
      result = compileValue({ schema, location, compile });
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (schema[key] === undefined) continue;
      const members = z
        .array(objectSchema)
        .parse(schema[key])
        .map((child, index) => compile({ source: child, location: `${location}/${key}/${index}` }));
      const first = members[0];
      if (!first) throw new Error(`${location}/${key}: empty composition`);
      const composed =
        key === 'allOf'
          ? members.slice(1).reduce((left, right) => z.intersection(left, right), first)
          : key === 'oneOf'
            ? z.xor(members)
            : z.union(members);
      result = z.intersection(result, composed);
    }
    const discriminator = readDiscriminator({ schema, location });
    if (discriminator && discriminator.refs.size > 0) {
      const targets = new Map(
        [...discriminator.refs].map(([name, ref]) => [
          name,
          compile({ source: { $ref: ref }, location: `${location}/discriminator/${name}` }),
        ]),
      );
      // Route on the tag so a mapped value is checked only against its own schema.
      result = result.refine(
        (value) => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
          const tag: unknown = (value as Record<string, unknown>)[discriminator.propertyName];
          const target = typeof tag === 'string' ? targets.get(tag) : undefined;
          if (target === undefined) return true;
          const key = `${location}\0${canonicalJson(value)}`;
          if (routing.has(key)) return true;
          routing.add(key);
          try {
            return target.safeParse(value).success;
          } finally {
            routing.delete(key);
          }
        },
        { message: `Value does not match its ${discriminator.propertyName} discriminator schema` },
      );
    }
    if (schema['nullable'] === true) result = result.nullable();
    if (schema['if'] !== undefined) {
      const conditional = (key: 'if' | 'then' | 'else'): z.ZodType | undefined => {
        if (schema[key] === undefined) return undefined;
        const member = z.union([z.boolean(), objectSchema]).parse(schema[key]);
        if (typeof member === 'boolean') return member ? z.unknown() : z.never();
        return compile({ source: member, location: `${location}/${key}` });
      };
      const ifSchema = conditional('if')!;
      const thenSchema = conditional('then');
      const elseSchema = conditional('else');
      // refine, not z.custom: custom types cannot be converted by z.toJSONSchema.
      result = result.refine(
        (value) => {
          const branch = ifSchema.safeParse(value).success ? thenSchema : elseSchema;
          return branch === undefined || branch.safeParse(value).success;
        },
        { message: 'Value does not satisfy the conditional schema' },
      );
    }
    if (schema['default'] !== undefined) {
      if (!result.safeParse(schema['default']).success)
        throw new Error(`${location}: invalid schema default`);
      result = result.default(schema['default']);
    }
    if (typeof schema['description'] === 'string') result = result.describe(schema['description']);
    return result;
  }

  return ({ source, location }) => {
    try {
      validate({ source, location });
      return compile({ source, location });
    } catch (error) {
      throw new Error(`${location}: ${error instanceof Error ? error.message : 'invalid schema'}`);
    }
  };
}

import { z } from 'zod';
import { JsonObject, objectSchema } from '../openapi/metadata.js';
import type { CompileSchema } from './compiler.js';

// Key-order-independent serialization so structurally equal JSON values compare equal.
// Recursion depth limit to prevent stack overflow on deeply nested structures.
const MAX_CANONICAL_DEPTH = 100;

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error(`canonicalJson: recursion depth exceeded (max ${MAX_CANONICAL_DEPTH})`);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function compileValue({
  schema,
  location,
  compile,
}: {
  schema: JsonObject;
  location: string;
  compile: CompileSchema;
}): z.ZodType {
  // Phase 3: Handle type arrays (3.1 nullable form)
  // type: ["string", "null"] is equivalent to type: "string" + nullable: true
  let type: string | undefined;
  let isNullable = false;
  const rawType = schema['type'];
  if (Array.isArray(rawType)) {
    // Type array: extract the non-null types and set nullable flag if "null" is present
    const types = rawType.filter((t): t is string => typeof t === 'string' && t !== 'null');
    const hasNull = rawType.some((t) => t === 'null');
    isNullable = hasNull;
    if (types.length === 0) {
      type = hasNull ? 'null' : undefined;
    } else if (types.length === 1) {
      type = types[0];
    } else {
      throw new Error(
        `${location}: type array with multiple non-null types [${types.join(', ')}] is not yet supported; ` +
          `use oneOf composition instead to express union types`,
      );
    }
  } else {
    type = typeof rawType === 'string' ? rawType : undefined;
    if (
      type === undefined &&
      (schema['properties'] || schema['required'] || schema['additionalProperties'] !== undefined)
    ) {
      type = 'object';
    }
  }

  for (const [expected, keys] of [
    ['string', ['minLength', 'maxLength', 'pattern']],
    ['array', ['items', 'minItems', 'maxItems', 'uniqueItems']],
    [
      'object',
      ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
    ],
    ['number', ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']],
  ] as const) {
    if (keys.some((key) => schema[key] !== undefined) && type === undefined) {
      throw new Error(`${location}: ${expected} constraints require a compatible explicit type`);
    }
  }
  if (schema['format'] !== undefined && !['string', 'number', 'integer'].includes(String(type))) {
    throw new Error(`${location}: format requires a supported explicit type`);
  }
  let value: z.ZodType = z.unknown();
  if (type === 'object') {
    const properties =
      schema['properties'] === undefined ? {} : objectSchema.parse(schema['properties']);
    const required = new Set(z.array(z.string()).parse(schema['required'] ?? []));
    const shape: Record<string, z.ZodType> = Object.create(null);
    for (const name of new Set([...Object.keys(properties), ...required])) {
      const definition = objectSchema.parse(properties[name] ?? {});
      const field = compile({ source: definition, location: `${location}/properties/${name}` });
      // A default accepts omission without making its JSON-schema field required.
      // Unknown-valued required-only branches must still reject a missing key.
      shape[name] = required.has(name)
        ? definition['default'] === undefined
          ? field.nonoptional()
          : field
        : field.optional();
    }
    const additional = schema['additionalProperties'];
    // OpenAPI's absent policy is open, including required-only union alternatives.
    let object: z.ZodType =
      additional === false
        ? z.strictObject(shape)
        : z
            .object(shape)
            .catchall(
              additional === undefined || additional === true
                ? z.unknown()
                : compile({ source: additional, location: `${location}/additionalProperties` }),
            );
    if (schema['minProperties'] !== undefined) {
      const min = z.number().int().nonnegative().parse(schema['minProperties']);
      object = object.refine((v) => Object.keys(v as object).length >= min, {
        message: `Expected at least ${min} properties`,
      });
    }
    if (schema['maxProperties'] !== undefined) {
      const max = z.number().int().nonnegative().parse(schema['maxProperties']);
      object = object.refine((v) => Object.keys(v as object).length <= max, {
        message: `Expected at most ${max} properties`,
      });
    }
    value = object;
  } else if (type === 'array') {
    let array = z.array(compile({ source: schema['items'] ?? {}, location: `${location}/items` }));
    if (schema['minItems'] !== undefined)
      array = array.min(z.number().int().nonnegative().parse(schema['minItems']));
    if (schema['maxItems'] !== undefined)
      array = array.max(z.number().int().nonnegative().parse(schema['maxItems']));
    if (schema['uniqueItems'] === true)
      array = array.refine((items) => new Set(items.map(canonicalJson)).size === items.length, {
        message: 'Expected array items to be unique',
      });
    value = array;
  } else if (type === 'string') {
    let string = z.string();
    if (schema['minLength'] !== undefined)
      string = string.min(z.number().int().nonnegative().parse(schema['minLength']));
    if (schema['maxLength'] !== undefined)
      string = string.max(z.number().int().nonnegative().parse(schema['maxLength']));
    if (schema['pattern'] !== undefined)
      string = string.regex(new RegExp(z.string().parse(schema['pattern'])));
    const format = schema['format'];
    if (format === 'date-time') string = string.check(z.iso.datetime({ offset: true }));
    else if (format === 'date') string = string.check(z.iso.date());
    else if (format === 'email') string = string.check(z.email());
    else if (format === 'uuid') string = string.check(z.uuid());
    else if (format === 'uri') string = string.check(z.url());
    else if (format !== undefined && format !== 'password')
      throw new Error(`${location}: unsupported format ${String(format)}`);
    value = string;
  } else if (type === 'number' || type === 'integer') {
    let number = type === 'integer' ? z.number().int() : z.number();
    const minimum = schema['minimum'];
    const maximum = schema['maximum'];

    // Phase 3: Handle numeric exclusive bounds (3.1: exclusiveMinimum/exclusiveMaximum as numbers)
    // vs 3.0 boolean form paired with minimum/maximum
    const exclusiveMinimum = schema['exclusiveMinimum'];
    const exclusiveMaximum = schema['exclusiveMaximum'];

    // 3.0 form: exclusiveMinimum/Maximum is boolean paired with minimum/maximum
    if (minimum !== undefined) {
      number =
        schema['exclusiveMinimum'] === true
          ? number.gt(z.number().parse(minimum))
          : number.min(z.number().parse(minimum));
    }
    if (maximum !== undefined) {
      number =
        schema['exclusiveMaximum'] === true
          ? number.lt(z.number().parse(maximum))
          : number.max(z.number().parse(maximum));
    }

    // 3.1 form: exclusiveMinimum/Maximum is a number value itself
    if (typeof exclusiveMinimum === 'number') {
      number = number.gt(exclusiveMinimum);
    }
    if (typeof exclusiveMaximum === 'number') {
      number = number.lt(exclusiveMaximum);
    }

    if (schema['multipleOf'] !== undefined)
      number = number.multipleOf(z.number().positive().parse(schema['multipleOf']));

    // Constraints for a different explicit type are inert under JSON Schema semantics.
    // The emitted UpdateFindingDto.revisionNote, for example, is object + maxLength.
    if (
      schema['format'] !== undefined &&
      !['int32', 'int64', 'float', 'double', 'byte', 'binary'].includes(
        z.string().parse(schema['format']),
      )
    ) {
      throw new Error(`${location}: unsupported numeric format`);
    }
    value = number;
  } else if (type === 'boolean') value = z.boolean();
  else if (type === 'null') value = z.null();
  else if (type !== undefined) throw new Error(`${location}: unsupported type ${String(type)}`);

  // Null must join the base type before const/enum intersect, so a null const or enum
  // member stays valid and a non-null const or enum still rejects null.
  if (isNullable) value = value.nullable();

  if (schema['const'] !== undefined) {
    const constValue = schema['const'] as unknown;
    if (
      typeof constValue === 'string' ||
      typeof constValue === 'number' ||
      typeof constValue === 'boolean' ||
      constValue === null
    ) {
      // Validate type compatibility: const must match the schema's type
      if (type !== undefined) {
        const valueType = typeof constValue;
        const typeMatch =
          (constValue === null && (type === 'null' || isNullable)) ||
          (type === 'string' && valueType === 'string') ||
          (type === 'number' && valueType === 'number') ||
          (type === 'integer' && valueType === 'number' && Number.isInteger(constValue)) ||
          (type === 'boolean' && valueType === 'boolean');
        if (!typeMatch) {
          throw new Error(
            `${location}: const value type (${valueType}) does not match schema type (${type})`,
          );
        }
      }
      value = z.intersection(value, z.literal(constValue));
    } else if (typeof constValue === 'object') {
      throw new Error(`${location}: const with complex values (objects/arrays) not yet supported`);
    }
  }

  if (schema['enum'] !== undefined) {
    const options = z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .min(1)
      .parse(schema['enum']);
    value = z.intersection(value, z.union(options.map((option) => z.literal(option))));
  }

  return value;
}

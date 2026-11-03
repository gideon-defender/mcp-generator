import { z } from 'zod';
import { JsonObject, objectSchema } from '../openapi/metadata.js';
import type { CompileSchema } from './compiler.js';

// Key-order-independent serialization so structurally equal JSON values compare equal.
// Recursion depth limit to prevent stack overflow on deeply nested structures.
const MAX_CANONICAL_DEPTH = 100;

export function canonicalJson(value: unknown, depth = 0): string {
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

// A subschema applied to a value of known type (an object key is always a string, a dependent
// schema always sees an object) may omit `type`, so the type is implied through its composition.
export function withImpliedType(schema: JsonObject, type: string): JsonObject {
  if (schema['$ref'] !== undefined) return schema;
  const typed: JsonObject = { type, ...schema };
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const members = schema[key];
    if (!Array.isArray(members)) continue;
    typed[key] = members.map((member) => {
      const parsed = objectSchema.safeParse(member);
      return parsed.success ? withImpliedType(parsed.data, type) : member;
    });
  }
  return typed;
}

const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;

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
      const constValue = schema['const'];
      const compatibleTypes = (() => {
        if (constValue === undefined) return types;
        if (constValue === null) return hasNull ? ['null'] : [];
        if (typeof constValue === 'string') return types.filter((member) => member === 'string');
        if (typeof constValue === 'number')
          return types.filter((member) => member === 'number' || member === 'integer');
        if (typeof constValue === 'boolean') return types.filter((member) => member === 'boolean');
        if (Array.isArray(constValue)) return types.filter((member) => member === 'array');
        return types.filter((member) => member === 'object');
      })();
      if (compatibleTypes.length === 0)
        throw new Error(`${location}: const value does not match any type in the type array`);
      const branchSchemas = compatibleTypes.map((member) => ({ ...schema, type: member }));
      let union = compile({ source: branchSchemas[0]!, location: `${location}/type/0` });
      for (let index = 1; index < branchSchemas.length; index += 1)
        union = z.union([
          union,
          compile({ source: branchSchemas[index]!, location: `${location}/type/${index}` }),
        ]);
      return constValue === undefined && hasNull ? union.nullable() : union;
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
    ['string', ['minLength', 'maxLength', 'pattern', 'contentEncoding', 'contentMediaType']],
    ['array', ['items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains']],
    [
      'object',
      [
        'properties',
        'required',
        'additionalProperties',
        'minProperties',
        'maxProperties',
        'propertyNames',
        'dependentRequired',
        'dependentSchemas',
      ],
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
  const compileSubschema = (source: unknown, at: string): z.ZodType => {
    if (source === true) return z.unknown();
    if (source === false) return z.never();
    return compile({ source, location: at });
  };
  const subschemaSource = z.union([z.boolean(), objectSchema]);
  let value: z.ZodType = z.unknown();
  if (type === 'object') {
    const properties =
      schema['properties'] === undefined ? {} : objectSchema.parse(schema['properties']);
    const required = new Set(z.array(z.string()).parse(schema['required'] ?? []));
    const shape: Record<string, z.ZodType> = Object.create(null);
    const defaults = new Map<string, string>();
    for (const name of new Set([...Object.keys(properties), ...required])) {
      const definition = objectSchema.parse(properties[name] ?? {});
      if (definition['default'] !== undefined)
        defaults.set(name, canonicalJson(definition['default']));
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
    // A property default is added to the parsed output, so a key holding exactly its default is not caller input.
    const sentKeys = (v: unknown) =>
      Object.entries(v as Record<string, unknown>)
        .filter(([key, item]) => !defaults.has(key) || defaults.get(key) !== canonicalJson(item))
        .map(([key]) => key);
    const propertyNames = schema['propertyNames'];
    if (propertyNames === false) {
      object = object.refine((v) => sentKeys(v).length === 0, {
        message: 'Expected no properties',
      });
    } else if (propertyNames !== undefined && propertyNames !== true) {
      const parsedNames = objectSchema.safeParse(propertyNames);
      if (!parsedNames.success)
        throw new Error(`${location}: propertyNames must be a schema object or boolean`);
      const names = compile({
        source: withImpliedType(parsedNames.data, 'string'),
        location: `${location}/propertyNames`,
      });
      object = object.refine((v) => sentKeys(v).every((key) => names.safeParse(key).success), {
        message: 'Property names do not satisfy the propertyNames schema',
      });
    }
    if (schema['dependentRequired'] !== undefined) {
      const parsed = z
        .record(z.string(), z.array(z.string()))
        .safeParse(schema['dependentRequired']);
      if (!parsed.success)
        throw new Error(`${location}: dependentRequired must map property names to string arrays`);
      const dependencies = Object.entries(parsed.data);
      object = object.refine(
        (v) => {
          const sent = new Set(sentKeys(v));
          return dependencies.every(
            ([key, needed]) => !sent.has(key) || needed.every((name) => sent.has(name)),
          );
        },
        { message: 'Object is missing properties required by dependentRequired' },
      );
    }
    if (schema['dependentSchemas'] !== undefined) {
      const parsed = z.record(z.string(), subschemaSource).safeParse(schema['dependentSchemas']);
      if (!parsed.success)
        throw new Error(`${location}: dependentSchemas must map property names to schemas`);
      const dependencies = Object.entries(parsed.data).map(
        ([key, source]) =>
          [
            key,
            compileSubschema(
              typeof source === 'boolean' ? source : withImpliedType(source, 'object'),
              `${location}/dependentSchemas/${key}`,
            ),
          ] as const,
      );
      object = object.refine(
        (v) => {
          const sent = new Set(sentKeys(v));
          return dependencies.every(
            ([key, member]) => !sent.has(key) || member.safeParse(v).success,
          );
        },
        { message: 'Object does not satisfy a dependentSchemas schema' },
      );
    }
    value = object;
  } else if (type === 'array') {
    const minItems =
      schema['minItems'] === undefined
        ? undefined
        : z.number().int().nonnegative().parse(schema['minItems']);
    const maxItems =
      schema['maxItems'] === undefined
        ? undefined
        : z.number().int().nonnegative().parse(schema['maxItems']);
    const rest = compileSubschema(schema['items'] ?? {}, `${location}/items`);
    let array: z.ZodType;
    if (schema['prefixItems'] === undefined) {
      let plain = z.array(rest);
      if (minItems !== undefined) plain = plain.min(minItems);
      if (maxItems !== undefined) plain = plain.max(maxItems);
      array = plain;
    } else {
      const parsed = z.array(subschemaSource).min(1).safeParse(schema['prefixItems']);
      if (!parsed.success)
        throw new Error(`${location}: prefixItems must be a non-empty array of schemas`);
      // Trailing positions may be omitted; `items` constrains everything after the prefix.
      const prefix = parsed.data.map((member, index) =>
        compileSubschema(member, `${location}/prefixItems/${index}`).optional(),
      );
      array = z.tuple(prefix as unknown as [z.ZodType, ...z.ZodType[]], rest);
      if (minItems !== undefined)
        array = array.refine((items) => (items as unknown[]).length >= minItems, {
          message: `Expected at least ${minItems} items`,
        });
      if (maxItems !== undefined)
        array = array.refine((items) => (items as unknown[]).length <= maxItems, {
          message: `Expected at most ${maxItems} items`,
        });
    }
    if (schema['uniqueItems'] === true)
      array = array.refine(
        (items) =>
          new Set((items as unknown[]).map((item) => canonicalJson(item))).size ===
          (items as unknown[]).length,
        { message: 'Expected array items to be unique' },
      );
    if (schema['contains'] !== undefined) {
      const contains = compileSubschema(schema['contains'], `${location}/contains`);
      const minContains =
        schema['minContains'] === undefined
          ? 1
          : z.number().int().nonnegative().parse(schema['minContains']);
      const maxContains =
        schema['maxContains'] === undefined
          ? undefined
          : z.number().int().nonnegative().parse(schema['maxContains']);
      array = array.refine(
        (items) => {
          const matches = (items as unknown[]).filter(
            (item) => contains.safeParse(item).success,
          ).length;
          return matches >= minContains && (maxContains === undefined || matches <= maxContains);
        },
        { message: 'Array items do not satisfy contains, minContains or maxContains' },
      );
    }
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
    else if (format === 'byte') string = string.check(z.base64());
    else if (format !== undefined && format !== 'password')
      throw new Error(`${location}: unsupported format ${String(format)}`);
    let encoding: string | undefined;
    if (schema['contentEncoding'] !== undefined) {
      encoding = z.string().parse(schema['contentEncoding']).toLowerCase();
      if (encoding === 'base64') string = string.check(z.base64());
      else if (encoding === 'base64url') string = string.check(z.base64url());
      else if (!['7bit', '8bit', 'binary'].includes(encoding))
        throw new Error(`${location}: unsupported contentEncoding ${encoding}`);
    }
    value = string;
    // Only JSON content is decoded and checked; other media types are annotations.
    if (schema['contentMediaType'] !== undefined) {
      const mediaType = z.string().parse(schema['contentMediaType']).split(';')[0]!.trim();
      if (JSON_MEDIA_TYPE.test(mediaType.toLowerCase())) {
        const contentSchema =
          schema['contentSchema'] === undefined
            ? undefined
            : compileSubschema(schema['contentSchema'], `${location}/contentSchema`);
        const decoding = encoding === 'base64' || encoding === 'base64url' ? encoding : undefined;
        value = string.refine(
          (text) => {
            let content: unknown;
            try {
              content = JSON.parse(
                decoding === undefined ? text : Buffer.from(text, decoding).toString('utf8'),
              );
            } catch {
              return false;
            }
            return contentSchema === undefined || contentSchema.safeParse(content).success;
          },
          { message: 'Content is not JSON that satisfies contentSchema' },
        );
      }
    }
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
      !['int32', 'int64', 'float', 'double'].includes(z.string().parse(schema['format']))
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
      if (type !== undefined) {
        const valueType = typeof constValue;
        const typeMatch =
          (constValue === null && (type === 'null' || isNullable)) ||
          (type === 'string' && valueType === 'string') ||
          (type === 'number' && valueType === 'number') ||
          (type === 'integer' && valueType === 'number' && Number.isInteger(constValue)) ||
          (type === 'boolean' && valueType === 'boolean');
        if (!typeMatch)
          throw new Error(
            `${location}: const value type (${valueType}) does not match schema type (${type})`,
          );
      }
      value = z.intersection(value, z.literal(constValue));
    } else {
      if (
        type !== undefined &&
        !(
          (Array.isArray(constValue) && type === 'array') ||
          (!Array.isArray(constValue) && type === 'object')
        )
      )
        throw new Error(`${location}: const complex value does not match schema type ${type}`);
      // refine, not z.custom: custom types cannot be converted by z.toJSONSchema.
      value = value.refine((input) => canonicalJson(input) === canonicalJson(constValue), {
        message: 'Value must equal the schema const',
      });
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

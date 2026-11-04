import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSchemaCompiler } from '../src/schema/compiler.js';
import { compileTools } from '../src/tools.js';
import type { JsonObject } from '../src/openapi/metadata.js';

describe('OpenAPI 3.1 Schema Support', () => {
  describe('type arrays (nullable form)', () => {
    it('compiles type array with string and null', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: ['string', 'null'] },
        location: '/components/schemas/TestSchema',
      });
      // Should accept string or null
      assert(schema.safeParse('hello').success);
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse(123).success);
    });

    it('compiles type array with number and null', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: ['number', 'null'] },
        location: '/components/schemas/TestSchema',
      });
      // Should accept number or null
      assert(schema.safeParse(42).success);
      assert(schema.safeParse(3.14).success);
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse('hello').success);
    });

    it('compiles type array with integer and null', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: ['integer', 'null'] },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(42).success);
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse(3.14).success);
      assert(!schema.safeParse('hello').success);
    });

    it('compiles type array with object and null', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: ['object', 'null'], properties: {} },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse({}).success);
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse('hello').success);
    });

    it('compiles type array with array and null', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: ['array', 'null'], items: { type: 'string' } },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse([]).success);
      assert(schema.safeParse(['a', 'b']).success);
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse('hello').success);
    });
  });

  describe('const keyword (JSON Schema 2020-12)', () => {
    it('compiles const value for string', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { const: 'fixed-value', type: 'string' },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse('fixed-value').success);
      assert(!schema.safeParse('other-value').success);
    });

    it('compiles const value for number', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { const: 42, type: 'number' },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(42).success);
      assert(!schema.safeParse(43).success);
    });

    it('compiles const without explicit type', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { const: true },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(true).success);
      assert(!schema.safeParse(false).success);
    });
  });

  describe('numeric exclusive bounds (3.1 number form)', () => {
    it('compiles exclusiveMinimum as number', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: 'number', exclusiveMinimum: 0 },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(0.001).success);
      assert(schema.safeParse(0).success === false);
      assert(schema.safeParse(-1).success === false);
    });

    it('compiles exclusiveMaximum as number', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: 'number', exclusiveMaximum: 100 },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(99.999).success);
      assert(schema.safeParse(100).success === false);
      assert(schema.safeParse(101).success === false);
    });

    it('compiles both numeric exclusive bounds together', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(5).success);
      assert(schema.safeParse(0).success === false);
      assert(schema.safeParse(10).success === false);
    });

    it('preserves 3.0 boolean form for backward compatibility', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: 'number', minimum: 0, exclusiveMinimum: true },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(0.001).success);
      assert(schema.safeParse(0).success === false);
    });
  });

  describe('supported keywords in keywords set', () => {
    it('accepts const in schema', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      // Should not throw "unsupported schema keyword const"
      assert.doesNotThrow(() => {
        compile({
          source: { type: 'string', const: 'value' },
          location: '/components/schemas/Test',
        });
      });
    });

    it('accepts uniqueItems in schema', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      assert.doesNotThrow(() => {
        compile({
          source: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          location: '/components/schemas/Test',
        });
      });
    });

    it('accepts minProperties in schema', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      assert.doesNotThrow(() => {
        compile({
          source: { type: 'object', properties: {}, minProperties: 1 },
          location: '/components/schemas/Test',
        });
      });
    });

    it('accepts maxProperties in schema', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      assert.doesNotThrow(() => {
        compile({
          source: { type: 'object', properties: {}, maxProperties: 10 },
          location: '/components/schemas/Test',
        });
      });
    });
  });

  describe('combined 3.1 features', () => {
    it('combines type array with const', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: { type: ['string', 'null'], const: 'only-this-value' },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse('only-this-value').success);
      assert(schema.safeParse(null).success === false);
      assert(schema.safeParse('other').success === false);
    });

    it('combines type array with numeric exclusive bounds', () => {
      const doc: JsonObject = { components: { schemas: {} } };
      const compile = createSchemaCompiler(doc);
      const schema = compile({
        source: {
          type: ['number', 'null'],
          exclusiveMinimum: 0,
          exclusiveMaximum: 100,
        },
        location: '/components/schemas/TestSchema',
      });
      assert(schema.safeParse(50).success);
      assert(schema.safeParse(null).success);
      assert(schema.safeParse(0).success === false);
      assert(schema.safeParse(100).success === false);
    });
  });

  describe('null handling with const and enum', () => {
    const compileSource = (source: JsonObject) =>
      createSchemaCompiler({ components: { schemas: {} } })({
        source,
        location: '/components/schemas/TestSchema',
      });

    it('compiles type array with only null', () => {
      const schema = compileSource({ type: ['null'] });
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse('any').success);
      assert(!schema.safeParse(0).success);
    });

    it('accepts null for a null const on a nullable type', () => {
      const schema = compileSource({ type: ['string', 'null'], const: null });
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse('any').success);
    });

    it('accepts null for an enum with null on a nullable string', () => {
      const schema = compileSource({ type: ['string', 'null'], enum: ['a', null, 'b'] });
      assert(schema.safeParse('a').success);
      assert(schema.safeParse(null).success);
      assert(schema.safeParse('b').success);
      assert(!schema.safeParse('c').success);
    });

    it('accepts null for an enum with null on a nullable number', () => {
      const schema = compileSource({ type: ['number', 'null'], enum: [1, null, 3] });
      assert(schema.safeParse(1).success);
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse(2).success);
    });

    it('rejects null when the enum has no null member', () => {
      const schema = compileSource({ type: ['string', 'null'], enum: ['a', 'b'] });
      assert(schema.safeParse('a').success);
      assert(!schema.safeParse(null).success);
    });
  });

  describe('constraint type validation fixes', () => {
    const compileSource = (source: JsonObject) =>
      createSchemaCompiler({ components: { schemas: {} } })({
        source,
        location: '/components/schemas/TestSchema',
      });

    it('uniqueItems constraint works on arrays', () => {
      const schema = compileSource({
        type: 'array',
        items: { type: 'string' },
        uniqueItems: true,
      });
      assert(schema.safeParse(['a', 'b', 'c']).success);
      assert(schema.safeParse(['a', 'a']).success === false);
    });

    it('minProperties constraint works on objects', () => {
      const schema = compileSource({
        type: 'object',
        properties: { name: { type: 'string' } },
        minProperties: 1,
      });
      assert(schema.safeParse({ name: 'test' }).success);
      assert(schema.safeParse({}).success === false);
    });

    it('maxProperties constraint works on objects', () => {
      const schema = compileSource({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          email: { type: 'string' },
        },
        maxProperties: 2,
      });
      assert(schema.safeParse({ name: 'test' }).success);
      assert(schema.safeParse({ name: 'test', age: 30 }).success);
      assert(
        schema.safeParse({ name: 'test', age: 30, email: 'test@example.com' }).success === false,
      );
    });

    it('uniqueItems compares nested objects and arrays structurally', () => {
      const schema = compileSource({ type: 'array', uniqueItems: true });
      assert(
        schema.safeParse([
          { a: 1, b: [1, 2] },
          { a: 1, b: [2, 1] },
        ]).success,
      );
      assert(
        !schema.safeParse([
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ]).success,
      );
      assert(schema.safeParse([1, '1']).success);
    });

    it('uniqueItems false does not enforce uniqueness', () => {
      const schema = compileSource({ type: 'array', uniqueItems: false });
      assert(schema.safeParse(['a', 'a']).success);
    });

    it('minProperties and maxProperties count additional properties', () => {
      const schema = compileSource({ type: 'object', minProperties: 1, maxProperties: 2 });
      assert(!schema.safeParse({}).success);
      assert(schema.safeParse({ x: 1 }).success);
      assert(!schema.safeParse({ x: 1, y: 2, z: 3 }).success);
    });

    it('requires an explicit type for uniqueItems and minProperties', () => {
      assert.throws(
        () => compileSource({ uniqueItems: true }),
        /array constraints require a compatible explicit type/,
      );
      assert.throws(
        () => compileSource({ minProperties: 1 }),
        /object constraints require a compatible explicit type/,
      );
    });

    it('ignores constraints that belong to a different explicit type', () => {
      assert(compileSource({ type: 'string', minProperties: 1 }).safeParse('x').success);
      assert(compileSource({ type: 'object', uniqueItems: true }).safeParse({}).success);
    });
  });

  describe('complex const values', () => {
    const compileSource = (source: JsonObject) =>
      createSchemaCompiler({ components: { schemas: {} } })({
        source,
        location: '/components/schemas/TestSchema',
      });

    it('accepts const with scalar string', () => {
      const schema = compileSource({
        type: 'string',
        const: 'only-this',
      });
      assert(schema.safeParse('only-this').success);
      assert(schema.safeParse('other').success === false);
    });

    it('accepts const with scalar number', () => {
      const schema = compileSource({
        type: 'number',
        const: 42,
      });
      assert(schema.safeParse(42).success);
      assert(schema.safeParse(43).success === false);
    });

    it('accepts const with boolean', () => {
      const schema = compileSource({
        type: 'boolean',
        const: true,
      });
      assert(schema.safeParse(true).success);
      assert(schema.safeParse(false).success === false);
    });

    it('rejects const value when type does not match (string const vs number type)', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'number',
            const: 'not-a-number',
          }),
        /const value type \(string\) does not match schema type \(number\)/,
      );
    });

    it('rejects const value when type does not match (number const vs string type)', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'string',
            const: 42,
          }),
        /const value type \(number\) does not match schema type \(string\)/,
      );
    });

    it('rejects const value when type does not match (float const vs integer type)', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'integer',
            const: 3.14,
          }),
        /const value type \(number\) does not match schema type \(integer\)/,
      );
    });

    it('rejects const value when type does not match (boolean const vs string type)', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'string',
            const: true,
          }),
        /const value type \(boolean\) does not match schema type \(string\)/,
      );
    });

    it('compiles type array with multiple non-null types', () => {
      const schema = compileSource({ type: ['string', 'number'] });
      assert(schema.safeParse('text').success);
      assert(schema.safeParse(42).success);
      assert(!schema.safeParse(true).success);
    });

    it('compiles type array with multiple non-null types and includes null', () => {
      const schema = compileSource({ type: ['string', 'number', 'null'] });
      assert(schema.safeParse('text').success);
      assert(schema.safeParse(42).success);
      assert(schema.safeParse(null).success);
      assert(!schema.safeParse(true).success);
    });
    it('allows const with null on nullable type', () => {
      const schema = compileSource({
        type: ['string', 'null'],
        const: null,
      });
      assert(schema.safeParse(null).success);
      assert(schema.safeParse('other').success === false);
    });

    it('rejects const null on non-nullable type', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'string',
            const: null,
          }),
        /const value type \(object\) does not match schema type \(string\)/,
      );
    });
  });

  describe('Unimplemented keywords error handling', () => {
    const compileSource = (source: JsonObject) =>
      createSchemaCompiler({ components: { schemas: {} } })({
        source,
        location: '/components/schemas/TestSchema',
      });

    it('compiles byte format as base64 on strings', () => {
      const schema = compileSource({ type: 'string', format: 'byte' });
      assert(schema.safeParse('aGVsbG8=').success);
      assert(!schema.safeParse('not base64!').success);
    });

    it('rejects binary on strings and byte/binary on numbers', () => {
      assert.throws(
        () => compileSource({ type: 'string', format: 'binary' }),
        /unsupported format binary/,
      );
      assert.throws(
        () => compileSource({ type: 'integer', format: 'byte' }),
        /unsupported numeric format/,
      );
      assert.throws(
        () => compileSource({ type: 'number', format: 'binary' }),
        /unsupported numeric format/,
      );
    });

    it('compiles discriminator with implicit and explicit mapping', () => {
      const compile = createSchemaCompiler({
        components: {
          schemas: {
            Cat: {
              type: 'object',
              properties: { kind: { type: 'string' }, lives: { type: 'integer' } },
              required: ['kind', 'lives'],
            },
            Dog: {
              type: 'object',
              properties: { kind: { type: 'string' }, bark: { type: 'boolean' } },
              required: ['kind'],
            },
          },
        },
      });
      const schema = compile({
        source: {
          anyOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
          discriminator: {
            propertyName: 'kind',
            mapping: { puppy: '#/components/schemas/Dog' },
          },
        },
        location: '/components/schemas/Pet',
      });
      assert(schema.safeParse({ kind: 'Cat', lives: 9 }).success);
      assert(schema.safeParse({ kind: 'puppy', bark: true }).success);
      // Tag routes to Cat, which requires lives, even though Dog would match.
      assert(!schema.safeParse({ kind: 'Cat', bark: true }).success);
      assert(!schema.safeParse({ kind: 'puppy', bark: 'loud' }).success);
    });

    it('routes a bare-name mapping and falls back to oneOf for unmapped or missing tags', () => {
      const pet = createSchemaCompiler({
        components: {
          schemas: {
            Cat: {
              type: 'object',
              properties: { kind: { type: 'string' }, lives: { type: 'integer' } },
              required: ['lives'],
            },
            Dog: {
              type: 'object',
              properties: { kind: { type: 'string' }, bark: { type: 'boolean' } },
              required: ['bark'],
            },
          },
        },
      })({
        source: {
          oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
          discriminator: { propertyName: 'kind', mapping: { puppy: 'Dog' } },
        },
        location: '/components/schemas/Pet',
      });
      assert(pet.safeParse({ kind: 'puppy', bark: true }).success);
      assert(!pet.safeParse({ kind: 'puppy', lives: 9 }).success);
      // Unmapped and missing tags fall back to plain oneOf semantics.
      assert(pet.safeParse({ kind: 'Hamster', bark: true }).success);
      assert(pet.safeParse({ bark: true }).success);
      assert(!pet.safeParse({ kind: 'Hamster' }).success);
      assert(!pet.safeParse('not an object').success);
    });

    it('rejects a oneOf/allOf cycle that never consumes structure', () => {
      const compile = createSchemaCompiler({
        components: {
          schemas: {
            Pet: {
              oneOf: [{ $ref: '#/components/schemas/Cat' }],
              discriminator: { propertyName: 'kind' },
            },
            Cat: { allOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'object' }] },
          },
        },
      });
      assert.throws(
        () => compile({ source: { $ref: '#/components/schemas/Pet' }, location: '/Pet' }),
        /unproductive composition cycle/,
      );
    });

    it('rejects a cycle that runs through a discriminator mapping target', () => {
      const compile = createSchemaCompiler({
        components: {
          schemas: {
            Pet: {
              oneOf: [{ type: 'object' }],
              discriminator: { propertyName: 'kind', mapping: { dog: 'Dog' } },
            },
            Dog: { allOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'object' }] },
          },
        },
      });
      assert.throws(
        () => compile({ source: { $ref: '#/components/schemas/Pet' }, location: '/Pet' }),
        /unproductive composition cycle/,
      );
    });

    it('enforces a discriminator mapping on a parent without oneOf', () => {
      const compile = createSchemaCompiler({
        components: {
          schemas: {
            Pet: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                friends: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
              },
              discriminator: { propertyName: 'kind', mapping: { dog: 'Dog' } },
            },
            Dog: {
              allOf: [
                { $ref: '#/components/schemas/Pet' },
                { type: 'object', properties: { bark: { type: 'boolean' } }, required: ['bark'] },
              ],
            },
          },
        },
      });
      const pet = compile({ source: { $ref: '#/components/schemas/Pet' }, location: '/Pet' });
      assert(pet.safeParse({ kind: 'dog', bark: true }).success);
      assert(!pet.safeParse({ kind: 'dog' }).success);
      assert(pet.safeParse({ kind: 'cat' }).success);
      // A nested friend with the same tag is still routed on its own.
      assert(!pet.safeParse({ kind: 'dog', bark: true, friends: [{ kind: 'dog' }] }).success);
      assert(
        pet.safeParse({ kind: 'dog', bark: true, friends: [{ kind: 'dog', bark: false }] }).success,
      );
    });

    it('allows recursion through properties and items', () => {
      const tree = createSchemaCompiler({
        components: {
          schemas: {
            Node: {
              allOf: [
                {
                  type: 'object',
                  properties: {
                    children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
                  },
                },
              ],
            },
          },
        },
      })({ source: { $ref: '#/components/schemas/Node' }, location: '/Node' });
      assert(tree.safeParse({ children: [{ children: [] }] }).success);
      assert(!tree.safeParse({ children: [{ children: 'x' }] }).success);
    });

    it('rejects malformed discriminator and dangling mapping', () => {
      assert.throws(
        () => compileSource({ oneOf: [{ type: 'string' }], discriminator: { propertyName: '' } }),
        /invalid discriminator/,
      );
      assert.throws(
        () =>
          compileSource({
            oneOf: [{ type: 'string' }],
            discriminator: { propertyName: 'kind', mapping: { a: 'Missing' } },
          }),
        /dangling reference/,
      );
      assert.throws(
        () =>
          compileSource({
            oneOf: [{ type: 'string' }],
            discriminator: { propertyName: 'kind', mapping: { a: 'https://x.test/a' } },
          }),
        /external reference/,
      );
    });

    it('compiles prefixItems with items constraining the remainder', () => {
      const closed = compileSource({
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'integer' }],
        items: false,
      });
      assert(closed.safeParse([]).success);
      assert(closed.safeParse(['a']).success);
      assert(closed.safeParse(['a', 1]).success);
      assert(!closed.safeParse(['a', 1, 2]).success);
      assert(!closed.safeParse([1]).success);
      const open = compileSource({
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: { type: 'integer' },
        minItems: 2,
      });
      assert(open.safeParse(['a', 1, 2]).success);
      assert(!open.safeParse(['a', 'b']).success);
      assert(!open.safeParse(['a']).success);
      assert.throws(
        () => compileSource({ type: 'array', prefixItems: [] }),
        /prefixItems must be a non-empty array/,
      );
    });

    it('compiles contains with minContains and maxContains', () => {
      const contains = compileSource({
        type: 'array',
        contains: { type: 'string', const: 'x' },
      });
      assert(contains.safeParse([1, 'x']).success);
      assert(!contains.safeParse([1]).success);
      assert(!contains.safeParse([]).success);
      const counted = compileSource({
        type: 'array',
        contains: { type: 'string' },
        minContains: 2,
        maxContains: 3,
      });
      assert(!counted.safeParse(['a', 1]).success);
      assert(counted.safeParse(['a', 'b', 1]).success);
      assert(!counted.safeParse(['a', 'b', 'c', 'd']).success);
      const optional = compileSource({
        type: 'array',
        contains: { type: 'string' },
        minContains: 0,
      });
      assert(optional.safeParse([1]).success);
    });

    it('compiles dependentRequired', () => {
      const schema = compileSource({ type: 'object', dependentRequired: { a: ['b'] } });
      assert(schema.safeParse({}).success);
      assert(schema.safeParse({ b: 1 }).success);
      assert(schema.safeParse({ a: 1, b: 2 }).success);
      assert(!schema.safeParse({ a: 1 }).success);
      assert.throws(
        () => compileSource({ type: 'object', dependentRequired: { a: 'b' } }),
        /dependentRequired must map/,
      );
    });

    it('compiles dependentSchemas on the whole object', () => {
      const schema = compileSource({
        type: 'object',
        dependentSchemas: { a: { required: ['b'] }, c: { minProperties: 3 } },
      });
      assert(schema.safeParse({}).success);
      assert(schema.safeParse({ a: 1, b: 2 }).success);
      assert(!schema.safeParse({ a: 1 }).success);
      assert(!schema.safeParse({ c: 1, d: 2 }).success);
      assert(schema.safeParse({ c: 1, d: 2, e: 3 }).success);
    });

    it('does not treat a default-only key as the trigger of a dependency', () => {
      const schema = compileSource({
        type: 'object',
        properties: { a: { type: 'string', default: 'x' } },
        dependentRequired: { a: ['b'] },
      });
      assert(schema.safeParse({}).success);
      assert(!schema.safeParse({ a: 'y' }).success);
    });

    it('applies unevaluatedProperties after allOf, $ref, anyOf and if/then', () => {
      const compile = createSchemaCompiler({
        components: {
          schemas: { Base: { type: 'object', properties: { id: { type: 'string' } } } },
        },
      });
      const build = (source: JsonObject) => compile({ source, location: '/components/schemas/T' });
      const allOf = build({
        allOf: [{ $ref: '#/components/schemas/Base' }],
        unevaluatedProperties: false,
      });
      assert(allOf.safeParse({ id: 'x' }).success);
      assert(!allOf.safeParse({ id: 'x', extra: 1 }).success);
      const direct = build({ $ref: '#/components/schemas/Base', unevaluatedProperties: false });
      assert(direct.safeParse({ id: 'x' }).success);
      assert(!direct.safeParse({ id: 'x', extra: 1 }).success);
      const typed = build({
        allOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
        unevaluatedProperties: { type: 'integer' },
      });
      assert(typed.safeParse({ a: 'x', b: 1 }).success);
      assert(!typed.safeParse({ a: 'x', b: 'y' }).success);
      const anyOf = build({
        type: 'object',
        properties: { a: { type: 'string' } },
        anyOf: [
          { properties: { b: { type: 'integer' } }, required: ['b'] },
          { properties: { c: { type: 'integer' } }, required: ['c'] },
        ],
        unevaluatedProperties: false,
      });
      assert(anyOf.safeParse({ a: 'x', b: 1 }).success);
      assert(anyOf.safeParse({ a: 'x', c: 1 }).success);
      assert(!anyOf.safeParse({ a: 'x', b: 1, d: 1 }).success);
      const conditional = build({
        type: 'object',
        properties: { kind: { type: 'string' } },
        if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
        then: { properties: { extra: { type: 'string' } } },
        unevaluatedProperties: false,
      });
      assert(conditional.safeParse({ kind: 'a', extra: 'x' }).success);
      assert(!conditional.safeParse({ kind: 'b', extra: 'x' }).success);
    });

    it('applies unevaluatedItems after prefixItems, items and allOf', () => {
      const prefixed = compileSource({
        type: 'array',
        prefixItems: [{ type: 'string' }],
        unevaluatedItems: false,
      });
      assert(prefixed.safeParse(['a']).success);
      assert(!prefixed.safeParse(['a', 'b']).success);
      const composed = compileSource({
        allOf: [{ type: 'array', items: { type: 'string' } }],
        unevaluatedItems: false,
      });
      assert(composed.safeParse(['a', 'b']).success);
      assert(!composed.safeParse(['a', 1]).success);
    });

    it('compiles contentEncoding, contentMediaType and contentSchema', () => {
      const base64 = compileSource({ type: 'string', contentEncoding: 'base64' });
      assert(base64.safeParse('aGVsbG8=').success);
      assert(!base64.safeParse('!!').success);
      const json = compileSource({
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: { type: 'object', required: ['a'] },
      });
      assert(json.safeParse('{"a":1}').success);
      assert(!json.safeParse('{}').success);
      assert(!json.safeParse('nope').success);
      const encoded = compileSource({
        type: 'string',
        contentEncoding: 'base64',
        contentMediaType: 'application/json',
      });
      assert(encoded.safeParse(Buffer.from('{"a":1}').toString('base64')).success);
      assert(!encoded.safeParse(Buffer.from('x').toString('base64')).success);
      assert(
        compileSource({ type: 'string', contentMediaType: 'image/png' }).safeParse('anything')
          .success,
      );
      assert.throws(
        () => compileSource({ type: 'string', contentEncoding: 'quoted-printable' }),
        /unsupported contentEncoding/,
      );
    });

    it('enforces propertyNames on every key, including additional ones', () => {
      const schema = compileSource({
        type: 'object',
        properties: { id: { type: 'string' } },
        propertyNames: { pattern: '^[a-z]+$' },
      });
      assert(schema.safeParse({}).success);
      assert(schema.safeParse({ id: 'x', extra: 1 }).success);
      assert(!schema.safeParse({ id: 'x', Extra: 1 }).success);
      assert(!schema.safeParse({ 'a-b': 1 }).success);
    });

    it('supports typed, enum, length, $ref and boolean propertyNames', () => {
      const compile = createSchemaCompiler({
        components: { schemas: { Key: { type: 'string', maxLength: 3 } } },
      });
      const build = (propertyNames: unknown) =>
        compile({
          source: { type: 'object', propertyNames } as JsonObject,
          location: '/components/schemas/TestSchema',
        });
      assert(build({ enum: ['a', 'b'] }).safeParse({ a: 1 }).success);
      assert(!build({ enum: ['a', 'b'] }).safeParse({ c: 1 }).success);
      assert(!build({ type: 'string', minLength: 2 }).safeParse({ a: 1 }).success);
      assert(build({ $ref: '#/components/schemas/Key' }).safeParse({ abc: 1 }).success);
      assert(!build({ $ref: '#/components/schemas/Key' }).safeParse({ abcd: 1 }).success);
      assert(build(true).safeParse({ anything: 1 }).success);
      assert(build(false).safeParse({}).success);
      assert(!build(false).safeParse({ a: 1 }).success);
    });

    it('requires an explicit object type and a valid schema for propertyNames', () => {
      assert.throws(
        () => compileSource({ propertyNames: { pattern: '^a$' } }),
        /object constraints require a compatible explicit type/,
      );
      assert.throws(() => compileSource({ type: 'object', propertyNames: 'x' }), /propertyNames/);
      assert.throws(
        () => compileSource({ type: 'object', propertyNames: { type: 'string', format: 'ipv4' } }),
        /unsupported format ipv4/,
      );
    });

    it('ignores propertyNames on a non-object type', () => {
      assert(
        compileSource({ type: 'string', propertyNames: { pattern: '^a$' } }).safeParse('b').success,
      );
    });

    it('applies propertyNames to untyped members of allOf, anyOf and oneOf', () => {
      const allOf = compileSource({
        type: 'object',
        propertyNames: { allOf: [{ pattern: '^a' }, { maxLength: 3 }] },
      });
      assert(allOf.safeParse({ abc: 1 }).success);
      assert(!allOf.safeParse({ abcd: 1 }).success);
      assert(!allOf.safeParse({ bc: 1 }).success);
      const oneOf = compileSource({
        type: 'object',
        propertyNames: { oneOf: [{ enum: ['a'] }, { enum: ['b'] }] },
      });
      assert(oneOf.safeParse({ a: 1 }).success);
      assert(!oneOf.safeParse({ c: 1 }).success);
    });

    it('does not apply propertyNames to a key that only holds its default', () => {
      const schema = compileSource({
        type: 'object',
        properties: { Foo_Bar: { type: 'string', default: 'x' } },
        propertyNames: { pattern: '^[a-z]+$' },
      });
      assert(schema.safeParse({}).success);
      assert(schema.safeParse({ Foo_Bar: 'x' }).success);
      assert(!schema.safeParse({ Foo_Bar: 'y' }).success);
      assert(!schema.safeParse({ Other: 1 }).success);
      const closed = compileSource({
        type: 'object',
        properties: { id: { type: 'string', default: 'x' } },
        propertyNames: false,
      });
      assert(closed.safeParse({}).success);
      assert(!closed.safeParse({ extra: 1 }).success);
    });

    it('compiles if/then/else conditionals', () => {
      const schema = compileSource({
        type: 'object',
        properties: { kind: { type: 'string' }, amount: { type: 'number' } },
        required: ['kind'],
        if: { properties: { kind: { const: 'amount' } }, required: ['kind'] },
        then: { required: ['amount'] },
        else: { properties: { amount: { type: 'string' } } },
      });
      assert(schema.safeParse({ kind: 'amount', amount: 1 }).success);
      assert(!schema.safeParse({ kind: 'amount' }).success);
      assert(schema.safeParse({ kind: 'other' }).success);
    });
  });

  it('matches const branches in a multi-type array', () => {
    const compileSource = (source: JsonObject) =>
      createSchemaCompiler({ components: { schemas: {} } })({
        source,
        location: '/components/schemas/TestSchema',
      });
    const stringSchema = compileSource({ type: ['string', 'number'], const: 'fixed' });
    assert(stringSchema.safeParse('fixed').success);
    assert(!stringSchema.safeParse(42).success);

    const numberSchema = compileSource({ type: ['string', 'number'], const: 42 });
    assert(numberSchema.safeParse(42).success);
    assert(!numberSchema.safeParse('fixed').success);

    const nullSchema = compileSource({ type: ['string', 'null'], const: null });
    assert(nullSchema.safeParse(null).success);
    assert(!nullSchema.safeParse('fixed').success);
  });
});

describe('Boolean if/then/else', () => {
  const compileSource = (source: JsonObject) =>
    createSchemaCompiler({ components: { schemas: {} } })({
      source,
      location: '/components/schemas/TestSchema',
    });

  it('treats then: false as rejecting every value that matches the if', () => {
    const schema = compileSource({
      type: 'object',
      properties: { kind: { type: 'string' } },
      if: { properties: { kind: { const: 'banned' } }, required: ['kind'] },
      then: false,
    });
    assert(!schema.safeParse({ kind: 'banned' }).success);
    assert(schema.safeParse({ kind: 'fine' }).success);
  });

  it('treats else: false as rejecting every value that fails the if', () => {
    const schema = compileSource({
      type: 'object',
      properties: { kind: { type: 'string' } },
      if: { properties: { kind: { const: 'only' } }, required: ['kind'] },
      else: false,
    });
    assert(schema.safeParse({ kind: 'only' }).success);
    assert(!schema.safeParse({ kind: 'other' }).success);
  });

  it('treats then: true and else: true as always passing', () => {
    const schema = compileSource({ type: 'object', if: {}, then: true, else: true });
    assert(schema.safeParse({}).success);
  });

  it('accepts a boolean if', () => {
    const always = compileSource({
      type: 'string',
      if: true,
      then: { type: 'string', minLength: 3 },
    });
    assert(!always.safeParse('ab').success);
    assert(always.safeParse('abc').success);
    const never = compileSource({
      type: 'string',
      if: false,
      then: { type: 'string', minLength: 10 },
      else: { type: 'string', maxLength: 2 },
    });
    assert(never.safeParse('ab').success);
    assert(!never.safeParse('abc').success);
  });

  it('rejects a non-schema if/then/else value', () => {
    assert.throws(() => compileSource({ type: 'string', if: 'yes', then: {} }));
    assert.throws(() => compileSource({ type: 'string', if: {}, then: 5 }));
  });

  it('converts boolean conditionals through tool compilation', () => {
    const tool = compileTools({
      source: {
        openapi: '3.1.0',
        paths: {
          '/x': {
            post: {
              operationId: 'xController_create_v1',
              summary: 'Create',
              description: 'Create x.',
              requestBody: {
                required: true,
                content: {
                  'application/json': { schema: { type: 'string', if: true, then: false } },
                },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      },
      overlay: { version: 2, schemas: [], operations: [] },
    }).tools[0]!;
    assert(!tool.plan.input.safeParse({ request: 'anything' }).success);
  });
});

describe('Schemas survive tool compilation', () => {
  const toolFor = (schema: JsonObject) =>
    compileTools({
      source: {
        openapi: '3.1.0',
        paths: {
          '/x': {
            post: {
              operationId: 'xController_create_v1',
              summary: 'Create',
              description: 'Create x.',
              requestBody: { required: true, content: { 'application/json': { schema } } },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      },
      overlay: { version: 2, schemas: [], operations: [] },
    }).tools[0]!;

  it('converts if/then/else schemas to JSON Schema and still enforces them', () => {
    const tool = toolFor({
      type: 'object',
      properties: { kind: { type: 'string' }, amount: { type: 'number' } },
      if: { properties: { kind: { const: 'amount' } }, required: ['kind'] },
      then: { required: ['amount'] },
    });
    const input = tool.plan.input;
    assert(input.safeParse({ request: { kind: 'amount', amount: 1 } }).success);
    assert(!input.safeParse({ request: { kind: 'amount' } }).success);
  });

  it('converts complex const schemas to JSON Schema and still enforces them', () => {
    const tool = toolFor({ const: { a: 1, b: [2] } });
    const input = tool.plan.input;
    assert(input.safeParse({ request: { b: [2], a: 1 } }).success);
    assert(!input.safeParse({ request: { a: 2, b: [2] } }).success);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSchemaCompiler } from '../src/schema/compiler.js';
import type { JsonObject } from '../src/openapi/metadata.js';

describe('Phase 3: OpenAPI 3.1 Schema Support', () => {
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

  describe('combined phase 3 features', () => {
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

  describe('const with complex values error handling', () => {
    const compileSource = (source: JsonObject) =>
      createSchemaCompiler({ components: { schemas: {} } })({
        source,
        location: '/components/schemas/TestSchema',
      });

    it('throws error for const with object value', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'object',
            const: { version: '1.0' },
          }),
        /const with complex values \(objects\/arrays\) not yet supported/,
      );
    });

    it('throws error for const with array value', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'array',
            const: ['fixed', 'items'],
          }),
        /const with complex values \(objects\/arrays\) not yet supported/,
      );
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

    it('throws error for type array with multiple non-null types', () => {
      assert.throws(
        () =>
          compileSource({
            type: ['string', 'number'],
          }),
        /type array with multiple non-null types \[string, number\] is not yet supported/,
      );
    });

    it('throws error for type array with multiple non-null types and includes null', () => {
      assert.throws(
        () =>
          compileSource({
            type: ['string', 'number', 'null'],
          }),
        /type array with multiple non-null types \[string, number\] is not yet supported/,
      );
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

  describe('Phase 4: Unimplemented keywords error handling', () => {
    const compileSource = (source: JsonObject) =>
      createSchemaCompiler({ components: { schemas: {} } })({
        source,
        location: '/components/schemas/TestSchema',
      });

    it('rejects schema with discriminator keyword (Phase 4)', () => {
      assert.throws(
        () =>
          compileSource({
            discriminator: { propertyName: 'type' },
            oneOf: [{ $ref: '#/components/schemas/Cat' }],
          }),
        /discriminator is not yet supported; it is a Phase 4 feature/,
      );
    });

    it('rejects schema with if/then/else keywords (Phase 4)', () => {
      assert.throws(
        () =>
          compileSource({
            if: { properties: { foo: { const: 1 } } },
            then: { required: ['bar'] },
          }),
        /if is not yet supported; it is a Phase 4 feature/,
      );
    });

    it('rejects schema with prefixItems keyword (Phase 4)', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'array',
            prefixItems: [{ type: 'string' }, { type: 'number' }],
          }),
        /prefixItems is not yet supported; it is a Phase 4 feature/,
      );
    });

    it('rejects schema with dependentRequired keyword (Phase 4)', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'object',
            dependentRequired: { foo: ['bar'] },
          }),
        /dependentRequired is not yet supported; it is a Phase 4 feature/,
      );
    });

    it('rejects schema with unevaluatedProperties keyword (Phase 4)', () => {
      assert.throws(
        () =>
          compileSource({
            type: 'object',
            properties: { foo: { type: 'string' } },
            unevaluatedProperties: false,
          }),
        /unevaluatedProperties is not yet supported; it is a Phase 4 feature/,
      );
    });
  });
});

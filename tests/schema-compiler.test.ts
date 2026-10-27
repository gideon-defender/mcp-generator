import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSchemaCompiler } from '../src/schema/compiler.js';
import type { JsonObject } from '../src/openapi/metadata.js';

function compilerFor(components: JsonObject = {}) {
  return createSchemaCompiler({ components });
}

describe('schema compiler: primitive types', () => {
  it('compiles string constraints and rejects values outside them', () => {
    const compile = compilerFor();
    const schema = compile({
      source: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
      location: '#',
    });
    assert.equal(schema.safeParse('ab').success, true);
    assert.equal(schema.safeParse('a').success, false);
    assert.equal(schema.safeParse('abcde').success, false);
    assert.equal(schema.safeParse('AB').success, false);
  });

  it('compiles each supported string format', () => {
    const compile = compilerFor();
    assert.equal(
      compile({ source: { type: 'string', format: 'date-time' }, location: '#' }).safeParse(
        '2026-10-27T00:00:00Z',
      ).success,
      true,
    );
    assert.equal(
      compile({ source: { type: 'string', format: 'date' }, location: '#' }).safeParse('2026-10-27')
        .success,
      true,
    );
    assert.equal(
      compile({ source: { type: 'string', format: 'email' }, location: '#' }).safeParse(
        'not-an-email',
      ).success,
      false,
    );
    assert.equal(
      compile({ source: { type: 'string', format: 'uuid' }, location: '#' }).safeParse(
        '3f9a7b2e-1c4d-4e8a-9f2b-0a1b2c3d4e5f',
      ).success,
      true,
    );
    assert.equal(
      compile({ source: { type: 'string', format: 'uri' }, location: '#' }).safeParse(
        'https://example.test',
      ).success,
      true,
    );
    // `password` is a documentation-only hint with no validation behavior.
    assert.equal(
      compile({ source: { type: 'string', format: 'password' }, location: '#' }).safeParse('x')
        .success,
      true,
    );
  });

  it('rejects an unsupported string format', () => {
    const compile = compilerFor();
    assert.throws(
      () => compile({ source: { type: 'string', format: 'bogus' }, location: '#' }),
      /unsupported format/,
    );
  });

  it('compiles number/integer bounds including exclusivity and multipleOf', () => {
    const compile = compilerFor();
    const inclusive = compile({
      source: { type: 'number', minimum: 1, maximum: 5 },
      location: '#',
    });
    assert.equal(inclusive.safeParse(1).success, true);
    assert.equal(inclusive.safeParse(5).success, true);
    assert.equal(inclusive.safeParse(0.9).success, false);

    const exclusive = compile({
      source: {
        type: 'number',
        minimum: 1,
        exclusiveMinimum: true,
        maximum: 5,
        exclusiveMaximum: true,
      },
      location: '#',
    });
    assert.equal(exclusive.safeParse(1).success, false);
    assert.equal(exclusive.safeParse(5).success, false);
    assert.equal(exclusive.safeParse(2).success, true);

    const integer = compile({ source: { type: 'integer', multipleOf: 3 }, location: '#' });
    assert.equal(integer.safeParse(9).success, true);
    assert.equal(integer.safeParse(10).success, false);
    assert.equal(integer.safeParse(1.5).success, false);
  });

  it('rejects an unsupported numeric format but allows the OpenAPI-defined ones', () => {
    const compile = compilerFor();
    for (const format of ['int32', 'int64', 'float', 'double']) {
      assert.doesNotThrow(() => compile({ source: { type: 'number', format }, location: '#' }));
    }
    assert.throws(
      () => compile({ source: { type: 'number', format: 'bogus' }, location: '#' }),
      /unsupported numeric format/,
    );
  });

  it('compiles booleans and enums', () => {
    const compile = compilerFor();
    const bool = compile({ source: { type: 'boolean' }, location: '#' });
    assert.equal(bool.safeParse(true).success, true);
    assert.equal(bool.safeParse('true').success, false);

    const status = compile({ source: { enum: ['open', 'closed'] }, location: '#' });
    assert.equal(status.safeParse('open').success, true);
    assert.equal(status.safeParse('pending').success, false);
  });
});

describe('schema compiler: objects and arrays', () => {
  it('requires only the declared required properties', () => {
    const compile = compilerFor();
    const schema = compile({
      source: {
        type: 'object',
        properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id'],
      },
      location: '#',
    });
    assert.equal(schema.safeParse({ id: 'a' }).success, true);
    assert.equal(schema.safeParse({ note: 'a' }).success, false);
  });

  it('treats a required property with a default as satisfiable by omission', () => {
    const compile = compilerFor();
    const schema = compile({
      source: {
        type: 'object',
        properties: { count: { type: 'number', default: 0 } },
        required: ['count'],
      },
      location: '#',
    });
    assert.equal(schema.safeParse({}).success, true);
  });

  it('rejects unknown keys when additionalProperties is false, allows them otherwise', () => {
    const compile = compilerFor();
    const strict = compile({
      source: {
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: false,
      },
      location: '#',
    });
    assert.equal(strict.safeParse({ id: 'a', extra: 1 }).success, false);

    const open = compile({ source: { type: 'object', properties: {} }, location: '#' });
    assert.equal(open.safeParse({ extra: 1 }).success, true);

    const typed = compile({
      source: { type: 'object', properties: {}, additionalProperties: { type: 'number' } },
      location: '#',
    });
    assert.equal(typed.safeParse({ extra: 1 }).success, true);
    assert.equal(typed.safeParse({ extra: 'x' }).success, false);
  });

  it('compiles array item schemas and item-count bounds', () => {
    const compile = compilerFor();
    const schema = compile({
      source: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 2 },
      location: '#',
    });
    assert.equal(schema.safeParse([1]).success, true);
    assert.equal(schema.safeParse([]).success, false);
    assert.equal(schema.safeParse([1, 2, 3]).success, false);
    assert.equal(schema.safeParse(['x']).success, false);
  });

  it('rejects a type-specific constraint with no compatible explicit type', () => {
    const compile = compilerFor();
    assert.throws(
      () => compile({ source: { maxLength: 4 }, location: '#' }),
      /constraints require a compatible explicit type/,
    );
  });
});

describe('schema compiler: composition', () => {
  it('allOf intersects every branch', () => {
    const compile = compilerFor();
    const schema = compile({
      source: {
        allOf: [
          { type: 'number', minimum: 1 },
          { type: 'number', maximum: 5 },
        ],
      },
      location: '#',
    });
    assert.equal(schema.safeParse(3).success, true);
    assert.equal(schema.safeParse(0).success, false);
    assert.equal(schema.safeParse(6).success, false);
  });

  it('oneOf accepts exactly one matching branch', () => {
    const compile = compilerFor();
    const schema = compile({
      source: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      location: '#',
    });
    assert.equal(schema.safeParse('a').success, true);
    assert.equal(schema.safeParse(1).success, true);
    assert.equal(schema.safeParse(true).success, false);
  });

  it('anyOf accepts any matching branch', () => {
    const compile = compilerFor();
    const schema = compile({
      source: { anyOf: [{ type: 'string', minLength: 3 }, { type: 'number' }] },
      location: '#',
    });
    assert.equal(schema.safeParse('abcd').success, true);
    assert.equal(schema.safeParse(1).success, true);
    assert.equal(schema.safeParse('ab').success, false);
  });

  it('applies nullable and validates the default against the compiled schema', () => {
    const compile = compilerFor();
    const nullable = compile({ source: { type: 'string', nullable: true }, location: '#' });
    assert.equal(nullable.safeParse(null).success, true);

    assert.throws(
      () => compile({ source: { type: 'string', default: 1 }, location: '#' }),
      /invalid schema default/,
    );
    assert.doesNotThrow(() =>
      compile({ source: { type: 'string', default: 'ok' }, location: '#' }),
    );
  });
});

describe('schema compiler: $ref resolution', () => {
  it('resolves a local component reference', () => {
    const compile = compilerFor({ schemas: { Widget: { type: 'string', minLength: 1 } } });
    const schema = compile({
      source: { $ref: '#/components/schemas/Widget' },
      location: '#',
    });
    assert.equal(schema.safeParse('a').success, true);
    assert.equal(schema.safeParse('').success, false);
  });

  it('rejects an external reference', () => {
    const compile = compilerFor();
    assert.throws(
      () => compile({ source: { $ref: 'other.yaml#/Widget' }, location: '#' }),
      /external reference/,
    );
  });

  it('rejects a dangling reference', () => {
    const compile = compilerFor({ schemas: {} });
    assert.throws(
      () => compile({ source: { $ref: '#/components/schemas/Missing' }, location: '#' }),
      /dangling reference/,
    );
  });

  it('rejects an unproductive reference cycle', () => {
    const compile = compilerFor({
      schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: { $ref: '#/components/schemas/A' },
      },
    });
    assert.throws(
      () => compile({ source: { $ref: '#/components/schemas/A' }, location: '#' }),
      /unproductive reference cycle/,
    );
  });

  it('rejects a sibling constraint beside $ref but allows description/nullable/default', () => {
    const compile = compilerFor({ schemas: { Widget: { type: 'string' } } });
    assert.throws(
      () =>
        compile({
          source: { $ref: '#/components/schemas/Widget', minLength: 1 },
          location: '#',
        }),
      /unsupported constraint beside \$ref/,
    );
    assert.doesNotThrow(() =>
      compile({
        source: { $ref: '#/components/schemas/Widget', description: 'ok', nullable: true },
        location: '#',
      }),
    );
  });

  it('compiles a productive recursive schema lazily, without stack overflow', () => {
    const compile = compilerFor({
      schemas: {
        Node: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
          },
          required: ['label'],
        },
      },
    });
    const schema = compile({ source: { $ref: '#/components/schemas/Node' }, location: '#' });
    assert.equal(
      schema.safeParse({ label: 'root', children: [{ label: 'child', children: [] }] }).success,
      true,
    );
    assert.equal(schema.safeParse({ label: 'root', children: [{ children: [] }] }).success, false);
  });
});

describe('schema compiler: keyword and shape validation', () => {
  it('rejects an unsupported schema keyword', () => {
    const compile = compilerFor();
    assert.throws(
      () => compile({ source: { type: 'string', const: 'x' }, location: '#' }),
      /unsupported schema keyword/,
    );
  });

  it('allows vendor extension keywords through unchanged', () => {
    const compile = compilerFor();
    assert.doesNotThrow(() =>
      compile({ source: { type: 'string', 'x-note': 'ok' }, location: '#' }),
    );
  });

  it('wraps a nested failure with the outer location', () => {
    const compile = compilerFor();
    assert.throws(
      () =>
        compile({
          source: { type: 'object', properties: { bad: { type: 'string', format: 'bogus' } } },
          location: '#/components/schemas/Thing',
        }),
      /#\/components\/schemas\/Thing/,
    );
  });
});

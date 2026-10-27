import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { responseAccept } from '../src/request/accept.js';
import { compileRequest } from '../src/request/compile.js';
import { serializeRequest } from '../src/request/serialize.js';
import { createSchemaCompiler } from '../src/schema/compiler.js';
import type { JsonObject } from '../src/openapi/metadata.js';

const compile = createSchemaCompiler({ components: {} });

function plan({
  operation,
  pathItem = {},
  path = '/widgets/{id}',
}: {
  operation: JsonObject;
  pathItem?: JsonObject;
  path?: string;
}) {
  return compileRequest({ operation, pathItem, path, location: 'op', compile });
}

describe('compileRequest: parameters', () => {
  it('merges path-item and operation parameters, letting the operation override by name+location', () => {
    const result = plan({
      pathItem: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
      operation: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    });
    assert.equal(result.parameters.length, 1);
    assert.equal(result.parameters[0]?.name, 'id');
  });

  it('rejects a duplicate parameter declared twice on the same operation', () => {
    assert.throws(
      () =>
        plan({
          operation: {
            parameters: [
              { name: 'q', in: 'query', schema: { type: 'string' } },
              { name: 'q', in: 'query', schema: { type: 'string' } },
            ],
          },
        }),
      /duplicate parameter/,
    );
  });

  it('rejects a reserved/credential header parameter', () => {
    assert.throws(
      () =>
        plan({
          operation: {
            parameters: [{ name: 'Authorization', in: 'header', schema: { type: 'string' } }],
          },
        }),
      /credential\/reserved header parameter/,
    );
  });

  it('rejects a required path parameter missing from the path template', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
        }),
      /unused path parameter/,
    );
  });

  it('rejects a path template placeholder with no matching parameter', () => {
    assert.throws(() => plan({ operation: {} }), /missing path parameter id/);
  });

  it('rejects an optional path parameter', () => {
    assert.throws(
      () =>
        plan({
          operation: {
            parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
          },
        }),
      /path parameter must be required/,
    );
  });

  it('rejects a realistic content-style parameter (no schema, just content) and allowReserved', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: {
            parameters: [
              {
                name: 'q',
                in: 'query',
                content: { 'application/json': { schema: { type: 'string' } } },
              },
            ],
          },
        }),
      /unsupported parameter encoding/,
    );
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: {
            parameters: [
              { name: 'q', in: 'query', schema: { type: 'string' }, allowReserved: true },
            ],
          },
        }),
      /unsupported parameter encoding/,
    );
  });

  it('rejects a parameter with neither schema nor content', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: { parameters: [{ name: 'q', in: 'query' }] },
        }),
      /has neither schema nor content/,
    );
  });

  it('rejects an unsupported style for the parameter location', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: {
            parameters: [{ name: 'q', in: 'query', style: 'matrix', schema: { type: 'string' } }],
          },
        }),
      /unsupported query style matrix/,
    );
  });

  it('requires deepObject style to be an exploded object', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: {
            parameters: [
              {
                name: 'filter',
                in: 'query',
                style: 'deepObject',
                explode: false,
                schema: { type: 'object' },
              },
            ],
          },
        }),
      /deepObject requires an exploded object/,
    );
  });

  it('requires delimited styles to be a non-exploded array', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: {
            parameters: [
              {
                name: 'tags',
                in: 'query',
                style: 'pipeDelimited',
                explode: true,
                schema: { type: 'array', items: { type: 'string' } },
              },
            ],
          },
        }),
      /delimited queries require a non-exploded array/,
    );
  });
});

describe('compileRequest: body', () => {
  it('rejects a requestBody that is itself a $ref', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: { requestBody: { $ref: '#/components/requestBodies/Widget' } },
        }),
      /requestBody references are not supported/,
    );
  });

  it('rejects a non-JSON or multi-content-type body', () => {
    assert.throws(
      () =>
        plan({
          path: '/widgets',
          operation: {
            requestBody: {
              content: { 'multipart/form-data': { schema: { type: 'object' } } },
            },
          },
        }),
      /unsupported body MIME types/,
    );
  });

  it('nests the body under `body` only when parameters also exist, and flattens otherwise', () => {
    const flat = plan({
      path: '/widgets',
      operation: {
        requestBody: { content: { 'application/json': { schema: { type: 'string' } } } },
      },
    });
    assert.equal(flat.nestedBody, false);
    assert.equal(flat.input.safeParse({ request: 'hi' }).success, true);

    const nested = plan({
      operation: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'string' } } } },
      },
    });
    assert.equal(nested.nestedBody, true);
    assert.equal(nested.input.safeParse({ request: { id: 'a', body: 'hi' } }).success, true);
  });

  it('requires the whole request when any parameter or the body is required', () => {
    const required = plan({
      operation: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    });
    assert.equal(required.input.safeParse({}).success, false);

    const optional = plan({
      path: '/widgets',
      operation: {
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
      },
    });
    assert.equal(optional.input.safeParse({}).success, true);
  });

  it('produces an empty input schema with no parameters and no body', () => {
    const result = plan({ path: '/widgets', operation: {} });
    assert.deepEqual(result.input.safeParse({}).success, true);
    assert.equal(result.body, false);
  });
});

describe('responseAccept', () => {
  it('prefers application/json when declared', () => {
    const accept = responseAccept({
      responses: {
        '200': {
          content: { 'application/json': { schema: {} }, 'text/plain': { schema: {} } },
        },
      },
    });
    assert.equal(accept, 'application/json');
  });

  it('falls back to the only declared media type', () => {
    const accept = responseAccept({ responses: { '200': { content: { 'text/csv': {} } } } });
    assert.equal(accept, 'text/csv');
  });

  it('falls back to */* when no media type is declared', () => {
    assert.equal(responseAccept({ responses: { '200': {} } }), '*/*');
  });

  it('uses the hardcoded override keyed by the tool name, ignoring the spec', () => {
    const accept = responseAccept({
      'x-comp-mcp': { name: 'ai-chat-policy' },
      responses: { '200': { content: { 'application/json': {} } } },
    });
    assert.equal(accept, 'application/json;q=1, text/event-stream;q=0');
  });
});

describe('serializeRequest', () => {
  function serialize({
    operation,
    pathItem = {},
    path = '/widgets/{id}',
    input,
  }: {
    operation: JsonObject;
    pathItem?: JsonObject;
    path?: string;
    input: unknown;
  }) {
    return serializeRequest({ plan: plan({ operation, pathItem, path }), input, path });
  }

  it('substitutes a simple-style path parameter and leaves query/headers untouched', () => {
    const result = serialize({
      operation: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
      input: { request: { id: 'abc' } },
    });
    assert.equal(result.path, '/widgets/abc');
    assert.equal(result.query.toString(), '');
  });

  it('rejects a path value that collapses to a dot-segment', () => {
    assert.throws(
      () =>
        serialize({
          operation: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
          input: { request: { id: '..' } },
        }),
      /Dot path segments are not allowed/,
    );
  });

  it('serializes an exploded form array query parameter as repeated keys', () => {
    const result = serialize({
      path: '/widgets',
      operation: {
        parameters: [
          {
            name: 'tags',
            in: 'query',
            explode: true,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
      },
      input: { request: { tags: ['a', 'b'] } },
    });
    assert.deepEqual(result.query.getAll('tags'), ['a', 'b']);
  });

  it('serializes a deepObject query parameter as bracketed keys', () => {
    const result = serialize({
      path: '/widgets',
      operation: {
        parameters: [
          {
            name: 'filter',
            in: 'query',
            style: 'deepObject',
            explode: true,
            schema: { type: 'object' },
          },
        ],
      },
      input: { request: { filter: { status: 'open' } } },
    });
    assert.equal(result.query.get('filter[status]'), 'open');
  });

  it('serializes a simple header parameter without percent-encoding', () => {
    const result = serialize({
      path: '/widgets',
      operation: {
        parameters: [{ name: 'x-trace', in: 'header', schema: { type: 'string' } }],
      },
      input: { request: { xTrace: 'a b' } },
    });
    assert.equal(result.headers.get('x-trace'), 'a b');
  });

  it('serializes a JSON body and sets Content-Type from the operation', () => {
    const result = serialize({
      path: '/widgets',
      operation: {
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
      input: { request: { id: 'a' } },
    });
    assert.equal(result.body, JSON.stringify({ id: 'a' }));
    assert.equal(result.headers.get('content-type'), 'application/json');
  });

  it('sends the nested body field when parameters and a body coexist', () => {
    const result = serialize({
      operation: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
      input: { request: { id: 'a', body: { note: 'hi' } } },
    });
    assert.equal(result.path, '/widgets/a');
    assert.equal(result.body, JSON.stringify({ note: 'hi' }));
  });

  it('always sets the Accept header from the compiled plan', () => {
    const result = serialize({ path: '/widgets', operation: {}, input: {} });
    assert.equal(result.headers.get('accept'), '*/*');
  });
});

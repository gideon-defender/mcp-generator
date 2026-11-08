import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compileTools } from '../src/tools.js';
import { executeRequest } from '../src/client.js';
import type { McpMetadata } from '../src/openapi/metadata.js';
import { baseSpec, okOperation, text } from './helpers.js';

async function runWithPolicy(
  response: Response,
  metadata: McpMetadata,
  credential = 'caller-secret',
) {
  const compiled = compileTools({
    source: baseSpec({ '/records': { get: okOperation({ 'x-comp-mcp': metadata }) } }),
    overlay: { version: 1, schemas: [], operations: [] },
  });
  return executeRequest({
    tool: compiled.tools[0]!,
    input: {},
    servers: compiled.servers,
    options: { bearerToken: credential, fetch: async () => response },
  });
}

it('masks credentials in projected numeric leaves while preserving JSON and unrelated numbers', async () => {
  const result = await runWithPolicy(
    new Response(JSON.stringify({ id: 123456, nested: [91234567, 42], count: 7 }), {
      headers: { 'content-type': 'application/json' },
    }),
    { responseFields: ['/id', '/nested/*', '/count'] },
    '123456',
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(text(result)), {
    id: '[REDACTED]',
    nested: ['[REDACTED]', 42],
    count: 7,
  });
  assert.ok(!JSON.stringify(result).includes('123456'));
});

it('enforces standalone text limits in bytes below, at, and above the boundary', async () => {
  for (const size of [1023, 1024, 1025]) {
    const body = 'é'.repeat(Math.floor(size / 2)) + 'x'.repeat(size % 2);
    const result = await runWithPolicy(new Response(body), { maxResponseBytes: 1024 });
    if (size <= 1024) {
      assert.equal(result.isError, undefined);
      assert.equal(text(result), body);
    } else {
      assert.equal(result.isError, true);
      assert.ok(!text(result).includes(body));
    }
  }
});

it('enforces standalone image and audio limits below, at, and above the boundary', async () => {
  for (const mimeType of ['image/png', 'audio/mpeg']) {
    for (const size of [1023, 1024, 1025]) {
      const bytes = new Uint8Array(size).fill(97);
      const result = await runWithPolicy(
        new Response(bytes, { headers: { 'content-type': mimeType } }),
        { maxResponseBytes: 1024 },
      );
      if (size <= 1024) {
        assert.equal(result.isError, undefined);
        assert.deepEqual(result.content, [
          {
            type: mimeType.startsWith('image/') ? 'image' : 'audio',
            data: Buffer.from(bytes).toString('base64'),
            mimeType,
          },
        ]);
      } else {
        assert.equal(result.isError, true);
        assert.ok(result.content.every((block) => block.type === 'text'));
      }
    }
  }
});

it('cancels an oversized stream when cumulative chunks exceed a standalone limit', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(600));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await runWithPolicy(new Response(body), { maxResponseBytes: 1024 });
  assert.equal(result.isError, true);
  assert.equal(cancelled, true);
});

function tool() {
  return compileTools({
    source: baseSpec({ '/records': { get: okOperation() } }),
    overlay: {
      version: 1,
      schemas: [],
      operations: [
        {
          path: '/records',
          method: 'get',
          metadata: {
            responseFields: [
              '/data/*/id',
              '/data/*/roles/*',
              '/data/*/profile/display_name',
              '/next_cursor',
            ],
            responseMetadata: true,
            maxResponseBytes: 1024,
          },
        },
      ],
    },
  });
}
async function run(
  body: unknown,
  {
    status = 200,
    headers = {},
    raw = false,
  }: { status?: number; headers?: Record<string, string>; raw?: boolean } = {},
) {
  const compiled = tool();
  return executeRequest({
    tool: compiled.tools[0]!,
    input: {},
    servers: compiled.servers,
    options: {
      bearerToken: 'caller-secret',
      fetch: async () =>
        new Response(raw ? String(body) : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        }),
    },
  });
}

it('projects only reviewed scalar fields while preserving arrays, pagination, nulls and credential masking', async () => {
  const result = await run(
    {
      data: [
        {
          id: 'one',
          roles: ['admin'],
          profile: { display_name: 'caller-secret', token: 'secret' },
          private_key: 'secret',
          credentials: [{ secret: 'secret' }],
          new_field: { secret: 'secret' },
        },
        { id: 'two', roles: [], profile: null },
      ],
      next_cursor: 'opaque-cursor',
      secret: 'secret',
    },
    { headers: { 'x-request-id': 'req_123' } },
  );
  assert.deepEqual(JSON.parse(text(result)), {
    data: [
      { id: 'one', roles: ['admin'], profile: { display_name: '[REDACTED]' } },
      { id: 'two', roles: [], profile: null },
    ],
    next_cursor: 'opaque-cursor',
  });
  assert.deepEqual(result._meta, { upstream: { status: 200, requestId: 'req_123' } });
});

it('fails closed on malformed JSON, oversized responses, binary, HTML, and containers injected into scalar fields', async () => {
  for (const [body, opts] of [
    ['{broken', { raw: true }],
    [{ data: [{ id: 'x'.repeat(2000) }] }, {}],
    [{ data: [{ id: { secret: 'secret' } }] }, {}],
    [{ data: [{ roles: [{ secret: 'secret' }] }] }, {}],
    ['private data', { raw: true, headers: { 'content-type': 'image/png' } }],
    ['<p>private data</p>', { raw: true, headers: { 'content-type': 'text/html' } }],
  ] as const) {
    const result = await run(body, opts);
    assert.equal(result.isError, true);
    assert.ok(!text(result).includes('private data'));
    assert.ok(!text(result).includes('secret'));
  }
});

it('retains safe status/request IDs/retry hints and fixed categories without reading raw error bodies', async () => {
  for (const [status, category] of [
    [403, 'permission_denied'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [503, 'upstream_unavailable'],
  ] as const) {
    const result = await run(
      { error: { code: 'secret', message: 'caller-secret', step_up: { token: 'private' } } },
      { status, headers: { 'x-request-id': 'req_123', 'retry-after': '30' } },
    );
    assert.equal(result.isError, true);
    assert.equal(text(result), `API request failed (HTTP ${status}). Request ID: req_123.`);
    assert.deepEqual(result._meta, {
      upstream: { status, category, requestId: 'req_123', retryAfterSeconds: 30 },
    });
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

it('drops credential-bearing or malformed trace headers and unbounded retry values', async () => {
  for (const requestId of [
    'caller-secret',
    'Bearer private',
    'a'.repeat(129),
    'https://example.test/?token=private',
  ]) {
    const result = await run(
      {},
      { status: 403, headers: { 'x-request-id': requestId, 'retry-after': '999999999999' } },
    );
    assert.deepEqual(result._meta, { upstream: { status: 403, category: 'permission_denied' } });
    assert.equal(text(result), 'API request failed (HTTP 403).');
  }
});

it('rejects invalid projection pointers and unsupported response limits during compilation', () => {
  for (const responseFields of [[], ['data/id'], ['/bad~2key']]) {
    assert.throws(() =>
      compileTools({
        source: baseSpec({
          '/records': { get: okOperation({ 'x-comp-mcp': { responseFields } }) },
        }),
        overlay: { version: 1, schemas: [], operations: [] },
      }),
    );
  }
  for (const maxResponseBytes of [0, 100, 16_777_217]) {
    assert.throws(() =>
      compileTools({
        source: baseSpec({
          '/records': { get: okOperation({ 'x-comp-mcp': { maxResponseBytes } }) },
        }),
        overlay: { version: 1, schemas: [], operations: [] },
      }),
    );
  }
});

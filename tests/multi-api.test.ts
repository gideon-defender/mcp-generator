import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createMultiApiServerFactory, type ApiDefinition } from '../src/server.js';
import { baseSpec, okOperation, text } from './helpers.js';

function api(id: string, type: 'string' | 'integer' = 'string'): ApiDefinition {
  return {
    id,
    serverUrl: `https://${id}.example.test/base`,
    overlay: { version: 1, schemas: [], operations: [] },
    source: baseSpec(
      {
        '/records': {
          get: okOperation({
            operationId: 'listRecords',
            parameters: [
              {
                name: 'value',
                in: 'query',
                required: true,
                schema: { $ref: '#/components/schemas/Value' },
              },
            ],
            'x-comp-mcp': { upstream: 'https://untrusted.example.test' },
          }),
          post: okOperation({ operationId: 'createRecord' }),
        },
      },
      { components: { schemas: { Value: { type } } } },
    ),
  };
}

async function connect(factory: ReturnType<typeof createMultiApiServerFactory>) {
  const server = factory();
  const client = new Client({ name: 'multi-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

for (const mode of ['static', 'dynamic'] as const) {
  it(`isolates overlapping paths/schemas and pins upstream routing in ${mode} mode`, async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const factory = createMultiApiServerFactory({
      name: 'multi',
      version: '1',
      mode,
      apis: [api('first'), api('second', 'integer')],
      annotationFilter: { readOnlyHint: true },
      getOptions: () => ({
        bearerToken: 'caller',
        serverUrl: 'https://adapter-override.example.test',
        fetch: async (url, init) => {
          calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
          return new Response('{"ok":true}');
        },
      }),
    });
    const session = await connect(factory);
    try {
      const call = (name: string, value: unknown) =>
        session.client.callTool(
          mode === 'static'
            ? { name, arguments: { request: { value } } }
            : { name: 'execute_tool', arguments: { name, arguments: { request: { value } } } },
        );
      if (mode === 'static') {
        assert.deepEqual(
          (await session.client.listTools()).tools.map((t) => t.name),
          ['first-list-records', 'second-list-records'],
        );
      } else {
        const inventory = await session.client.callTool({ name: 'list_tools', arguments: {} });
        assert.deepEqual(
          JSON.parse(text(inventory)).map((t: { name: string }) => t.name),
          ['first-list-records', 'second-list-records'],
        );
      }
      assert.equal((await call('first-list-records', 'hello')).isError, undefined);
      assert.equal((await call('second-list-records', 42)).isError, undefined);
      assert.equal((await call('second-list-records', 'bad')).isError, true);
      assert.equal((await call('first-create-record', 'hidden')).isError, true);
      assert.deepEqual(calls, [
        { url: 'https://first.example.test/base/records?value=hello', auth: 'Bearer caller' },
        { url: 'https://second.example.test/base/records?value=42', auth: 'Bearer caller' },
      ]);
    } finally {
      await session.close();
    }
  });
}

it('routes composite subcalls across APIs under the same caller credential', async () => {
  const calls: string[] = [];
  const session = await connect(
    createMultiApiServerFactory({
      name: 'multi',
      version: '1',
      apis: [api('first'), api('second')],
      composites: [
        {
          name: 'overview',
          description: 'Read both APIs',
          input: z.object({}),
          run: async (_args, env) => {
            await env.callTool('first-list-records', { request: { value: 'one' } });
            return env.callTool('second-list-records', { request: { value: 'two' } });
          },
        },
      ],
      getOptions: () => ({
        bearerToken: 'caller',
        fetch: async (url) => {
          calls.push(String(url));
          return new Response('{}');
        },
      }),
    }),
  );
  try {
    assert.equal(
      (await session.client.callTool({ name: 'overview', arguments: {} })).isError,
      undefined,
    );
    assert.deepEqual(calls, [
      'https://first.example.test/base/records?value=one',
      'https://second.example.test/base/records?value=two',
    ]);
  } finally {
    await session.close();
  }
});

it('resolves credentials afresh across isolated sessions sharing one compiled registry', async () => {
  let token = 'first';
  const seen: string[] = [];
  const factory = createMultiApiServerFactory({
    name: 'multi',
    version: '1',
    apis: [api('first')],
    getOptions: () => ({
      bearerToken: token,
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers).get('authorization')!);
        return new Response('{}');
      },
    }),
  });
  const first = await connect(factory),
    second = await connect(factory);
  try {
    await first.client.callTool({
      name: 'first-list-records',
      arguments: { request: { value: 'a' } },
    });
    token = 'second';
    await second.client.callTool({
      name: 'first-list-records',
      arguments: { request: { value: 'b' } },
    });
    token = 'refreshed';
    await first.client.callTool({
      name: 'first-list-records',
      arguments: { request: { value: 'c' } },
    });
    assert.deepEqual(seen, ['Bearer first', 'Bearer second', 'Bearer refreshed']);
  } finally {
    await first.close();
    await second.close();
  }
});

it('rejects invalid destinations, namespaces, empty catalogs, and overlong tool names at startup', () => {
  const create = (apis: ApiDefinition[]) =>
    createMultiApiServerFactory({ name: 'multi', version: '1', apis });
  assert.throws(() => create([]), /At least one API/);
  assert.throws(() => create([api('first'), api('first')]), /namespace/);
  assert.throws(() => create([api('bad_name')]), /namespace/);
  for (const serverUrl of [
    'file:///tmp/api',
    'https://user:pass@example.test',
    'https://example.test/?secret=key',
    'https://example.test/#fragment',
  ]) {
    assert.throws(() => create([{ ...api('first'), serverUrl }]), /Invalid API server/);
  }
  assert.throws(() => create([api('a'.repeat(60))]), /namespaced tool/);
});

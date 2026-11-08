import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOwnedServer } from '../src/server.js';
import type { AuthToolContext } from '../src/auth/types.js';
const source = {
  openapi: '3.0.3',
  servers: [{ url: 'https://example.test' }],
  paths: {
    '/users': {
      get: {
        operationId: 'lookup',
        summary: 'Lookup',
        description: 'Lookup users.',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } }],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};
for (const mode of ['static', 'dynamic'] as const)
  test(`${mode}: authorizes actual normalized call and composite subcalls before upstream`, async () => {
    const seen: AuthToolContext[] = [];
    let calls = 0;
    let allow = true;
    let authenticated = true;
    const apiOptions = {
      bearerToken: 'human',
      fetch: async () => {
        calls++;
        return new Response('{}');
      },
    };
    const server = createOwnedServer({
      name: 'gate',
      version: '1',
      source,
      overlay: { version: 1, operations: [], schemas: [] },
      mode,
      authAdapter: {
        async authenticate() {
          return authenticated
            ? { ok: true, apiOptions }
            : { ok: false, status: 401, message: 'Missing' };
        },
        async authorizeTool(ctx) {
          seen.push(ctx);
          return allow && ctx.tool.name !== 'lookup'
            ? { ok: true, apiOptions }
            : { ok: false, status: 403, message: 'Denied' };
        },
      },
      composites: [
        {
          name: 'composite',
          title: 'Composite',
          description: 'Composite',
          input: z.object({}),
          async run(_input, { callTool }) {
            return await callTool('lookup', { request: {} });
          },
        },
      ],
    });
    const client = new Client({ name: 'test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const invoke = (name: string, args: Record<string, unknown>) =>
      client.callTool(
        mode === 'static'
          ? { name, arguments: args }
          : { name: 'execute_tool', arguments: { name, arguments: args } },
      );
    try {
      const denied = await invoke('lookup', { request: {} });
      assert.equal(denied.isError, true);
      assert.equal(calls, 0);
      assert.equal(seen[0]?.tool.method, 'get');
      assert.equal(seen[0]?.tool.path, '/users');
      assert.deepEqual(seen[0]?.input, { request: { limit: 10 } });
      seen.length = 0;
      await invoke('composite', {});
      assert.deepEqual(
        seen.map((c) => c.tool.name),
        ['composite', 'lookup'],
      );
      assert.equal(calls, 0);
      authenticated = false;
      seen.length = 0;
      assert.equal((await invoke('lookup', { request: {} })).isError, true);
      assert.equal(seen.length, 0);
      authenticated = true;
      allow = false;
      seen.length = 0;
      await invoke('composite', {});
      assert.deepEqual(
        seen.map((c) => c.tool.name),
        ['composite'],
      );
      assert.equal(calls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

for (const mode of ['static', 'dynamic'] as const)
  test(`${mode}: uses per-call authorization credentials for operations and composite subcalls`, async () => {
    const seen: AuthToolContext[] = [];
    const requests: { url: string; authorization: string | null }[] = [];
    const server = createOwnedServer({
      name: 'gate',
      version: '1',
      source,
      overlay: { version: 1, operations: [], schemas: [] },
      mode,
      authAdapter: {
        async authenticate() {
          return { ok: true, apiOptions: { bearerToken: 'authentication-only' } };
        },
        async authorizeTool(context) {
          seen.push(context);
          return {
            ok: true,
            apiOptions: {
              bearerToken: `authorized-${context.tool.name}-${seen.length}`,
              fetch: async (url, init) => {
                requests.push({
                  url: String(url),
                  authorization: new Headers(init?.headers).get('authorization'),
                });
                return new Response('{"users":["alice"]}');
              },
            },
          };
        },
      },
      composites: [
        {
          name: 'composite',
          description: 'Lookup users twice.',
          input: z.object({}),
          async run(_input, { callTool }) {
            const first = await callTool('lookup', { request: {} });
            if (first.isError) return first;
            return callTool('lookup', { request: { limit: 5 } });
          },
        },
      ],
    });
    const client = new Client({ name: 'test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const invoke = (name: string, args: Record<string, unknown>) =>
      client.callTool(
        mode === 'static'
          ? { name, arguments: args }
          : { name: 'execute_tool', arguments: { name, arguments: args } },
      );
    try {
      for (const [name, args] of [
        ['lookup', { request: {} }],
        ['composite', {}],
      ] as const) {
        const result = await invoke(name, args);
        assert.notEqual(result.isError, true);
        assert.deepEqual(result.content, [{ type: 'text', text: '{"users":["alice"]}' }]);
      }
      assert.deepEqual(
        seen.map((context) => context.tool.name),
        ['lookup', 'composite', 'lookup', 'lookup'],
      );
      assert.deepEqual(
        seen.map((context) => context.input),
        [{ request: { limit: 10 } }, {}, { request: { limit: 10 } }, { request: { limit: 5 } }],
      );
      assert.deepEqual(requests, [
        { url: 'https://example.test/users?limit=10', authorization: 'Bearer authorized-lookup-1' },
        { url: 'https://example.test/users?limit=10', authorization: 'Bearer authorized-lookup-3' },
        { url: 'https://example.test/users?limit=5', authorization: 'Bearer authorized-lookup-4' },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

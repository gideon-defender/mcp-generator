import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it } from 'node:test';
import type { ApiOptions } from '../src/client.js';
import { createOwnedServer, type AnnotationFilter } from '../src/server.js';

const SOURCE = {
  openapi: '3.0.3',
  servers: [{ url: 'https://api.example.test' }],
  paths: {
    '/widgets': {
      get: {
        operationId: 'widgetsController_list_v1',
        summary: 'List',
        description: 'List widgets.',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'widgetsController_create_v1',
        summary: 'Create',
        description: 'Create a widget.',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};
const OVERLAY = { version: 1, schemas: [], operations: [] };

async function connected({
  mode,
  allowedTools,
  annotationFilter,
  getOptions = () => ({ apiKey: 'test-key', fetch: async () => new Response('{"ok":true}') }),
}: {
  mode?: 'static' | 'dynamic';
  allowedTools?: ReadonlySet<string>;
  annotationFilter?: AnnotationFilter;
  getOptions?: () => ApiOptions;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createOwnedServer({
    name: 'test-server',
    version: '0.0.1',
    source: SOURCE,
    overlay: OVERLAY,
    ...(mode ? { mode } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(annotationFilter ? { annotationFilter } : {}),
    getOptions,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content[0];
  assert.equal(block?.type, 'text');
  return block.text ?? '';
}

describe('createOwnedServer: static mode', () => {
  it('registers one real tool per operation', async () => {
    const { client, close } = await connected({});
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ['create', 'list']);
    } finally {
      await close();
    }
  });

  it('executes a registered tool through to the mocked HTTP call', async () => {
    const { client, close } = await connected({});
    try {
      const result = await client.callTool({ name: 'list', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.equal(text(result), '{"ok":true}');
    } finally {
      await close();
    }
  });

  it('restricts the registry to the allowed tool names', async () => {
    const { client, close } = await connected({ allowedTools: new Set(['list']) });
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['list'],
      );
    } finally {
      await close();
    }
  });

  it('restricts the registry by annotation, e.g. read-only tools only', async () => {
    const { client, close } = await connected({ annotationFilter: { readOnlyHint: true } });
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['list'],
      );
    } finally {
      await close();
    }
  });

  it('reports a credential/configuration failure without throwing', async () => {
    const { client, close } = await connected({
      getOptions: () => {
        throw new Error('no credentials configured');
      },
    });
    try {
      const result = await client.callTool({ name: 'list', arguments: {} });
      assert.deepEqual(result, {
        isError: true,
        content: [{ type: 'text', text: 'API credential configuration failed.' }],
      });
    } finally {
      await close();
    }
  });
});

describe('createOwnedServer: dynamic mode', () => {
  it('exposes exactly the three discovery tools, not the operations themselves', async () => {
    const { client, close } = await connected({ mode: 'dynamic' });
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'describe_tool_input',
        'execute_tool',
        'list_tools',
      ]);
    } finally {
      await close();
    }
  });

  it('list_tools returns every tool, optionally filtered by a search term', async () => {
    const { client, close } = await connected({ mode: 'dynamic' });
    try {
      const all = JSON.parse(text(await client.callTool({ name: 'list_tools', arguments: {} })));
      assert.deepEqual(all.map((tool: { name: string }) => tool.name).sort(), ['create', 'list']);
      const filtered = JSON.parse(
        text(
          await client.callTool({
            name: 'list_tools',
            arguments: { search_terms: ['create'] },
          }),
        ),
      );
      assert.deepEqual(
        filtered.map((tool: { name: string }) => tool.name),
        ['create'],
      );
    } finally {
      await close();
    }
  });

  it('describe_tool_input reports unknown names without failing the whole call', async () => {
    const { client, close } = await connected({ mode: 'dynamic' });
    try {
      const result = text(
        await client.callTool({
          name: 'describe_tool_input',
          arguments: { tool_names: ['list', 'ghost'] },
        }),
      );
      assert.match(result, /<input_schema tool="list">/);
      assert.match(result, /Unknown tools: ghost/);
    } finally {
      await close();
    }
  });

  it('execute_tool runs a tool by name and surfaces an unknown tool as a soft error', async () => {
    const { client, close } = await connected({ mode: 'dynamic' });
    try {
      const ok = await client.callTool({ name: 'execute_tool', arguments: { name: 'list' } });
      assert.equal(ok.isError, undefined);
      assert.equal(text(ok), '{"ok":true}');

      const unknown = await client.callTool({
        name: 'execute_tool',
        arguments: { name: 'ghost' },
      });
      assert.equal(unknown.isError, true);
      assert.equal(text(unknown), 'Unknown tool: ghost');
    } finally {
      await close();
    }
  });
});

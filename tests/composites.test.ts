import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { createOwnedServer, type AnnotationFilter } from '../src/server.js';
import { parseToolJsonResult, type CompositeToolDefinition } from '../src/index.js';
import { buildFromConfig } from '../src/build/generate.js';
import { MAX_COMPOSITE_MODULE_BYTES } from '../src/composite.js';
import { GENERATOR_PACKAGE, installStubs, text } from './helpers.js';
import type { McpProjectConfig } from '../src/config/schema.js';

const SOURCE = {
  openapi: '3.0.3',
  servers: [{ url: 'https://api.example.test' }],
  paths: {
    '/users': {
      get: {
        operationId: 'usersController_list_v1',
        summary: 'List users',
        description: 'List users.',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'usersController_create_v1',
        summary: 'Create user',
        description: 'Create a user.',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/users/{userId}': {
      get: {
        operationId: 'usersController_get_v1',
        summary: 'Get user',
        description: 'Get a user.',
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/users/{userId}/security': {
      get: {
        operationId: 'usersController_security_v1',
        summary: 'Security review',
        description: 'Review user security.',
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

const OVERLAY = {
  version: 1,
  schemas: [],
  operations: [
    { path: '/users', method: 'get', metadata: { name: 'list-users' } },
    { path: '/users/{userId}', method: 'get', metadata: { name: 'get-user' } },
    {
      path: '/users/{userId}/security',
      method: 'get',
      metadata: { name: 'get-security-review' },
    },
    { path: '/users', method: 'post', metadata: { name: 'create-user' } },
  ],
} as const;

const reviewUser: CompositeToolDefinition = {
  name: 'review-user',
  description: 'Review a user and their security posture.',
  title: 'Review user',
  input: z.object({ userId: z.string().min(1) }),
  async run({ userId }, { callTool }) {
    const user = parseToolJsonResult(await callTool('get-user', { request: { userId } }));
    const security = parseToolJsonResult(
      await callTool('get-security-review', { request: { userId } }),
    );
    return { user, security };
  },
};

type ConnectOptions = {
  allowedTools?: ReadonlySet<string>;
  annotationFilter?: AnnotationFilter;
  composites?: readonly CompositeToolDefinition[];
  mode?: 'static' | 'dynamic';
  fetch?: typeof globalThis.fetch;
};

async function connect({
  allowedTools,
  annotationFilter,
  composites,
  mode,
  fetch,
}: ConnectOptions = {}) {
  const calls: Array<{ url: string; method: string; signal: AbortSignal | null }> = [];
  const defaultFetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', signal: init?.signal ?? null });
    const headers = { 'content-type': 'application/json' } as const;
    if (url.endsWith('/security'))
      return new Response('{"state":"compliant"}', { status: 200, headers });
    if (/\/users\/[^/]+$/.test(url))
      return new Response('{"name":"Ada"}', { status: 200, headers });
    return new Response('[]', { status: 200, headers });
  };
  // A caller-supplied fetch still records calls, so smoke tests can probe signals.
  const rawFetch = fetch ?? defaultFetch;
  const recordingFetch: typeof globalThis.fetch = async (input, init) => {
    if (fetch)
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        signal: init?.signal ?? null,
      });
    return rawFetch(input, init);
  };
  const server = createOwnedServer({
    name: 'test-server',
    version: '0.0.1',
    source: SOURCE,
    overlay: OVERLAY,
    transport: 'stdio',
    getOptions: () => ({ apiKey: 'test-key', fetch: recordingFetch }),
    ...(allowedTools ? { allowedTools } : {}),
    ...(annotationFilter ? { annotationFilter } : {}),
    ...(composites ? { composites } : {}),
    ...(mode ? { mode } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    calls,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('composite tools (read-only)', () => {
  it('registers and executes a composite as a normal read-only tool', async () => {
    const { client, calls, close } = await connect({ composites: [reviewUser] });
    try {
      const { tools } = await client.listTools();
      const review = tools.find((tool) => tool.name === 'review-user');
      assert.ok(review);
      assert.equal(review.annotations?.readOnlyHint, true);
      assert.equal(review.annotations?.destructiveHint, false);
      const result = await client.callTool({
        name: 'review-user',
        arguments: { userId: 'ada' },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(text(result)), {
        user: { name: 'Ada' },
        security: { state: 'compliant' },
      });
      assert.deepEqual(
        calls.map(({ url }) => url),
        ['https://api.example.test/users/ada', 'https://api.example.test/users/ada/security'],
      );
    } finally {
      await close();
    }
  });

  it('lets a composite return its own MCP error result instead of throwing it', async () => {
    const failing: CompositeToolDefinition = {
      name: 'direct-result',
      description: 'Returns an error result directly.',
      input: z.object({}),
      async run() {
        return { isError: true, content: [{ type: 'text', text: 'Caller-facing failure.' }] };
      },
    };
    const { client, close } = await connect({ composites: [failing] });
    try {
      const result = await client.callTool({ name: 'direct-result', arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(text(result), 'Caller-facing failure.');
    } finally {
      await close();
    }
  });

  it('converts a composite that throws into a generic error without leaking internals', async () => {
    const throwing: CompositeToolDefinition = {
      name: 'throwing-composite',
      description: 'Throws an internal error.',
      input: z.object({}),
      async run() {
        throw new Error('secret internal detail');
      },
    };
    const { client, close } = await connect({ composites: [throwing] });
    try {
      const result = await client.callTool({ name: 'throwing-composite', arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(text(result), 'Composite tool throwing-composite failed.');
      assert.doesNotMatch(text(result), /secret internal detail/);
    } finally {
      await close();
    }
  });

  it('rejects invalid composite input before running it', async () => {
    const { client, calls, close } = await connect({ composites: [reviewUser] });
    try {
      const result = await client.callTool({
        name: 'review-user',
        arguments: { userId: '' },
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /Input validation error|Too small/);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });

  it('cannot call a mutating operation even when the composite itself is read-only', async () => {
    const mutating: CompositeToolDefinition = {
      name: 'touch-user',
      description: 'Attempts a mutating subcall.',
      input: z.object({}),
      async run(_input, { callTool }) {
        return callTool('create-user', { name: 'Ada' });
      },
    };
    const { client, close } = await connect({ composites: [mutating] });
    try {
      const result = await client.callTool({ name: 'touch-user', arguments: {} });
      assert.equal(result.isError, true);
      assert.match(text(result), /not available to read-only composite tools/);
    } finally {
      await close();
    }
  });

  it('cannot call an operation hidden by the configured allowlist', async () => {
    const { client, close } = await connect({
      composites: [reviewUser],
      allowedTools: new Set(['review-user', 'get-security-review']),
    });
    try {
      const result = await client.callTool({
        name: 'review-user',
        arguments: { userId: 'ada' },
      });
      assert.equal(result.isError, true);
      assert.equal(text(result), 'Composite tool review-user failed.');
    } finally {
      await close();
    }
  });

  it('stops a composite after 25 subcalls', async () => {
    const fanOut: CompositeToolDefinition = {
      name: 'fan-out',
      description: 'Calls one operation until the budget runs out.',
      input: z.object({}),
      async run(_input, { callTool }) {
        const results = [];
        for (let call = 0; call < 26; call++)
          results.push(await callTool('get-user', { request: { userId: 'ada' } }));
        return {
          ok: results.filter((result) => !result.isError).length,
          last: text(results[25]),
          lastIsError: results[25]?.isError === true,
        };
      },
    };
    const { client, calls, close } = await connect({ composites: [fanOut] });
    try {
      const result = await client.callTool({ name: 'fan-out', arguments: {} });
      assert.deepEqual(JSON.parse(text(result)), {
        ok: 25,
        last: 'Composite exceeded the subcall limit.',
        lastIsError: true,
      });
      assert.equal(calls.length, 25);
      // The budget is per request: a second request starts from zero.
      const again = await client.callTool({ name: 'fan-out', arguments: {} });
      assert.equal(JSON.parse(text(again)).ok, 25);
      assert.equal(calls.length, 50);
    } finally {
      await close();
    }
  });

  it('applies input transforms exactly once in static and dynamic mode', async () => {
    const seen: unknown[] = [];
    const transforming: CompositeToolDefinition = {
      name: 'echo-once',
      description: 'Records the arguments it receives.',
      input: z.object({ value: z.string().transform((value) => `${value}!`) }),
      async run(args) {
        seen.push(args);
        return args;
      },
    };
    for (const mode of ['static', 'dynamic'] as const) {
      seen.length = 0;
      const { client, close } = await connect({ composites: [transforming], mode });
      try {
        const result =
          mode === 'static'
            ? await client.callTool({ name: 'echo-once', arguments: { value: 'x' } })
            : await client.callTool({
                name: 'execute_tool',
                arguments: { name: 'echo-once', arguments: { value: 'x' } },
              });
        assert.equal(result.isError, undefined, mode);
        assert.deepEqual(seen, [{ value: 'x!' }], mode);
      } finally {
        await close();
      }
    }
  });

  it('rejects duplicate names, operation collisions and reserved names at startup', async () => {
    for (const [name, message] of [
      ['get-user', /collides with an operation tool/],
      // Reserved names are rejected as reserved before the kebab-case check.
      ['execute_tool', /reserved/],
    ] as const) {
      assert.throws(
        () =>
          createOwnedServer({
            name: 'test-server',
            version: '0.0.1',
            source: SOURCE,
            overlay: OVERLAY,
            getOptions: () => ({ apiKey: 'test-key' }),
            composites: [{ ...reviewUser, name }],
          }),
        message,
      );
    }
    assert.throws(
      () =>
        createOwnedServer({
          name: 'test-server',
          version: '0.0.1',
          source: SOURCE,
          overlay: OVERLAY,
          getOptions: () => ({ apiKey: 'test-key' }),
          composites: [reviewUser, { ...reviewUser }],
        }),
      /Duplicate composite tool name/,
    );
  });

  it('rejects governed write composites until that phase is approved', async () => {
    // A type annotation would normally catch this; keep the guard for JavaScript modules.
    const guarded = {
      ...reviewUser,
      classification: 'mutate' as never,
    };
    assert.throws(
      () =>
        createOwnedServer({
          name: 'test-server',
          version: '0.0.1',
          source: SOURCE,
          overlay: OVERLAY,
          getOptions: () => ({ apiKey: 'test-key' }),
          composites: [guarded],
        }),
      /governed writes deferred/,
    );
  });

  it('exposes composites through dynamic discovery and execute_tool', async () => {
    const { client, calls, close } = await connect({ composites: [reviewUser], mode: 'dynamic' });
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'describe_tool_input',
        'execute_tool',
        'list_tools',
      ]);
      const result = await client.callTool({
        name: 'execute_tool',
        arguments: { name: 'review-user', arguments: { userId: 'ada' } },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(text(result)), {
        user: { name: 'Ada' },
        security: { state: 'compliant' },
      });
      assert.equal(calls.length, 2);
    } finally {
      await close();
    }
  });
});

const minimalSpecText = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Get health',
        description: 'Health check',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});
const emptyOverlay = 'version: 1\nschemas: []\noperations: []\n';
const compositesModuleText = `import { z } from 'zod';
import { jsonResult } from '@gideon/mcp-generator';

export const composites = [
  {
    name: 'health-summary',
    description: 'Return a health summary for the service.',
    title: 'Health summary',
    input: z.object({}),
    async run() {
      return jsonResult({ status: 'ok', source: 'health-summary' });
    },
  },
];
`;
async function projectWithComposite(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-composite-build-'));
  await writeFile(join(dir, 'openapi.json'), minimalSpecText);
  await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
  await writeFile(join(dir, 'product-composites.mjs'), compositesModuleText);
  return dir;
}

async function installCompositeStubs(out: string): Promise<void> {
  await installStubs({ out, withZod: true });
}

function buildConfig(composites?: string): McpProjectConfig {
  return {
    identity: { name: 'test', version: '1.2.3' },
    spec: { path: './openapi.json' },
    overlay: './mcp-overlay.yaml',
    output: { dir: 'out' },
    ...(composites ? { composites: { module: composites } } : {}),
  };
}

describe('buildFromConfig with composites', () => {
  it('copies the module into the artifact and starts with the composite tool registered', async () => {
    const dir = await projectWithComposite();
    const config: McpProjectConfig = {
      identity: { name: 'test', version: '1.2.3' },
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'out' },
      composites: { module: './product-composites.mjs' },
    };
    await buildFromConfig(config, dir);
    const out = join(dir, 'out');
    const artifact = JSON.parse(await readFile(join(out, 'artifact.json'), 'utf8'));
    const copied = await readFile(join(out, 'composites.mjs'));
    assert.deepEqual(artifact.composites, {
      module: 'composites.mjs',
      sha256: createHash('sha256').update(copied).digest('hex'),
    });
    const revision = JSON.parse(await readFile(join(out, 'contract-revision.json'), 'utf8'));
    assert.deepEqual(revision.composites, artifact.composites);
    const packageJson = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    const generatorPackage = JSON.parse(await readFile(GENERATOR_PACKAGE, 'utf8'));
    assert.equal(
      packageJson.dependencies['zod'],
      generatorPackage.dependencies['zod'].replace(/^[~^]/, ''),
    );
    const entrypoint = await readFile(join(out, 'server.mjs'), 'utf8');
    assert.match(entrypoint, /import \{ composites \} from '\.\/composites\.mjs'/);
    assert.match(entrypoint, /composites,/);

    await installCompositeStubs(out);
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', import.meta.resolve('tsx'), 'server.mjs'],
          cwd: out,
          env: { PATH: process.env['PATH'] ?? '', MCP_GENERATOR_APIKEY: 'test-key' },
        }),
      );
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === 'health-summary'));
      const result = await client.callTool({ name: 'health-summary', arguments: {} });
      assert.deepEqual(JSON.parse(text(result)), { status: 'ok', source: 'health-summary' });
    } finally {
      await client.close();
    }
  });

  it('rejects an invalid composites.module before writing anything', async () => {
    const dir = await projectWithComposite();
    await symlink(join(dir, 'product-composites.mjs'), join(dir, 'linked.mjs'));
    await writeFile(join(dir, 'composites.txt'), compositesModuleText);
    const oversized = await open(join(dir, 'oversized.mjs'), 'w');
    await oversized.truncate(MAX_COMPOSITE_MODULE_BYTES + 1);
    await oversized.close();
    for (const [module, message] of [
      ['./missing.mjs', /composites\.module does not exist/],
      ['./linked.mjs', /composites\.module must be a real file/],
      ['./.', /composites\.module must be a real file/],
      ['./composites.txt', /must be a compiled \.js or \.mjs file/],
      ['./oversized.mjs', /the limit is \d+ bytes/],
      ['../outside.mjs', /composites\.module must be within the working directory/],
    ] as const) {
      await assert.rejects(buildFromConfig(buildConfig(module), dir), message, module);
    }
    await assert.rejects(stat(join(dir, 'out')));
  });

  it('refuses to write through a symlink planted at an artifact path', async () => {
    const dir = await projectWithComposite();
    await buildFromConfig(buildConfig(), dir);
    const out = join(dir, 'out');
    const sentinel = join(dir, 'sentinel.txt');
    await writeFile(sentinel, 'untouched');
    await rm(join(out, 'server.mjs'));
    await symlink(sentinel, join(out, 'server.mjs'));
    await assert.rejects(buildFromConfig(buildConfig(), dir), /Output path is a symlink/);
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  });

  it('does not include composites dependencies when no module is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-no-composites-'));
    await writeFile(join(dir, 'openapi.json'), minimalSpecText);
    await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
    await buildFromConfig(
      {
        identity: { name: 'test', version: '1.2.3' },
        spec: { path: './openapi.json' },
        overlay: './mcp-overlay.yaml',
        output: { dir: 'out' },
      },
      dir,
    );
    const out = join(dir, 'out');
    const packageJson = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    assert.equal(packageJson.dependencies['zod'], undefined);
    assert.equal(packageJson.dependencies['@gideon/mcp-generator'], '0.1.0');
    await assert.rejects(readFile(join(out, 'composites.mjs')));
    const entrypoint = await readFile(join(out, 'server.mjs'), 'utf8');
    assert.doesNotMatch(entrypoint, /import \{ composites \}/);
  });
});

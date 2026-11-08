import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MAX_COMPOSITE_MODULE_BYTES } from '../src/composite.js';

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(repoRoot, 'src/cli.ts');

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : -1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

async function writeSpec(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-start-'));
  const specPath = join(dir, 'spec.json');
  await writeFile(
    specPath,
    JSON.stringify({
      openapi: '3.0.3',
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/ping': {
          get: {
            operationId: 'ping',
            summary: 'Ping',
            description: 'Ping the API.',
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }),
  );
  return specPath;
}

describe('CLI start command: argument validation', () => {
  it('requires --spec, --name, and --version', async () => {
    const spec = await writeSpec();
    assert.equal((await runCli(['start'])).code, 2);
    assert.equal((await runCli(['start', '--spec', spec])).code, 2);
    assert.equal((await runCli(['start', '--spec', spec, '--name', 'n'])).code, 2);
  });

  it('requires exactly one of --apikey or --bearer', async () => {
    const spec = await writeSpec();
    const neither = await runCli(['start', '--spec', spec, '--name', 'n', '--version', '1']);
    assert.equal(neither.code, 2);
    assert.match(neither.stderr, /exactly one of --apikey or --bearer/);
    const both = await runCli([
      'start',
      '--spec',
      spec,
      '--name',
      'n',
      '--version',
      '1',
      '--apikey',
      'a',
      '--bearer',
      'b',
    ]);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /exactly one of --apikey or --bearer/);
  });

  it('rejects an invalid --mode', async () => {
    const spec = await writeSpec();
    const result = await runCli([
      'start',
      '--spec',
      spec,
      '--name',
      'n',
      '--version',
      '1',
      '--apikey',
      'a',
      '--mode',
      'bogus',
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--mode must be "static" or "dynamic"/);
  });

  it('rejects a non-positive --timeout', async () => {
    const spec = await writeSpec();
    const result = await runCli([
      'start',
      '--spec',
      spec,
      '--name',
      'n',
      '--version',
      '1',
      '--apikey',
      'a',
      '--timeout',
      '0',
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--timeout must be a positive number/);
  });
});

describe('CLI start command: --composites', () => {
  const ZOD_URL = import.meta.resolve('zod');
  const COMPOSITES_MODULE = `import { z } from ${JSON.stringify(ZOD_URL)};
export const composites = [
  {
    name: 'hello',
    description: 'Say hello.',
    input: z.object({}),
    async run() {
      return { hello: 'world' };
    },
  },
];
`;

  function startArgs({ spec, composites }: { spec: string; composites: string }): string[] {
    return [
      'start',
      '--spec',
      spec,
      '--name',
      'test-server',
      '--version',
      '0.0.1',
      '--apikey',
      'fake-key',
      '--composites',
      composites,
    ];
  }

  it('rejects a module that is not a .js or .mjs file', async () => {
    const spec = await writeSpec();
    const result = await runCli(startArgs({ spec, composites: join(dirname(spec), 'x.ts') }));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--composites must reference a compiled \.js or \.mjs file/);
  });

  it('reports a module that cannot be loaded', async () => {
    const spec = await writeSpec();
    const dir = dirname(spec);
    await mkdir(join(dir, 'directory.mjs'));
    await writeFile(join(dir, 'broken.mjs'), 'export const composites = [');
    await writeFile(join(dir, 'no-export.mjs'), 'export const other = [];\n');
    await writeFile(join(dir, 'not-array.mjs'), 'export const composites = {};\n');
    const oversized = await open(join(dir, 'oversized.mjs'), 'w');
    await oversized.truncate(MAX_COMPOSITE_MODULE_BYTES + 1);
    await oversized.close();
    for (const [file, message] of [
      ['missing.mjs', /Composite module does not exist/],
      ['directory.mjs', /Composite module must be a regular file/],
      ['oversized.mjs', /Composite module is \d+ bytes; the limit is \d+ bytes/],
      ['broken.mjs', /Unable to import composite module/],
      ['no-export.mjs', /must export a named "composites" array/],
      ['not-array.mjs', /must export a named "composites" array/],
    ] as const) {
      const result = await runCli(startArgs({ spec, composites: join(dir, file) }));
      assert.equal(result.code, 2, file);
      assert.match(result.stderr, message, file);
    }
  });

  it('serves a composite from the module over stdio', async () => {
    const spec = await writeSpec();
    const module = join(dirname(spec), 'composites.mjs');
    await writeFile(module, COMPOSITES_MODULE);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', cli, ...startArgs({ spec, composites: module })],
      cwd: repoRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'cli-start-composites-test', version: '1' });
    try {
      await client.connect(transport, { timeout: 15_000 });
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ['hello', 'ping']);
      const result = await client.callTool({ name: 'hello', arguments: {} });
      const block = (result.content as Array<{ type: string; text?: string }>)[0];
      assert.deepEqual(JSON.parse(block?.text ?? ''), { hello: 'world' });
    } finally {
      await client.close();
      await transport.close();
    }
  });
});

describe('CLI start command: end-to-end', () => {
  for (const operatorOptions of [
    { serverUrl: 'https://operator.example.test' },
    { timeoutMs: 1000 },
  ])
    it(`preserves tool authorization with ${Object.keys(operatorOptions)[0]}`, async () => {
      const spec = await writeSpec();
      const script = `
import assert from 'node:assert/strict';
import { runStart } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'src/cli/start.ts')).href)};
let calls = 0;
const adapter = {
  async authenticate() {
    return { ok: true, apiOptions: { bearerToken: 'authentication-only', fetch: async () => {
      throw new Error('Authentication credentials must not execute calls');
    } } };
  },
  async authorizeTool(context) {
    assert.equal(this, adapter);
    assert.equal(context.tool.name, 'ping');
    calls++;
    if (calls === 1) return { ok: false, status: 403, message: 'Denied' };
    if (calls === 3) throw new Error('Authorization unavailable');
    return { ok: true, apiOptions: { bearerToken: 'authorized-call', fetch: async (url, init) => {
      assert.equal(String(url), ${JSON.stringify(`${'serverUrl' in operatorOptions ? operatorOptions.serverUrl : 'https://api.example.test'}/ping`)});
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer authorized-call');
      return new Response('{"authorized":true}');
    } } };
  },
};
await runStart({ specPath: ${JSON.stringify(spec)}, name: 'test', version: '1',
  ...${JSON.stringify(operatorOptions)}, authAdapter: adapter });
`;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', '--input-type=module', '-e', script],
        cwd: repoRoot,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'startup-authorization-test', version: '1' });
      try {
        await client.connect(transport, { timeout: 15_000 });
        assert.equal((await client.callTool({ name: 'ping', arguments: {} })).isError, true);
        const result = await client.callTool({ name: 'ping', arguments: {} });
        assert.notEqual(result.isError, true);
        assert.deepEqual(result.content, [{ type: 'text', text: '{"authorized":true}' }]);
        assert.equal((await client.callTool({ name: 'ping', arguments: {} })).isError, true);
      } finally {
        await client.close();
        await transport.close();
      }
    });

  it('serves a real MCP tool over stdio for a minimal spec', async () => {
    const spec = await writeSpec();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        cli,
        'start',
        '--spec',
        spec,
        '--name',
        'test-server',
        '--version',
        '0.0.1',
        '--apikey',
        'fake-key',
      ],
      cwd: repoRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'cli-start-test', version: '1' });
    try {
      await client.connect(transport, { timeout: 15_000 });
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['ping'],
      );
    } finally {
      await client.close();
      await transport.close();
    }
  });
});

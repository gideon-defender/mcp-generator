import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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

describe('CLI start command: end-to-end', () => {
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildFromConfig } from '../src/build/generate.js';
import type { McpProjectConfig } from '../src/config/schema.js';

const minimalSpec = JSON.stringify({
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
const OUTSIDE = /must be within the working directory/;
const GENERATOR_PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url));
const SOURCE_INDEX = new URL('../src/index.ts', import.meta.url).href;

const run = promisify(execFile);

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
  await writeFile(join(dir, 'openapi.json'), minimalSpec);
  await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
  return dir;
}

// Stand in for `npm install`: resolve the generator from source and the SDK from this repo.
async function installStubs(out: string): Promise<void> {
  const generatorStub = join(out, 'node_modules', '@gideon', 'mcp-generator');
  await mkdir(generatorStub, { recursive: true });
  await writeFile(
    join(generatorStub, 'package.json'),
    JSON.stringify({ name: '@gideon/mcp-generator', type: 'module', exports: './index.js' }),
  );
  await writeFile(
    join(generatorStub, 'index.js'),
    `export * from ${JSON.stringify(SOURCE_INDEX)};\n`,
  );
  await mkdir(join(out, 'node_modules', '@modelcontextprotocol'), { recursive: true });
  await symlink(
    fileURLToPath(new URL('../node_modules/@modelcontextprotocol/sdk', import.meta.url)),
    join(out, 'node_modules', '@modelcontextprotocol', 'sdk'),
  );
}

async function builtArtifact(): Promise<string> {
  const dir = await project();
  const cfg: McpProjectConfig = {
    identity: { name: 'test', version: '1.2.3' },
    spec: { path: './openapi.json' },
    overlay: './mcp-overlay.yaml',
    output: { dir: 'out' },
  };
  await buildFromConfig(cfg, dir);
  const out = join(dir, 'out');
  await installStubs(out);
  return out;
}

function stdioTransport(out: string, credentials: Record<string, string>) {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), 'server.mjs'],
    cwd: out,
    env: { PATH: process.env['PATH'] ?? '', ...credentials },
  });
}

describe('buildFromConfig', () => {
  it('builds from config and writes outputs', async () => {
    const dir = await project();
    const cfg: McpProjectConfig = {
      identity: { name: 'test', version: '1.2.3' },
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'out' },
    };
    const result = await buildFromConfig(cfg, dir);
    assert.equal(result.tools.length, 1);
    const toolNames = JSON.parse(await readFile(join(dir, 'out', 'tool-names.json'), 'utf8'));
    assert.deepEqual(toolNames, [
      { name: 'get-health', description: 'Get health\n\nHealth check' },
    ]);
    const rev = JSON.parse(await readFile(join(dir, 'out', 'contract-revision.json'), 'utf8'));
    assert.equal(rev.name, 'test');
    assert.equal(rev.version, '1.2.3');
    assert.equal(rev.tools, 1);
    assert.equal(rev.specSha256, createHash('sha256').update(minimalSpec).digest('hex'));
    assert.equal(rev.overlaySha256, createHash('sha256').update(emptyOverlay).digest('hex'));
    const artifact = JSON.parse(await readFile(join(dir, 'out', 'artifact.json'), 'utf8'));
    assert.equal(artifact.format, 1);
    assert.equal(artifact.name, 'test');
    assert.equal(artifact.version, '1.2.3');
    assert.equal(artifact.entrypoint, 'server.mjs');
    assert.equal(artifact.tools, 1);
    assert.equal(artifact.specSha256, rev.specSha256);
    assert.equal(artifact.overlaySha256, rev.overlaySha256);

    const packageText = await readFile(join(dir, 'out', 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageText);
    assert.equal(packageJson.name, 'test');
    assert.equal(packageJson.version, '1.2.3');
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.type, 'module');
    assert.equal(packageJson.scripts.start, 'node server.mjs');
    const generator = JSON.parse(await readFile(GENERATOR_PACKAGE, 'utf8'));
    assert.equal(packageJson.dependencies[generator.name], generator.version);
    assert.equal(
      packageJson.dependencies['@modelcontextprotocol/sdk'],
      generator.dependencies['@modelcontextprotocol/sdk'].replace(/^[~^]/, ''),
    );
    assert.equal(artifact.packageSha256, createHash('sha256').update(packageText).digest('hex'));

    const entrypoint = await readFile(join(dir, 'out', 'server.mjs'), 'utf8');
    assert.match(entrypoint, /createOwnedServer/);
    assert.match(entrypoint, /StdioServerTransport/);
    assert.match(entrypoint, /MCP_GENERATOR_APIKEY/);
    assert.match(entrypoint, /MCP_GENERATOR_BEARER_TOKEN/);
    assert.ok(entrypoint.includes('getHealth'));
    assert.ok(entrypoint.includes('Get health'));
    assert.ok(entrypoint.includes('name: "test"'));
    assert.ok(entrypoint.includes('version: "1.2.3"'));
    assert.equal(artifact.serverSha256, createHash('sha256').update(entrypoint).digest('hex'));
  });

  it('uses safe defaults for generated package identity', async () => {
    const dir = await project();
    const cfg: McpProjectConfig = {
      identity: { name: ' Test / API! ' },
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'dist' },
    };
    await buildFromConfig(cfg, dir);
    const packageJson = JSON.parse(await readFile(join(dir, 'dist', 'package.json'), 'utf8'));
    assert.equal(packageJson.name, 'test-api');
    assert.equal(packageJson.version, '0.0.0');
    const artifact = JSON.parse(await readFile(join(dir, 'dist', 'artifact.json'), 'utf8'));
    assert.equal(artifact.name, ' Test / API! ');
    assert.equal(artifact.version, '0.0.0');
  });

  it('strips leading dots and underscores from the generated package name', async () => {
    const dir = await project();
    const cfg: McpProjectConfig = {
      identity: { name: '_.internal api' },
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'out' },
    };
    await buildFromConfig(cfg, dir);
    const packageJson = JSON.parse(await readFile(join(dir, 'out', 'package.json'), 'utf8'));
    assert.equal(packageJson.name, 'internal-api');
  });

  it('uses output.generatorDependency for the generator dependency', async () => {
    const dir = await project();
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'out', generatorDependency: 'file:../gen.tgz' },
    };
    await buildFromConfig(cfg, dir);
    const packageJson = JSON.parse(await readFile(join(dir, 'out', 'package.json'), 'utf8'));
    assert.equal(packageJson.dependencies['@gideon/mcp-generator'], 'file:../gen.tgz');
  });

  for (const credentials of [
    { MCP_GENERATOR_APIKEY: 'test-key' },
    { MCP_GENERATOR_BEARER_TOKEN: 'test-token' },
  ]) {
    it(`generates a server that starts and lists tools over stdio with ${Object.keys(credentials)[0]}`, async () => {
      const out = await builtArtifact();
      const client = new Client({ name: 'smoke', version: '0.0.0' });
      try {
        await client.connect(stdioTransport(out, credentials));
        const { tools } = await client.listTools();
        assert.ok(tools.some((tool) => tool.name === 'get-health'));
      } finally {
        await client.close();
      }
    });
  }

  for (const [label, credentials] of [
    ['no credential', {}],
    ['both credentials', { MCP_GENERATOR_APIKEY: 'k', MCP_GENERATOR_BEARER_TOKEN: 't' }],
  ] as const) {
    it(`generated server exits when given ${label}`, async () => {
      const out = await builtArtifact();
      await assert.rejects(
        run(process.execPath, ['--import', import.meta.resolve('tsx'), 'server.mjs'], {
          cwd: out,
          env: { PATH: process.env['PATH'] ?? '', ...credentials },
        }),
        (err: { stderr?: string }) =>
          /Provide exactly one of MCP_GENERATOR_APIKEY or MCP_GENERATOR_BEARER_TOKEN/.test(
            err.stderr ?? '',
          ),
      );
    });
  }

  it('rejects output dir equal to cwd and keeps the project package.json', async () => {
    const dir = await project();
    await writeFile(join(dir, 'package.json'), '{"name":"mine"}');
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: '.' },
    };
    await assert.rejects(buildFromConfig(cfg, dir), { message: /must be a subdirectory/ });
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), '{"name":"mine"}');
  });

  it('rejects a valid spec outside cwd', async () => {
    const dir = await project();
    const outside = await project();
    const cfg: McpProjectConfig = {
      spec: { path: join(outside, 'openapi.json') },
      overlay: './mcp-overlay.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), { message: /^spec\.path must be within/ });
  });

  it('rejects a valid overlay outside cwd', async () => {
    const dir = await project();
    const outside = await project();
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: join(outside, 'mcp-overlay.yaml'),
    };
    await assert.rejects(buildFromConfig(cfg, dir), { message: /^overlay must be within/ });
  });

  it('rejects output dir outside cwd and writes nothing', async () => {
    const dir = await project();
    const outside = await mkdtemp(join(tmpdir(), 'mcp-outside-'));
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: outside },
    };
    await assert.rejects(buildFromConfig(cfg, dir), OUTSIDE);
    await assert.rejects(readFile(join(outside, 'tool-names.json')), { code: 'ENOENT' });
  });

  it('reads a yaml spec', async () => {
    const dir = await project();
    await writeFile(
      join(dir, 'openapi.yaml'),
      'openapi: "3.0.0"\ninfo:\n  title: Test\n  version: "1.0.0"\npaths:\n  /ping:\n    get:\n      operationId: ping\n      summary: Ping\n      description: Ping service\n      responses:\n        "200":\n          description: ok\n',
    );
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.yaml' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'dist' },
    };
    const result = await buildFromConfig(cfg, dir);
    assert.deepEqual(
      result.toolNames.map(({ name }) => name),
      ['ping'],
    );
  });

  it('rejects a spec file that cannot be read', async () => {
    const dir = await project();
    const cfg: McpProjectConfig = {
      spec: { path: './missing.json' },
      overlay: './mcp-overlay.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), {
      message: /Failed to read spec from \.\/missing\.json/,
    });
  });

  it('rejects an overlay file that cannot be read', async () => {
    const dir = await project();
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './missing.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), {
      message: /Failed to read overlay from \.\/missing\.yaml/,
    });
  });

  it('names the spec when it cannot be parsed', async () => {
    const dir = await project();
    await writeFile(join(dir, 'openapi.json'), '{ "openapi": ');
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), {
      message: /Failed to parse spec \.\/openapi\.json/,
    });
  });

  it('rejects a spec that fails to compile', async () => {
    const dir = await project();
    await writeFile(join(dir, 'openapi.json'), '{}');
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), {
      message: /Failed to compile tools/,
    });
  });
});

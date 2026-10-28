import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
  await writeFile(join(dir, 'openapi.json'), minimalSpec);
  await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
  return dir;
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
    assert.match(rev.specSha256, /^[0-9a-f]{64}$/);
    assert.match(rev.overlaySha256, /^[0-9a-f]{64}$/);
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

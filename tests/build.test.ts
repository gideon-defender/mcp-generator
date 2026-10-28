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

describe('buildFromConfig', () => {
  it('builds from config and writes outputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(join(dir, 'openapi.json'), minimalSpec);
    await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
    const cfg: McpProjectConfig = {
      identity: { name: 'test', version: '1.2.3' },
      spec: { path: './openapi.json', format: 'json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'out' },
    };
    const result = await buildFromConfig(cfg, dir);
    assert.equal(result.tools.length >= 1, true);
    const toolNames = JSON.parse(await readFile(join(dir, 'out', 'tool-names.json'), 'utf8'));
    assert.equal(Array.isArray(toolNames), true);
    const rev = JSON.parse(await readFile(join(dir, 'out', 'contract-revision.json'), 'utf8'));
    assert.equal(rev.version, '1.2.3');
    assert.equal(typeof rev.specSha256, 'string');
    assert.equal(rev.specSha256.length, 64);
  });

  it('rejects spec outside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
    const cfg: McpProjectConfig = {
      spec: { path: '/etc/passwd' },
      overlay: './mcp-overlay.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir));
  });

  it('rejects overlay outside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(join(dir, 'openapi.json'), minimalSpec);
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: '/etc/hosts',
    };
    await assert.rejects(buildFromConfig(cfg, dir));
  });

  it('rejects output dir outside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(join(dir, 'openapi.json'), minimalSpec);
    await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
      output: { dir: '../../etc' },
    };
    await assert.rejects(buildFromConfig(cfg, dir));
  });

  it('auto-detects yaml spec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(
      join(dir, 'openapi.yaml'),
      'openapi: "3.0.0"\ninfo:\n  title: Test\n  version: "1.0.0"\npaths:\n  /ping:\n    get:\n      operationId: ping\n      summary: Ping\n      description: Ping service\n      responses:\n        "200":\n          description: ok\n',
    );
    await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.yaml' },
      overlay: './mcp-overlay.yaml',
      output: { dir: 'dist' },
    };
    const result = await buildFromConfig(cfg, dir);
    assert.equal(result.tools.length >= 1, true);
  });

  it('rejects a spec file that cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
    const cfg: McpProjectConfig = {
      spec: { path: './missing.json' },
      overlay: './mcp-overlay.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), {
      message: /Failed to read spec from \.\/missing\.json/,
    });
  });

  it('rejects an overlay file that cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(join(dir, 'openapi.json'), minimalSpec);
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './missing.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), {
      message: /Failed to read overlay from \.\/missing\.yaml/,
    });
  });

  it('rejects a spec that fails to compile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-build-'));
    await writeFile(join(dir, 'openapi.json'), '{}');
    await writeFile(join(dir, 'mcp-overlay.yaml'), emptyOverlay);
    const cfg: McpProjectConfig = {
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
    };
    await assert.rejects(buildFromConfig(cfg, dir), {
      message: /Failed to compile tools/,
    });
  });
});

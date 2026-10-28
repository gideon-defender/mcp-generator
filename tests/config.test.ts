import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfigPath } from '../src/config/loader.js';
import { McpProjectConfigSchema } from '../src/config/schema.js';

describe('config schema', () => {
  it('accepts minimal valid config', () => {
    const cfg = McpProjectConfigSchema.parse({
      spec: { path: './openapi.json' },
      overlay: './mcp-overlay.yaml',
    });
    assert.equal(cfg.spec.path, './openapi.json');
    assert.equal(cfg.overlay, './mcp-overlay.yaml');
  });

  it('accepts full config', () => {
    const cfg = McpProjectConfigSchema.parse({
      identity: { name: 'example', displayName: 'Example', version: '1.0.0' },
      spec: { path: './openapi.yaml', format: 'yaml' },
      overlay: './overlay.yaml',
      upstreams: { api: { baseUrlEnv: 'API_BASE_URL' } },
      auth: { adapter: 'jwt', audience: 'test' },
      tools: { mode: 'static' },
      output: { dir: 'dist', bin: 'server' },
    });
    assert.equal(cfg.identity?.name, 'example');
  });

  it('rejects unknown fields', () => {
    assert.throws(() =>
      McpProjectConfigSchema.parse({
        spec: { path: './openapi.json' },
        overlay: './mcp-overlay.yaml',
        extra: true,
      }),
    );
  });

  it('rejects invalid spec format', () => {
    assert.throws(() =>
      McpProjectConfigSchema.parse({
        spec: { path: './openapi.json', format: 'xml' },
        overlay: './mcp-overlay.yaml',
      }),
    );
  });
});

describe('config loader', () => {
  it('resolveConfigPath returns mcp.config.json in cwd', () => {
    const p = resolveConfigPath('/tmp/foo');
    assert.equal(p, '/tmp/foo/mcp.config.json');
  });

  it('loads json config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const cfgPath = join(dir, 'mcp.config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        identity: { name: 'test' },
        spec: { path: './openapi.json' },
        overlay: './overlay.yaml',
      }),
    );
    const cfg = await loadConfig(cfgPath, dir);
    assert.equal(cfg.identity?.name, 'test');
  });

  it('loads yaml config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const cfgPath = join(dir, 'mcp.config.yaml');
    await writeFile(cfgPath, 'spec:\n  path: ./openapi.yaml\noverlay: ./mcp-overlay.yaml\n');
    const cfg = await loadConfig(cfgPath, dir);
    assert.equal(cfg.spec.path, './openapi.yaml');
  });

  it('rejects config outside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    await assert.rejects(loadConfig('/etc/passwd', dir));
  });

  it('rejects invalid schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const cfgPath = join(dir, 'mcp.config.json');
    await writeFile(cfgPath, JSON.stringify({ spec: {} }));
    await assert.rejects(loadConfig(cfgPath, dir));
  });
});

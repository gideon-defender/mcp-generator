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
      identity: { name: 'example', version: '1.0.0' },
      spec: { path: './openapi.yaml' },
      overlay: './overlay.yaml',
      output: { dir: 'dist' },
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

  it('rejects fields the build does not use', () => {
    for (const extra of [
      { upstreams: {} },
      { auth: {} },
      { tools: {} },
      { output: { bin: 'x' } },
    ]) {
      assert.throws(() =>
        McpProjectConfigSchema.parse({
          spec: { path: './openapi.json' },
          overlay: './mcp-overlay.yaml',
          ...extra,
        }),
      );
    }
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

  it('rejects a valid config outside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const outside = await mkdtemp(join(tmpdir(), 'mcp-cfg-outside-'));
    const cfgPath = join(outside, 'mcp.config.json');
    await writeFile(cfgPath, JSON.stringify({ spec: { path: './a.json' }, overlay: './b.yaml' }));
    await assert.rejects(loadConfig(cfgPath, dir), {
      message: 'config path must be within the working directory',
    });
  });

  it('names the config when it cannot be parsed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    await writeFile(join(dir, 'mcp.config.json'), '{ "spec": ');
    await assert.rejects(loadConfig('mcp.config.json', dir), {
      message: /Failed to parse config mcp\.config\.json/,
    });
  });

  it('rejects invalid schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const cfgPath = join(dir, 'mcp.config.json');
    await writeFile(cfgPath, JSON.stringify({ spec: {} }));
    await assert.rejects(loadConfig(cfgPath, dir), { message: /Invalid config at/ });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPathWithinCwd } from '../src/fs/safe-path.js';

describe('assertPathWithinCwd', () => {
  it('allows a path equal to cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    assert.doesNotThrow(() => assertPathWithinCwd('.', dir, 'config path'));
    assert.doesNotThrow(() => assertPathWithinCwd(dir, dir, 'config path'));
  });

  it('allows a path inside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    await writeFile(join(dir, 'openapi.json'), '{}');
    assert.doesNotThrow(() => assertPathWithinCwd('openapi.json', dir, 'spec path'));
    assert.doesNotThrow(() => assertPathWithinCwd('./openapi.json', dir, 'spec path'));
  });

  it('rejects a path that escapes via ..', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    assert.throws(() => assertPathWithinCwd('../etc/passwd', dir, 'spec path'));
    assert.throws(() => assertPathWithinCwd('sub/../../etc/passwd', dir, 'spec path'));
  });

  it('includes the label in the error message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    assert.throws(() => assertPathWithinCwd('../etc/passwd', dir, 'overlay'), {
      message: 'overlay must be within the working directory',
    });
  });
});

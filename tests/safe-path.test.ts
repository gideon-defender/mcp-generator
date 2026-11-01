import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPathWithinCwd } from '../src/fs/safe-path.js';

const OUTSIDE = /must be within the working directory/;

describe('assertPathWithinCwd', () => {
  it('allows a path equal to cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    assert.doesNotThrow(() => assertPathWithinCwd('.', dir, 'config path'));
    assert.doesNotThrow(() => assertPathWithinCwd(dir, dir, 'config path'));
  });

  it('allows a path inside cwd, including one that does not exist yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    await writeFile(join(dir, 'openapi.json'), '{}');
    assert.doesNotThrow(() => assertPathWithinCwd('openapi.json', dir, 'spec path'));
    assert.doesNotThrow(() => assertPathWithinCwd('./openapi.json', dir, 'spec path'));
    assert.doesNotThrow(() => assertPathWithinCwd('new/nested/out', dir, 'output.dir'));
  });

  it('rejects a path that escapes via ..', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    assert.throws(() => assertPathWithinCwd('../etc/passwd', dir, 'spec path'), OUTSIDE);
    assert.throws(() => assertPathWithinCwd('sub/../../etc/passwd', dir, 'spec path'), OUTSIDE);
    assert.throws(() => assertPathWithinCwd('/etc/passwd', dir, 'spec path'), OUTSIDE);
  });

  it('includes the label in the error message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    assert.throws(() => assertPathWithinCwd('../etc/passwd', dir, 'overlay'), {
      message: 'overlay must be within the working directory',
    });
  });

  it('rejects a symlink that points outside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    const outside = await mkdtemp(join(tmpdir(), 'mcp-outside-'));
    await writeFile(join(outside, 'secret.json'), '{}');
    await symlink(outside, join(dir, 'linked-dir'));
    await symlink(join(outside, 'secret.json'), join(dir, 'linked-file.json'));
    assert.throws(() => assertPathWithinCwd('linked-dir', dir, 'output.dir'), OUTSIDE);
    assert.throws(() => assertPathWithinCwd('linked-dir/new/out', dir, 'output.dir'), OUTSIDE);
    assert.throws(() => assertPathWithinCwd('linked-file.json', dir, 'spec.path'), OUTSIDE);
  });

  it('rejects a dangling symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    await symlink(join(tmpdir(), 'mcp-does-not-exist'), join(dir, 'dangling'));
    assert.throws(() => assertPathWithinCwd('dangling', dir, 'output.dir'), OUTSIDE);
  });

  it('allows a symlink that stays inside cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-safe-'));
    await mkdir(join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'alias'));
    assert.doesNotThrow(() => assertPathWithinCwd('alias/file.json', dir, 'spec.path'));
  });
});

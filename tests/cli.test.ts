import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  acquireOutputLock,
  assertOutputDirUsable,
  installReportPair,
  releaseOutputLock,
  withPinnedOutputDir,
  type RenameFile,
} from '../src/cli.js';
import { runAudit } from '../src/index.js';

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(repoRoot, 'src/cli.ts');
const fixtures = resolve(repoRoot, 'tests/fixtures');

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

describe('CLI', () => {
  it('prints help with no arguments', async () => {
    const result = await runCli([]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it('rejects unknown commands, extra positionals, and missing --spec', async () => {
    assert.equal((await runCli(['bogus'])).code, 2);
    assert.equal(
      (await runCli(['audit', 'extra', '--spec', resolve(fixtures, 'openapi-30.json')])).code,
      2,
    );
    assert.equal((await runCli(['audit'])).code, 2);
  });

  it('fails when flags arrive without a command', async () => {
    // Exiting 0 here would tell a script that an audit ran when none did.
    assert.equal((await runCli(['--spec', resolve(fixtures, 'openapi-30.json')])).code, 2);
    assert.equal((await runCli(['bogus', '--help'])).code, 2);
  });

  it('runs when invoked through a symlinked entry point', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-binlink-'));
    const linked = join(work, 'mcp-generator');
    await symlink(cli, linked);
    const { stdout } = await run(process.execPath, ['--import', 'tsx', linked, '--help'], {
      cwd: repoRoot,
    });
    assert.match(stdout, /Usage:/);
  });

  it('refuses to overwrite a spec named report.json in the output directory', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-selfoverwrite-'));
    const spec = join(out, 'report.json');
    const original = await readFile(resolve(fixtures, 'openapi-30.json'), 'utf8');
    await writeFile(spec, original);
    const result = await runCli(['audit', '--spec', spec, '--out', out]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /overwrite the spec/);
    assert.equal(await readFile(spec, 'utf8'), original);
  });

  it('rejects empty --docs and --out values', async () => {
    const spec = resolve(fixtures, 'openapi-31.yaml');
    assert.equal((await runCli(['audit', '--spec', spec, '--out', ''])).code, 2);
    assert.equal((await runCli(['audit', '--spec', spec, '--docs', ''])).code, 2);
    assert.equal((await runCli(['audit', '--spec', ''])).code, 2);
  });

  it('writes report.json and report.md, and --strict exits 1 only when blocked', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-'));
    const blocked = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-30.json'),
      '--out',
      out,
    ]);
    assert.equal(blocked.code, 0);
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
      summary: { readiness: string };
    };
    assert.equal(report.summary.readiness, 'blocked');
    assert.match(await readFile(join(out, 'report.md'), 'utf8'), /# MCP Generator Audit/);

    const strictBlocked = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-30.json'),
      '--out',
      out,
      '--strict',
    ]);
    assert.equal(strictBlocked.code, 1);

    const strict31 = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-31.yaml'),
      '--out',
      out,
      '--strict',
    ]);
    assert.equal(strict31.code, 0);
    assert.match(strict31.stdout, /needs-31-support/);
  });

  it('strips control characters from spec text in stderr', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-err-'));
    const badPath = join(work, 'bad.json');
    const esc = String.fromCharCode(27);
    await writeFile(
      badPath,
      JSON.stringify({
        openapi: `3.2.0${esc}[31mFAKE\nmcp-generator failed: fake`,
        info: { title: 'T', version: '1' },
      }),
    );
    const result = await runCli(['audit', '--spec', badPath, '--out', join(work, 'out')]);
    assert.equal(result.code, 2);
    assert.ok(!result.stderr.includes(esc));
    assert.ok(!result.stderr.split('\n').includes('mcp-generator failed: fake'));
  });

  it('leaves no staging or backup files after writing a report pair', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-pair-'));
    for (let run = 0; run < 2; run += 1) {
      const result = await runCli([
        'audit',
        '--spec',
        resolve(fixtures, 'openapi-31.yaml'),
        '--out',
        out,
      ]);
      assert.equal(result.code, 0);
    }
    const names = await readdir(out);
    assert.deepEqual(names.sort(), ['report.json', 'report.md']);
  });

  it('refuses a symlinked output directory and writes nothing into the target', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-outlink-'));
    const target = join(work, 'target');
    await mkdir(target);
    const link = join(work, 'link');
    await symlink(target, link, 'dir');
    const result = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-31.yaml'),
      '--out',
      link,
    ]);
    assert.equal(result.code, 2);
    assert.deepEqual(await readdir(target), []);
  });

  it('refuses a directory named report.json and preserves the existing pair', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-reportdir-'));
    await mkdir(join(out, 'report.json'));
    await writeFile(join(out, 'report.json', 'keep.txt'), 'keep');
    await writeFile(join(out, 'report.md'), 'old markdown');
    const result = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-31.yaml'),
      '--out',
      out,
    ]);
    assert.equal(result.code, 2);
    assert.equal(await readFile(join(out, 'report.json', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(join(out, 'report.md'), 'utf8'), 'old markdown');
    assert.deepEqual((await readdir(out)).sort(), ['report.json', 'report.md']);
  });

  it('refuses to run while another run holds the output lock', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-locked-'));
    // This test process is alive for the whole run, so its PID marks a
    // genuinely held lock. A dead PID would count as stale instead.
    await writeFile(join(out, '.mcp-generator.lock'), `${process.pid}\n`);
    await writeFile(join(out, 'report.json'), 'old json');
    await writeFile(join(out, 'report.md'), 'old markdown');
    const result = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-31.yaml'),
      '--out',
      out,
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Another mcp-generator run is writing reports/);
    // The held lock and the existing pair are not ours to remove or replace.
    assert.equal(await readFile(join(out, 'report.json'), 'utf8'), 'old json');
    assert.equal(await readFile(join(out, 'report.md'), 'utf8'), 'old markdown');
    assert.deepEqual((await readdir(out)).sort(), [
      '.mcp-generator.lock',
      'report.json',
      'report.md',
    ]);
  });

  it('removes its own lock on release but never a replacement lock', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-release-'));
    const lockPath = join(out, '.mcp-generator.lock');
    const own = await acquireOutputLock({ outDir: out });
    await releaseOutputLock({ lock: own });
    assert.deepEqual(await readdir(out), []);

    // Simulate the reclaim race: this run's lock file was moved aside
    // and a newer run now owns the lock path.
    const raced = await acquireOutputLock({ outDir: out });
    await rename(lockPath, join(out, '.mcp-generator.lock.moved'));
    await writeFile(lockPath, 'newer run\n');
    await releaseOutputLock({ lock: raced });
    assert.equal(await readFile(lockPath, 'utf8'), 'newer run\n');
  });

  it('removes a stale lock left by a dead process and runs', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-stale-'));
    const child = spawn(process.execPath, ['-e', '']);
    const deadPid = child.pid;
    await new Promise((resolveExit) => child.on('exit', resolveExit));
    assert.ok(deadPid);
    await writeFile(join(out, '.mcp-generator.lock'), `${deadPid}\n`);
    const result = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-31.yaml'),
      '--out',
      out,
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual((await readdir(out)).sort(), ['report.json', 'report.md']);
  });

  it('never mixes a report pair under concurrent runs on one output directory', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-race-'));
    const results = await Promise.all([
      runCli(['audit', '--spec', resolve(fixtures, 'openapi-30.json'), '--out', out]),
      runCli(['audit', '--spec', resolve(fixtures, 'openapi-31.yaml'), '--out', out]),
    ]);
    // Runs serialise on the lock: at least one wins, the loser may exit 2.
    assert.ok(results.some((result) => result.code === 0));
    assert.ok(results.every((result) => result.code === 0 || result.code === 2));
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
      spec: { title: string };
    };
    const markdown = await readFile(join(out, 'report.md'), 'utf8');
    assert.ok(
      markdown.includes(`- Title: ${report.spec.title} `),
      'report.md and report.json come from the same audit',
    );
    assert.deepEqual((await readdir(out)).sort(), ['report.json', 'report.md']);
  });

  it('restores the previous report pair when an install rename fails', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-rollback-'));
    await writeFile(join(out, 'report.json'), 'old json');
    await writeFile(join(out, 'report.md'), 'old markdown');
    const report = await runAudit({ specPath: resolve(fixtures, 'openapi-31.yaml') });
    // Fail only the markdown install step; backups and restores use the
    // real rename, so a working rollback puts the old pair back.
    const renameFile: RenameFile = async ({ from, to }) => {
      if (to === join(out, 'report.md') && from.includes('.tmp')) {
        throw new Error('injected rename failure');
      }
      await rename(from, to);
    };
    await assert.rejects(
      () => installReportPair({ outDir: out, report, renameFile }),
      /injected rename failure/,
    );
    assert.equal(await readFile(join(out, 'report.json'), 'utf8'), 'old json');
    assert.equal(await readFile(join(out, 'report.md'), 'utf8'), 'old markdown');
    assert.deepEqual((await readdir(out)).sort(), ['report.json', 'report.md']);
  });

  it('rejects an output path under a symlinked component inside the working directory', async () => {
    const work = await mkdtemp(join(repoRoot, '.mcp-gen-recheck-'));
    try {
      const target = join(work, 'target');
      await mkdir(target);
      const linkedParent = join(work, 'audits');
      await symlink(target, linkedParent, 'dir');
      // assertOutputDirUsable is the check main runs before and after
      // mkdir; the post-mkdir call only matters when a component inside
      // the working directory is a symlink.
      await assert.rejects(
        () => assertOutputDirUsable({ outDir: join(linkedParent, 'spec-out') }),
        /crosses a symlink/,
      );
      const plain = join(work, 'plain', 'spec-out');
      await mkdir(plain, { recursive: true });
      await assertOutputDirUsable({ outDir: plain });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('serialises concurrent runs that both find the same stale lock', async () => {
    const out = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-stalerace-'));
    const child = spawn(process.execPath, ['-e', '']);
    const deadPid = child.pid;
    await new Promise((resolveExit) => child.on('exit', resolveExit));
    assert.ok(deadPid);
    await writeFile(join(out, '.mcp-generator.lock'), `${deadPid}\n`);
    const results = await Promise.all([
      runCli(['audit', '--spec', resolve(fixtures, 'openapi-30.json'), '--out', out]),
      runCli(['audit', '--spec', resolve(fixtures, 'openapi-31.yaml'), '--out', out]),
    ]);
    // Both runs meet the dead-PID lock. At most one holds the directory
    // at a time, so the installed pair must come from one audit.
    assert.ok(results.some((result) => result.code === 0));
    assert.ok(results.every((result) => result.code === 0 || result.code === 2));
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
      spec: { title: string };
    };
    const markdown = await readFile(join(out, 'report.md'), 'utf8');
    assert.ok(
      markdown.includes(`- Title: ${report.spec.title} `),
      'report.md and report.json come from the same audit',
    );
    assert.deepEqual((await readdir(out)).sort(), ['report.json', 'report.md']);
  });

  it('keeps writing to the checked directory when its path is swapped for a symlink', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-pinswap-'));
    const out = join(work, 'out');
    const moved = join(work, 'moved');
    const target = join(work, 'target');
    await mkdir(out);
    await mkdir(target);
    await writeFile(join(target, 'report.json'), 'target json');
    await writeFile(join(target, 'report.md'), 'target markdown');
    const report = await runAudit({ specPath: resolve(fixtures, 'openapi-31.yaml') });
    const cwdBefore = process.cwd();
    await withPinnedOutputDir({
      outDir: out,
      run: async ({ outDir: pinned }) => {
        // The swap the pathname check cannot see: the checked directory
        // moves away and a symlink takes its path before the write.
        await rename(out, moved);
        await symlink(target, out, 'dir');
        await installReportPair({ outDir: pinned, report });
      },
    });
    assert.equal(process.cwd(), cwdBefore);
    // The pair landed in the checked directory, now under its new name.
    const installed = JSON.parse(await readFile(join(moved, 'report.json'), 'utf8')) as {
      summary: { operations: number };
    };
    assert.ok(installed.summary.operations > 0);
    assert.match(await readFile(join(moved, 'report.md'), 'utf8'), /# MCP Generator Audit/);
    // The link target kept its own files and gained nothing.
    assert.equal(await readFile(join(target, 'report.json'), 'utf8'), 'target json');
    assert.equal(await readFile(join(target, 'report.md'), 'utf8'), 'target markdown');
    assert.deepEqual((await readdir(target)).sort(), ['report.json', 'report.md']);
  });

  it('replaces a symlinked report.json without touching the link target', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-cli-reportlink-'));
    const sentinel = join(work, 'sentinel.txt');
    await writeFile(sentinel, 'sentinel');
    const out = join(work, 'out');
    await mkdir(out);
    await symlink(sentinel, join(out, 'report.json'));
    const result = await runCli([
      'audit',
      '--spec',
      resolve(fixtures, 'openapi-31.yaml'),
      '--out',
      out,
    ]);
    assert.equal(result.code, 0);
    assert.equal(await readFile(sentinel, 'utf8'), 'sentinel');
    assert.equal((await lstat(join(out, 'report.json'))).isSymbolicLink(), false);
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
      summary: { operations: number };
    };
    assert.ok(report.summary.operations > 0);
  });
});

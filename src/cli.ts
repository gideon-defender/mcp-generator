#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, sanitizeInline } from './audit/report.js';
import { runAudit } from './audit/run-audit.js';
import type { AuditReport } from './audit/types.js';

const HELP = `mcp-generator — OpenAPI 3.0+ to MCP (Phase 0: audit)

Usage:
  mcp-generator audit --spec <openapi.json|yaml> [--docs <path>]... [--out <dir>] [--strict]

Options:
  --spec <path>     OpenAPI 3.0.x or 3.1.x document (JSON or YAML). Required.
  --docs <path>     Extra docs (file or directory of .md/.mdx/.txt) to cross-reference
                    against the spec. Repeatable.
  --out <dir>       Output directory for report.json + report.md.
                    Default: audits/<spec-file-name>
  --strict          Exit 1 when the audit readiness is "blocked".
  --help            Show this help.

The audit inventories every operation, derives a generic tool name, classifies
read/mutate, and catalogues blockers, OpenAPI 3.1 constructs, and policy
warnings that condition faithful MCP generation. It never modifies the spec.
`;

async function lstatOrUndefined(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function assertOutputDirUsable({ outDir }: { outDir: string }): Promise<void> {
  const info = await lstatOrUndefined(outDir);
  if (info?.isSymbolicLink()) throw new Error(`Output directory is a symlink: ${outDir}`);
  if (info && !info.isDirectory()) throw new Error(`Output path is not a directory: ${outDir}`);
  // Reject symlinked components between the working directory and the
  // output directory (for example a planted audits/ symlink). Components
  // outside the working directory are the caller's explicit choice.
  const rel = relative(process.cwd(), outDir);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return;
  let current = process.cwd();
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    const partInfo = await lstatOrUndefined(current);
    if (partInfo?.isSymbolicLink()) throw new Error(`Output path crosses a symlink: ${current}`);
  }
}

/**
 * Run `run` with the checked output directory pinned, and restore the
 * working directory afterwards.
 *
 * A pathname check alone does not bind the later writes: a local writer
 * can rename the checked directory away and plant a symlink at its path
 * in the gap, and every write through the path lands in the link target.
 * The process working directory holds the directory itself, not its
 * path, so entering the checked directory pins the inode that relative
 * writes resolve against, and a later swap of the pathname cannot
 * redirect them. The identity check closes the smaller gap between the
 * check above and the move: if the directory at the path is no longer
 * the directory that was checked, the run stops instead of writing.
 * `run` receives '.' as its output directory and must not change the
 * working directory; the lock and install helpers build relative child
 * paths with `join`, so '.' stays relative and pinned.
 */
export async function withPinnedOutputDir<T>({
  outDir,
  run,
}: {
  outDir: string;
  run: ({ outDir }: { outDir: string }) => Promise<T>;
}): Promise<T> {
  await assertOutputDirUsable({ outDir });
  const checked = await lstat(outDir);
  if (!checked.isDirectory()) throw new Error(`Output path is not a directory: ${outDir}`);
  const previousCwd = process.cwd();
  process.chdir(outDir);
  try {
    const pinned = await stat('.');
    if (pinned.dev !== checked.dev || pinned.ino !== checked.ino) {
      throw new Error(`Output directory changed while it was being opened: ${outDir}`);
    }
    return await run({ outDir: '.' });
  } finally {
    process.chdir(previousCwd);
  }
}

async function assertReportFileUsable({ filePath }: { filePath: string }): Promise<void> {
  const info = await lstatOrUndefined(filePath);
  if (info?.isDirectory()) throw new Error(`Report path is a directory: ${filePath}`);
}

async function removeBackup({ filePath }: { filePath: string }): Promise<void> {
  const info = await lstatOrUndefined(filePath);
  if (!info) return;
  // Never recurse into a backup. Preflight rejects real directories, and a
  // symlinked backup must lose only the link, never the target tree.
  if (info.isSymbolicLink()) await unlink(filePath);
  else if (!info.isDirectory()) await rm(filePath, { force: true });
}

/** True when the lock names a process that no longer exists on this host. */
async function lockIsStale({ lockPath }: { lockPath: string }): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(lockPath, 'utf8');
  } catch {
    return false;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH means no such process. EPERM means the process exists but is
    // owned by another user, so the lock still counts as held.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Claim a stale lock for removal without ever deleting a live one.
 *
 * A plain `unlink(lockPath)` after a stale check is not safe: two runs can
 * both judge the same dead-PID lock stale, and the slower run then deletes
 * the fresh lock the faster run just created. Rename is the claim instead.
 * Moving the path to a unique tombstone is atomic, so at most one run
 * moves a given file. The moved file must still be the file the stale
 * check saw (same device and inode, still a dead PID) before it is
 * deleted. A moved file that fails that test is a live replacement lock,
 * and link(2) puts it back when the path is still free: link never
 * overwrites, so a lock created in the meantime keeps the path and the
 * moved file keeps its tombstone name instead of being deleted.
 *
 * Returns true when the caller should retry the exclusive create, false
 * when the lock is held by a live or unreadable owner.
 */
async function tryReclaimStaleLock({ lockPath }: { lockPath: string }): Promise<boolean> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(lockPath);
  } catch {
    return true;
  }
  if (!(await lockIsStale({ lockPath }))) return false;
  const tombstone = `${lockPath}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, tombstone);
  } catch {
    return true;
  }
  let movedStale = false;
  try {
    const moved = await lstat(tombstone);
    movedStale =
      moved.dev === before.dev &&
      moved.ino === before.ino &&
      (await lockIsStale({ lockPath: tombstone }));
  } catch {
    movedStale = false;
  }
  if (movedStale) {
    await unlink(tombstone).catch(() => undefined);
    return true;
  }
  let restored = false;
  try {
    await link(tombstone, lockPath);
    restored = true;
  } catch {
    // A newer lock already occupies the path; that lock wins.
  }
  // Delete the tombstone name only when the link put the file back at
  // the lock path. When the link lost the race, the tombstone still is
  // the moved lock file: deleting it would strip a live owner of its
  // lock and let two runs write at once. The stray tombstone name is
  // the smaller harm, and releaseOutputLock below keeps that owner
  // from deleting the newer lock at the path.
  if (restored) await unlink(tombstone).catch(() => undefined);
  return true;
}

/**
 * Take the per-output-directory lock, or fail. Two runs that share one
 * output directory would use the same fixed report names and could install
 * a mixed JSON/Markdown pair, so runs serialise on an exclusive lock file
 * instead. A lock whose recorded PID is dead is stale (a crash left it
 * behind) and is reclaimed through tryReclaimStaleLock. A lock with a live
 * or unreadable PID stays held; the error names the file for manual
 * removal.
 */
export async function acquireOutputLock({
  outDir,
}: {
  outDir: string;
}): Promise<{ lockPath: string; handle: Awaited<ReturnType<typeof open>> }> {
  // join, not resolve: a relative outDir (the pinned '.' from
  // withPinnedOutputDir) must stay relative so it resolves against the
  // pinned working directory instead of the directory's current path.
  const lockPath = join(outDir, '.mcp-generator.lock');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await tryReclaimStaleLock({ lockPath })) continue;
      throw new Error(
        `Another mcp-generator run is writing reports in: ${resolve(outDir)}. ` +
          `If no run is active, remove ${resolve(lockPath)}`,
      );
    }
    try {
      await handle.write(`${process.pid}\n`);
    } catch (error) {
      // Do not leave a lock that this run never took.
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    return { lockPath, handle };
  }
  throw new Error(
    `Another mcp-generator run is writing reports in: ${resolve(outDir)}. ` +
      `If no run is active, remove ${resolve(lockPath)}`,
  );
}

export async function releaseOutputLock({
  lock,
}: {
  lock: Awaited<ReturnType<typeof acquireOutputLock>>;
}): Promise<void> {
  // Remove the lock file only when the path still names this run's
  // file. A reclaim race can move this run's file aside and let a newer
  // run take the path; an unconditional unlink would then delete the
  // newer run's live lock.
  const [own, atPath] = await Promise.all([
    lock.handle.stat().catch(() => undefined),
    lstatOrUndefined(lock.lockPath).catch(() => undefined),
  ]);
  await lock.handle.close().catch(() => undefined);
  if (!own || !atPath || own.dev !== atPath.dev || own.ino !== atPath.ino) return;
  await unlink(lock.lockPath).catch(() => undefined);
}

/** One rename step of the report-pair install; tests inject a failing step. */
export type RenameFile = ({ from, to }: { from: string; to: string }) => Promise<void>;

const renameStep: RenameFile = async ({ from, to }) => {
  await rename(from, to);
};

/**
 * Install report.json and report.md as one pair under outDir.
 *
 * Write both staging files before any rename. Unique staging names keep a
 * pre-planted symlink from becoming the write target, and exclusive
 * creation refuses a staging path planted after the names are known.
 * If a rename fails, the previous pair is restored from backups.
 */
export async function installReportPair({
  outDir,
  report,
  renameFile = renameStep,
}: {
  outDir: string;
  report: AuditReport;
  renameFile?: RenameFile;
}): Promise<void> {
  // join, not resolve, for the same reason as the lock path: a pinned
  // relative outDir must stay relative to the pinned working directory.
  const jsonPath = join(outDir, 'report.json');
  const markdownPath = join(outDir, 'report.md');
  await assertReportFileUsable({ filePath: jsonPath });
  await assertReportFileUsable({ filePath: markdownPath });
  const runId = randomUUID();
  const stagingJson = `${jsonPath}.${runId}.tmp`;
  const stagingMarkdown = `${markdownPath}.${runId}.tmp`;
  const backupJson = `${jsonPath}.${runId}.bak`;
  const backupMarkdown = `${markdownPath}.${runId}.bak`;
  let jsonBacked = false;
  let markdownBacked = false;
  let jsonInstalled = false;
  let markdownInstalled = false;
  try {
    await writeFile(stagingJson, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await writeFile(stagingMarkdown, renderMarkdown({ report }), { flag: 'wx' });
    try {
      try {
        await renameFile({ from: jsonPath, to: backupJson });
        jsonBacked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await renameFile({ from: markdownPath, to: backupMarkdown });
        markdownBacked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await renameFile({ from: stagingJson, to: jsonPath });
      jsonInstalled = true;
      await renameFile({ from: stagingMarkdown, to: markdownPath });
      markdownInstalled = true;
    } catch (error) {
      // Every rollback step is guarded on its own: one failed restore
      // must not skip the other restores or mask the original error.
      if (jsonInstalled) await rm(jsonPath, { force: true }).catch(() => undefined);
      if (markdownInstalled) await rm(markdownPath, { force: true }).catch(() => undefined);
      if (jsonBacked) await renameFile({ from: backupJson, to: jsonPath }).catch(() => undefined);
      if (markdownBacked)
        await renameFile({ from: backupMarkdown, to: markdownPath }).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(stagingJson, { force: true }).catch(() => undefined);
    await rm(stagingMarkdown, { force: true }).catch(() => undefined);
  }
  if (jsonBacked) await removeBackup({ filePath: backupJson }).catch(() => undefined);
  if (markdownBacked) await removeBackup({ filePath: backupMarkdown }).catch(() => undefined);
}

/** Canonical path for comparisons: links resolved where the path exists. */
async function canonicalPath({ filePath }: { filePath: string }): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    try {
      return resolve(await realpath(dirname(filePath)), basename(filePath));
    } catch {
      return resolve(filePath);
    }
  }
}

/** The audit never modifies the spec, so a report may not land on it. */
async function assertReportsWillNotOverwriteSpec({
  specPath,
  outDir,
}: {
  specPath: string;
  outDir: string;
}): Promise<void> {
  const canonicalSpec = await canonicalPath({ filePath: specPath });
  for (const name of ['report.json', 'report.md']) {
    const reportPath = resolve(outDir, name);
    if ((await canonicalPath({ filePath: reportPath })) === canonicalSpec) {
      throw new Error(`Output report would overwrite the spec: ${reportPath}`);
    }
  }
}

function slug({ specPath }: { specPath: string }): string {
  return basename(specPath)
    .replace(/\.(json|ya?ml)$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      spec: { type: 'string' },
      docs: { type: 'string', multiple: true },
      out: { type: 'string' },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command] = positionals;
  if (values.help) {
    // Help wins only for a valid or absent command. `bogus --help` is a bad
    // invocation, not a help request.
    if (command !== undefined && command !== 'audit') {
      throw new Error(`Unknown command: ${command}`);
    }
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length === 0) {
    // Bare invocation prints help. Flags without a command are an error:
    // exiting 0 would tell a script that an audit ran when none did.
    const hasFlags =
      values.spec !== undefined ||
      values.docs !== undefined ||
      values.out !== undefined ||
      values.strict;
    if (hasFlags) throw new Error('Missing command: expected "audit"');
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
  }
  if (command !== 'audit') throw new Error(`Unknown command: ${command ?? ''}`);
  if (!values.spec || values.spec.trim() === '') throw new Error('Missing --spec <path>');
  // resolve('') returns the working directory. An empty --docs scans that
  // directory and an empty --out writes reports into it. Reject both.
  for (const entry of values.docs ?? []) {
    if (entry.trim() === '') throw new Error('Empty --docs <path>');
  }
  if (values.out !== undefined && values.out.trim() === '') throw new Error('Empty --out <dir>');
  const specPath = resolve(values.spec);
  const docsPaths = (values.docs ?? []).map((entry) => resolve(entry));
  const outDir = resolve(values.out ?? `audits/${slug({ specPath })}`);
  await assertReportsWillNotOverwriteSpec({ specPath, outDir });
  const report = await runAudit({ specPath, docsPaths });
  await assertOutputDirUsable({ outDir });
  await mkdir(outDir, { recursive: true });
  // Re-check after creation inside withPinnedOutputDir: a symlinked
  // parent (e.g. audits/) makes mkdir create the directory inside the
  // link target. The pin then holds the checked directory itself, so a
  // later swap of its pathname cannot redirect the lock or the reports.
  await withPinnedOutputDir({
    outDir,
    run: async ({ outDir: pinnedDir }) => {
      const lock = await acquireOutputLock({ outDir: pinnedDir });
      try {
        await installReportPair({ outDir: pinnedDir, report });
      } finally {
        await releaseOutputLock({ lock });
      }
    },
  });
  const { summary } = report;
  process.stdout.write(
    `${sanitizeInline(report.spec.title)} (${report.spec.openapi}): ${summary.operations} operations ` +
      `(${summary.readOperations} read / ${summary.mutateOperations} mutate), ` +
      `${summary.findingsBySeverity.blocker} blockers, ` +
      `${summary.findingsBySeverity.compat31} compat31, ` +
      `${summary.findingsBySeverity.warning} warnings — readiness: ${summary.readiness}\n` +
      `Reports: ${resolve(outDir, 'report.md')} · ${resolve(outDir, 'report.json')}\n`,
  );
  if (values.strict && summary.readiness === 'blocked') process.exitCode = 1;
}

function canonicalEntryPath({ filePath }: { filePath: string }): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

// Run only as the entry point. Tests import the filesystem helpers
// above, and an import must never start a real audit. Both sides use
// real paths: an installed bin is a link to this file, and a link
// path must still count as the entry point.
const isEntryPoint =
  process.argv[1] !== undefined &&
  canonicalEntryPath({ filePath: process.argv[1] }) ===
    canonicalEntryPath({ filePath: fileURLToPath(import.meta.url) });
if (isEntryPoint) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `mcp-generator failed: ${sanitizeInline(error instanceof Error ? error.message : 'unknown error')}\n`,
    );
    process.exitCode = 2;
  });
}

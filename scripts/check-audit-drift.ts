#!/usr/bin/env node
/**
 * Re-runs the audit behind every `audits/<dir>/report.json` and fails when
 * the result no longer matches what's checked in. Those reports are local
 * artifacts refreshed by hand, so a generator change (new finding, revised
 * rule) can leave one silently stale with nothing to flag it — this is
 * that flag.
 *
 * This repo is product-neutral and must not assume any particular spec or
 * sibling project is present (see README.md). So this script takes no
 * configuration of its own: each report.json already records the absolute
 * `spec.path` (and `docs.roots`, if docs were cross-referenced) it was
 * generated from, and that is what gets re-run. A report generated on a
 * different machine, or for a spec that lives in a sibling project this
 * one doesn't have checked out, is skipped, not failed — the point is to
 * catch drift where the source is available, not to require it everywhere.
 */
import { isDeepStrictEqual } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from '../src/audit/run-audit.js';
import type { AuditReport } from '../src/audit/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function exists({ filePath }: { filePath: string }): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findAuditDirs(): Promise<string[]> {
  const auditsRoot = resolve(repoRoot, 'audits');
  const entries = await readdir(auditsRoot, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await exists({ filePath: resolve(auditsRoot, entry.name, 'report.json') }))
    ) {
      dirs.push(entry.name);
    }
  }
  return dirs.sort();
}

/** `spec.path` is the absolute local path the audit ran against; it is
 * expected to differ between the machine that checked in the report and
 * the machine re-running it, so it carries no drift signal of its own. */
function withoutSpecPath({ report }: { report: AuditReport }): Omit<AuditReport, 'spec'> & {
  spec: Omit<AuditReport['spec'], 'path'>;
} {
  const { spec, ...rest } = report;
  const { path: _path, ...specRest } = spec;
  return { ...rest, spec: specRest };
}

function diffCounts({
  fresh,
  checkedIn,
}: {
  fresh: Record<string, number>;
  checkedIn: Record<string, number>;
}): string[] {
  const lines: string[] = [];
  for (const key of new Set([...Object.keys(fresh), ...Object.keys(checkedIn)])) {
    const freshCount = fresh[key] ?? 0;
    const checkedInCount = checkedIn[key] ?? 0;
    if (freshCount !== checkedInCount) {
      lines.push(`      ${key}: checked-in ${checkedInCount} -> fresh ${freshCount}`);
    }
  }
  return lines;
}

async function checkOne({ dir }: { dir: string }): Promise<'ok' | 'drift' | 'skip'> {
  const reportPath = resolve(repoRoot, 'audits', dir, 'report.json');
  let checkedIn: AuditReport;
  try {
    checkedIn = JSON.parse(await readFile(reportPath, 'utf8')) as AuditReport;
  } catch (error) {
    console.log(
      `  skip ${dir}: could not read report.json (${error instanceof Error ? error.message : String(error)})`,
    );
    return 'skip';
  }
  const specPath = checkedIn.spec?.path;
  if (!specPath) {
    console.log(`  skip ${dir}: report.json has no recorded spec.path`);
    return 'skip';
  }
  const docsPaths = checkedIn.docs?.roots ?? [];
  if (!(await exists({ filePath: specPath }))) {
    console.log(`  skip ${dir}: spec not found at ${specPath} (not checked out on this machine)`);
    return 'skip';
  }
  for (const docsPath of docsPaths) {
    if (!(await exists({ filePath: docsPath }))) {
      console.log(`  skip ${dir}: docs not found at ${docsPath} (not checked out on this machine)`);
      return 'skip';
    }
  }
  const fresh = await runAudit({ specPath, docsPaths });
  if (
    isDeepStrictEqual(withoutSpecPath({ report: fresh }), withoutSpecPath({ report: checkedIn }))
  ) {
    console.log(`  ok   ${dir}`);
    return 'ok';
  }
  console.log(`  DRIFT ${dir}: fresh run no longer matches audits/${dir}/report.json`);
  for (const line of diffCounts({
    fresh: fresh.summary.findingsBySeverity,
    checkedIn: checkedIn.summary.findingsBySeverity,
  })) {
    console.log(line);
  }
  for (const line of diffCounts({
    fresh: fresh.summary.findingsByCode,
    checkedIn: checkedIn.summary.findingsByCode,
  })) {
    console.log(line);
  }
  if (fresh.operations.length !== checkedIn.operations.length) {
    console.log(
      `      operations: checked-in ${checkedIn.operations.length} -> fresh ${fresh.operations.length}`,
    );
  }
  console.log(
    `      regenerate with: pnpm build && node dist/cli.js audit --spec ${specPath} --out audits/${dir}` +
      (docsPaths.length > 0 ? ` --docs ${docsPaths.join(' --docs ')}` : ''),
  );
  return 'drift';
}

async function main(): Promise<void> {
  console.log('Checking audits/*/report.json against a fresh run...');
  const dirs = await findAuditDirs();
  let drift = false;
  let checked = 0;
  for (const dir of dirs) {
    const result = await checkOne({ dir });
    if (result === 'drift') drift = true;
    if (result !== 'skip') checked += 1;
  }
  if (drift) {
    console.error('\nChecked-in report(s) are stale; regenerate them (see audits/README.md).');
    process.exitCode = 1;
    return;
  }
  if (checked === 0) {
    console.log('\nNo checked-in report has its source spec available here; nothing to verify.');
    return;
  }
  console.log(`\n${checked} report(s) match a fresh run.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});

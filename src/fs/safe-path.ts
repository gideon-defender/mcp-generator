import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function isWithin(target: string, base: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolves symlinks in the deepest existing ancestor and re-appends the missing tail. */
function canonicalize(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing);
    } catch (err) {
      const parent = dirname(current);
      const dangling = lstatSync(current, { throwIfNoEntry: false }) !== undefined;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || dangling || parent === current) {
        throw err;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function assertPathWithinCwd(filePath: string, cwd: string, label: string): void {
  const fail = () => new Error(`${label} must be within the working directory`);
  const base = resolve(cwd);
  const target = resolve(base, filePath);
  if (!isWithin(target, base)) throw fail();
  let canonicalTarget: string;
  let canonicalBase: string;
  try {
    canonicalBase = canonicalize(base);
    canonicalTarget = canonicalize(target);
  } catch {
    throw fail();
  }
  if (!isWithin(canonicalTarget, canonicalBase)) throw fail();
}

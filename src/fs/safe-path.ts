import { realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

function isWithinBase(target: string, base: string): boolean {
  const normalizedTarget = resolve(target);
  const normalizedBase = resolve(base);
  if (normalizedTarget === normalizedBase) {
    return true;
  }
  if (normalizedTarget.indexOf(normalizedBase + sep) === 0) {
    return true;
  }
  const rel = relative(normalizedBase, normalizedTarget);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
    return false;
  }
  return true;
}

export function assertPathWithinCwd(filePath: string, cwd: string, label: string): void {
  const resolvedCwd = resolve(cwd);
  const resolvedPath = resolve(resolvedCwd, filePath);

  let canonicalCwd = resolvedCwd;
  try {
    canonicalCwd = realpathSync(resolvedCwd);
  } catch {
    // ignore
  }

  if (!isWithinBase(resolvedPath, resolvedCwd)) {
    throw new Error(`${label} must be within the working directory`);
  }

  try {
    const canonicalTarget = realpathSync(resolvedPath);
    if (isWithinBase(canonicalTarget, canonicalCwd) || isWithinBase(canonicalTarget, resolvedCwd)) {
      return;
    }
    throw new Error(`${label} must be within the working directory`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('must be within')) {
      throw err;
    }
    try {
      const parent = dirname(resolvedPath);
      const canonicalParent = realpathSync(parent);
      if (
        !isWithinBase(canonicalParent, canonicalCwd) &&
        !isWithinBase(canonicalParent, resolvedCwd)
      ) {
        throw new Error(`${label} must be within the working directory`);
      }
      return;
    } catch (parentErr) {
      if (parentErr instanceof Error && parentErr.message.includes('must be within')) {
        throw parentErr;
      }
      throw new Error(`${label} must be within the working directory`);
    }
  }
}

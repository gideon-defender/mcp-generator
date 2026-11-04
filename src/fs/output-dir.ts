/**
 * Shared safety for write targets inside the working directory. The audit
 * path pins the output directory and checks each report file; the build
 * path reuses the same primitives for the artifact files it writes.
 */
import { lstat, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { isMainThread } from 'node:worker_threads';

let pinActive = false;

export async function lstatOrUndefined(
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
 * Refuse to overwrite a symlink or a directory at a file path an
 * artifact write is about to use. A pre-planted `name/target` symlink
 * would otherwise receive the bytes of the artifact.
 */
export async function assertWritableFile({ filePath }: { filePath: string }): Promise<void> {
  const info = await lstatOrUndefined(filePath);
  if (info?.isDirectory()) throw new Error(`Output path is a directory: ${filePath}`);
  if (info?.isSymbolicLink()) throw new Error(`Output path is a symlink: ${filePath}`);
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
 *
 * Node has no `openat`, so this uses `process.chdir`, which is process-wide:
 * all relative paths in the process resolve against `outDir` until `run`
 * settles. It therefore refuses to run in a worker thread (where `chdir`
 * is unavailable) or while another pinned run is active, and callers must
 * not do other working-directory-relative work concurrently.
 */
export async function withPinnedOutputDir<T>({
  outDir,
  run,
}: {
  outDir: string;
  run: ({ outDir }: { outDir: string }) => Promise<T>;
}): Promise<T> {
  if (!isMainThread)
    throw new Error('Pinning the output directory requires the main thread (process.chdir).');
  // Claimed before the first await so two concurrent callers cannot both pass.
  if (pinActive)
    throw new Error(
      'Another output directory is already pinned; run one build or audit at a time.',
    );
  pinActive = true;
  try {
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
  } finally {
    pinActive = false;
  }
}

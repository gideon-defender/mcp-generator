import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { DocsCrossReference } from './types.js';

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
// RFC 3986 path characters (pchar): unreserved, percent-encoded,
// sub-delims, ":" and "@". A trailing slash is part of the route, so
// "/v1/users/" in prose must keep it to match the same spec path.
const PATH_PATTERN = /\/[A-Za-z0-9._~%{}:$@!&()*+,;=-]+(?:\/[A-Za-z0-9._~%{}:$@!&()*+,;=-]+)*\/?/g;

/** Docs are untrusted input too: bound the work one audit will read. */
export const MAX_DOC_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_DOC_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_DOC_FILES = 10_000;
export const MAX_DOC_PATHS = 10_000;

const TRAILING_PUNCT = new Set(['.', ',', ';', ':', ')', '`', "'", '"', ']']);

export function normalizeDocumentedPath({ raw }: { raw: string }): string {
  // Trim from the end in one pass. A regex for this scans a long run
  // of dots from each start point, which costs time squared.
  let end = raw.length;
  while (end > 0 && TRAILING_PUNCT.has(raw[end - 1] ?? '')) end -= 1;
  const trimmed = raw.slice(0, end);
  const segments = trimmed.split('/').map((segment) => {
    if (segment.startsWith(':')) return `{${segment.slice(1)}}`;
    if (segment.startsWith('${') && segment.endsWith('}') && segment.length > 3)
      return `{${segment.slice(2, -1)}}`;
    if (segment.startsWith('$')) return `{${segment.slice(1)}}`;
    return segment;
  });
  return segments.join('/');
}

/**
 * Comparison key with parameter names erased: docs and a spec rarely agree
 * on names (`{userId}` vs `{id}`), but the route shape is the same. Concrete
 * segments stay concrete, so `/v1/users/123` does not claim a templated
 * route and `/v1/users/list` does not match `/v1/users/{id}`.
 */
function canonicalPath({ path }: { path: string }): string {
  return path
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}') && segment.length > 2 ? '{}' : segment,
    )
    .join('/');
}

type FileLimit = { found: number; truncated: boolean };

async function collectFiles({
  root,
  isRoot,
  skipped,
  limit,
}: {
  root: string;
  isRoot: boolean;
  skipped: string[];
  limit: FileLimit;
}): Promise<string[]> {
  // Symlinks below the root are never followed out of the docs tree. The
  // root itself is followed when it is a symlink: the caller named it
  // explicitly. A missing root still throws — that is a caller error.
  // Below the root, a failed lstat (a read-only directory that blocks the
  // search, a file removed mid-walk) skips that entry like any other
  // unreadable docs path instead of aborting the whole audit.
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (isRoot) throw error;
    skipped.push(root);
    return [];
  }
  if (info.isSymbolicLink() && !isRoot) return [];
  const effective = info.isSymbolicLink() ? await stat(root) : info;
  if (effective.isFile()) {
    if (!DOC_EXTENSIONS.has(extname(root).toLowerCase())) return [];
    // The cap stops the walk itself, not just the reads after it. A
    // tree past the cap never builds a full file list in memory.
    if (limit.found >= MAX_DOC_FILES) {
      limit.truncated = true;
      return [];
    }
    limit.found += 1;
    return [root];
  }
  if (!effective.isDirectory()) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // Surface the skip: a silent empty result reads as "no docs found"
    // and turns every spec path into a false undocumented finding.
    skipped.push(root);
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (limit.found >= MAX_DOC_FILES) {
      limit.truncated = true;
      break;
    }
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory())
      files.push(...(await collectFiles({ root: full, isRoot: false, skipped, limit })));
    else if (entry.isFile() && DOC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      limit.found += 1;
      files.push(full);
    }
  }
  return files.sort();
}

/** Extract route-like paths mentioned in prose docs and diff them against the spec. */
export async function crossReferenceDocs({
  roots,
  specPaths,
}: {
  roots: string[];
  specPaths: string[];
}): Promise<DocsCrossReference> {
  // API-looking candidates only: the first segment must be one used by the
  // spec, or a version segment (v1, v2, ...) must appear in the first two
  // segments. This drops prose pairs like "Entra/Google" or "SAML/SCIM".
  const specFirstSegments = new Set(specPaths.map((path) => path.split('/')[1] ?? ''));
  const isApiLooking = (path: string): boolean => {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const [first, second] = segments;
    if (first && specFirstSegments.has(first)) return true;
    if (first && /^v\d+$/.test(first)) return true;
    if (second && /^v\d+$/.test(second)) return true;
    return segments.some((segment) => segment.startsWith('{'));
  };
  const documented = new Set<string>();
  const skippedFiles: string[] = [];
  let filesRead = 0;
  let totalBytes = 0;
  let boundHit = false;
  let pathLimitHit = false;
  const limit: FileLimit = { found: 0, truncated: false };
  for (const root of roots) {
    if (boundHit) break;
    const collected = await collectFiles({ root, isRoot: true, skipped: skippedFiles, limit });
    if (limit.truncated) {
      // The walk stopped at the file cap. Name the root as skipped so
      // the report shows the scan was partial, without listing every
      // file the walk never reached.
      if (!skippedFiles.includes(root)) skippedFiles.push(root);
    }
    for (const file of collected) {
      // Past a bound, this file and all after it count as skipped.
      // The audit still runs; it just reads no more docs text.
      if (boundHit || filesRead >= MAX_DOC_FILES) {
        boundHit = true;
        skippedFiles.push(file);
        continue;
      }
      let text: string;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_DOC_FILE_BYTES) {
          skippedFiles.push(file);
          continue;
        }
        // The total bound counts bytes the scan reads. A file skipped
        // for the per-file bound reads nothing, so its size must not
        // trip the total bound and end the scan for smaller files.
        if (totalBytes + info.size > MAX_DOC_TOTAL_BYTES) {
          skippedFiles.push(file);
          boundHit = true;
          continue;
        }
        text = await readFile(file, 'utf8');
        filesRead += 1;
        totalBytes += info.size;
      } catch {
        // One unreadable or vanished file must not abort the whole audit.
        skippedFiles.push(file);
        continue;
      }
      // Strip URL origins so the host is not mistaken for a path segment.
      const prose = text.replace(/https?:\/\/[^\s/]+/gi, (url) => {
        const pathStart = url.indexOf('/', url.indexOf('://') + 3);
        return pathStart < 0 ? '' : url.slice(pathStart);
      });
      for (const match of prose.matchAll(PATH_PATTERN)) {
        const normalized = normalizeDocumentedPath({ raw: match[0] });
        // File paths and URLs in prose produce false positives; require an
        // API-looking shape (no file extension on the last segment).
        const last = normalized.split('/').at(-1) ?? '';
        if (last.includes('.') && !last.startsWith('{')) continue;
        if (!isApiLooking(normalized)) continue;
        if (documented.has(normalized)) continue;
        // Distinct paths have no byte bound of their own: millions of
        // short paths fit in the byte caps and each one lives in the
        // report. Cap the count, and name the partial scan below.
        if (documented.size >= MAX_DOC_PATHS) {
          pathLimitHit = true;
          break;
        }
        documented.add(normalized);
      }
      if (pathLimitHit) {
        // Like the file cap, the root names the partial scan instead of
        // one skipped entry per path past the cap.
        boundHit = true;
        if (!skippedFiles.includes(root)) skippedFiles.push(root);
        break;
      }
    }
  }
  const documentedPaths = [...documented].sort();
  const specCanonical = new Set(specPaths.map((path) => canonicalPath({ path })));
  const documentedCanonical = new Set(documentedPaths.map((path) => canonicalPath({ path })));
  return {
    roots,
    skippedFiles: skippedFiles.sort(),
    documentedPaths,
    documentedNotInSpec: documentedPaths.filter(
      (path) => !specCanonical.has(canonicalPath({ path })),
    ),
    specNotDocumented: [...new Set(specPaths)]
      .filter((path) => !documentedCanonical.has(canonicalPath({ path })))
      .sort(),
  };
}

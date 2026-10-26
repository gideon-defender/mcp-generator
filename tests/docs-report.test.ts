import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_DOC_FILE_BYTES,
  MAX_DOC_FILES,
  MAX_DOC_PATHS,
  MAX_DOC_TOTAL_BYTES,
  normalizeDocumentedPath,
} from '../src/audit/docs.js';
import { renderMarkdown } from '../src/audit/report.js';
import { runAudit } from '../src/index.js';
import { baseSpec, codes, okOperation, type Spec } from './helpers.js';

describe('docs and report safety', () => {
  it('handles URLs, :param paths, single segments, and broken symlinks', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, 'guide.md'),
      'See https://api.example.com/v1/widgets and GET /v1/users/:id plus /health and /v1/ghost.\n',
    );
    await writeFile(join(work, 'outside.md'), 'GET /v1/secret\n');
    await symlink(join(work, 'outside.md'), join(docsDir, 'linked.md'));
    await symlink(join(work, 'missing.md'), join(docsDir, 'broken.md'));
    const spec = baseSpec({
      '/v1/widgets': { get: okOperation() },
      '/v1/users/{id}': { get: okOperation({ operationId: 'getUser' }) },
      '/health': { get: okOperation({ operationId: 'health' }) },
    });
    const specPath = join(work, 'docs-spec.json');
    await writeFile(specPath, JSON.stringify(spec));
    const report = await runAudit({ specPath, docsPaths: [docsDir] });
    assert.ok(report.docs);
    assert.ok(report.docs.documentedPaths.includes('/v1/widgets'));
    assert.ok(!report.docs.documentedPaths.some((path) => path.includes('api.example.com')));
    assert.ok(report.docs.documentedPaths.includes('/v1/users/{id}'));
    assert.ok(report.docs.documentedPaths.includes('/health'));
    assert.ok(!report.docs.documentedPaths.includes('/v1/secret'), 'symlinks are not followed');
    assert.ok(codes(report).has('DOC_NOT_IN_SPEC'));
    assert.ok(!codes(report).has('DOC_UNDOCUMENTED'));
  });

  it('matches ${param} docs paths and follows an explicit docs root symlink', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-link-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, 'guide.md'), 'GET /v1/users/${id}\n');
    const docsLink = join(work, 'docs-link');
    await symlink(docsDir, docsLink, 'dir');
    const specPath = join(work, 'spec.json');
    await writeFile(
      specPath,
      JSON.stringify(baseSpec({ '/v1/users/{id}': { get: okOperation() } })),
    );
    const report = await runAudit({ specPath, docsPaths: [docsLink] });
    assert.ok(report.docs?.documentedPaths.includes('/v1/users/{id}'));
    assert.ok(!codes(report).has('DOC_NOT_IN_SPEC'));
    assert.ok(!codes(report).has('DOC_UNDOCUMENTED'));
  });

  it('matches docs paths by route shape, not parameter name', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-shape-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, 'guide.md'),
      'GET /v1/users/{userId} and HTTPS://api.example.com/v1/widgets\n',
    );
    const specPath = join(work, 'spec.json');
    await writeFile(
      specPath,
      JSON.stringify(
        baseSpec({
          '/v1/users/{id}': { get: okOperation() },
          '/v1/widgets': { get: okOperation({ operationId: 'listWidgets' }) },
        }),
      ),
    );
    const report = await runAudit({ specPath, docsPaths: [docsDir] });
    assert.ok(report.docs);
    // The documented spelling is preserved in the listing.
    assert.ok(report.docs.documentedPaths.includes('/v1/users/{userId}'));
    assert.ok(!report.docs.documentedPaths.some((path) => path.includes('api.example.com')));
    assert.deepEqual(report.docs.documentedNotInSpec, []);
    assert.deepEqual(report.docs.specNotDocumented, []);
    assert.ok(!codes(report).has('DOC_NOT_IN_SPEC'));
    assert.ok(!codes(report).has('DOC_UNDOCUMENTED'));
  });

  it('surfaces unreadable docs directories as skipped files', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-locked-'));
    const docsDir = join(work, 'docs');
    const locked = join(docsDir, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'guide.md'), 'GET /v1/widgets\n');
    const specPath = join(work, 'spec.json');
    await writeFile(specPath, JSON.stringify(baseSpec({ '/v1/widgets': { get: okOperation() } })));
    await chmod(locked, 0o000);
    try {
      const report = await runAudit({ specPath, docsPaths: [docsDir] });
      assert.ok(report.docs?.skippedFiles.includes(locked));
      assert.ok(codes(report).has('DOC_FILES_SKIPPED'));
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('skips a nested docs directory blocked by a read-only parent', async () => {
    // Root ignores permission bits; the skip path cannot be exercised.
    if (process.getuid?.() === 0) return;
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-readonly-'));
    const docsDir = join(work, 'docs');
    const locked = join(docsDir, 'locked');
    const nested = join(locked, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'guide.md'), 'GET /v1/widgets\n');
    const specPath = join(work, 'spec.json');
    await writeFile(specPath, JSON.stringify(baseSpec({ '/v1/widgets': { get: okOperation() } })));
    // Readable but not searchable: listing works, stat of a child fails.
    await chmod(locked, 0o444);
    try {
      const report = await runAudit({ specPath, docsPaths: [docsDir] });
      assert.ok(report.docs?.skippedFiles.includes(nested));
      assert.ok(codes(report).has('DOC_FILES_SKIPPED'));
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('trims trailing punctuation from documented paths in linear time', () => {
    assert.equal(normalizeDocumentedPath({ raw: '/v1/users...' }), '/v1/users');
    // A long dot run with a letter at the end has no trailing punctuation.
    // The old regex trim scanned this shape once per start point.
    const dotted = `/${'.'.repeat(100_000)}a`;
    assert.equal(normalizeDocumentedPath({ raw: dotted }), dotted);
  });

  it('skips a docs file over the per-file size limit and reads the rest', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-big-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    const big = join(docsDir, 'big.md');
    await writeFile(big, Buffer.alloc(MAX_DOC_FILE_BYTES + 1, 'a'));
    await writeFile(join(docsDir, 'guide.md'), 'GET /v1/widgets\n');
    const specPath = join(work, 'spec.json');
    await writeFile(specPath, JSON.stringify(baseSpec({ '/v1/widgets': { get: okOperation() } })));
    const report = await runAudit({ specPath, docsPaths: [docsDir] });
    assert.ok(report.docs?.skippedFiles.includes(big));
    assert.ok(report.docs?.documentedPaths.includes('/v1/widgets'));
    assert.ok(codes(report).has('DOC_FILES_SKIPPED'));
  });

  it('does not let a skipped oversized file trip the total-bytes bound', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-total-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    // Seven files at the per-file bound fill most of the total bound.
    // The oversized file after them reads nothing, so the small guide
    // behind it still fits and must be read.
    const fillerCount = Math.floor(MAX_DOC_TOTAL_BYTES / MAX_DOC_FILE_BYTES) - 1;
    for (let index = 0; index < fillerCount; index += 1) {
      await writeFile(join(docsDir, `a${index}.md`), Buffer.alloc(MAX_DOC_FILE_BYTES, 'a'));
    }
    const big = join(docsDir, 'big.md');
    await writeFile(big, Buffer.alloc(MAX_DOC_FILE_BYTES + 1, 'a'));
    await writeFile(join(docsDir, 'guide.md'), 'GET /v1/widgets\n');
    const specPath = join(work, 'spec.json');
    await writeFile(specPath, JSON.stringify(baseSpec({ '/v1/widgets': { get: okOperation() } })));
    const report = await runAudit({ specPath, docsPaths: [docsDir] });
    assert.ok(report.docs?.skippedFiles.includes(big));
    assert.ok(report.docs?.documentedPaths.includes('/v1/widgets'));
  });

  it('matches documented paths with a trailing slash or path punctuation', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-paths-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, 'guide.md'),
      'GET /v1/users/ and GET /v1/foo+bar/baz and GET /v1/a,b;c=d\n',
    );
    const specPath = join(work, 'spec.json');
    await writeFile(
      specPath,
      JSON.stringify(
        baseSpec({
          '/v1/users/': { get: okOperation() },
          '/v1/foo+bar/baz': { get: okOperation({ operationId: 'getFoo' }) },
          '/v1/a,b;c=d': { get: okOperation({ operationId: 'getPunct' }) },
        }),
      ),
    );
    const report = await runAudit({ specPath, docsPaths: [docsDir] });
    assert.ok(report.docs);
    assert.ok(report.docs.documentedPaths.includes('/v1/users/'));
    assert.ok(report.docs.documentedPaths.includes('/v1/foo+bar/baz'));
    assert.ok(report.docs.documentedPaths.includes('/v1/a,b;c=d'));
    assert.deepEqual(report.docs.documentedNotInSpec, []);
    assert.deepEqual(report.docs.specNotDocumented, []);
  });

  it('stops enumerating a docs tree at the file cap', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-cap-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    const total = MAX_DOC_FILES + 5;
    for (let start = 0; start < total; start += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, total - start) }, (_, offset) =>
          writeFile(join(docsDir, `doc-${start + offset}.md`), 'GET /v1/widgets\n'),
        ),
      );
    }
    const specPath = join(work, 'spec.json');
    await writeFile(specPath, JSON.stringify(baseSpec({ '/v1/widgets': { get: okOperation() } })));
    const report = await runAudit({ specPath, docsPaths: [docsDir] });
    assert.ok(report.docs);
    assert.ok(report.docs.documentedPaths.includes('/v1/widgets'));
    // The root names the partial scan, instead of one skipped entry
    // per file past the cap.
    assert.ok(report.docs.skippedFiles.includes(docsDir));
    assert.ok(report.docs.skippedFiles.length < 10);
  });

  it('stops collecting documented paths at the path cap', async () => {
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-docs-path-cap-'));
    const docsDir = join(work, 'docs');
    await mkdir(docsDir, { recursive: true });
    const paths = Array.from({ length: MAX_DOC_PATHS + 100 }, (_, index) => `/v1/p${index}`);
    await writeFile(join(docsDir, 'guide.md'), paths.join(' '));
    const specPath = join(work, 'spec.json');
    await writeFile(specPath, JSON.stringify(baseSpec({ '/v1/widgets': { get: okOperation() } })));
    const report = await runAudit({ specPath, docsPaths: [docsDir] });
    assert.ok(report.docs);
    assert.equal(report.docs.documentedPaths.length, MAX_DOC_PATHS);
    // The root names the partial scan, like the file cap.
    assert.ok(report.docs.skippedFiles.includes(docsDir));
    assert.ok(codes(report).has('DOC_FILES_SKIPPED'));
  });

  it('escapes spec-controlled text in the Markdown report', async () => {
    const spec = baseSpec({ '/v1/a': { get: okOperation() } });
    (spec['info'] as Spec)['title'] = 'Foo\n## Injected <script>alert(1)</script>';
    const work = await mkdtemp(join(tmpdir(), 'mcp-gen-report-'));
    const specPath = join(work, 'spec.json');
    await writeFile(specPath, JSON.stringify(spec));
    const markdown = renderMarkdown({ report: await runAudit({ specPath }) });
    assert.ok(!markdown.includes('\n## Injected'));
    assert.ok(markdown.includes('&lt;script&gt;'));
  });
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, type AuditReport } from '../src/index.js';

export const GENERATOR_PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url));
export const SOURCE_INDEX = new URL('../src/index.ts', import.meta.url).href;

/**
 * Accepts anything shaped like a tool result: `CallToolResult` from this
 * package, or a client `callTool` result (a union whose `content` is only
 * `unknown` on some branches), so the parameter stays `unknown`.
 */
export function text(result: unknown): string {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  const block = (Array.isArray(content) ? content : [])[0] as
    { type: string; text?: string } | undefined;
  assert.equal(block?.type, 'text');
  return block?.text ?? '';
}

/**
 * Stub the built artifact's dependencies in `<out>/node_modules`: a
 * re-exporting `@gideon/mcp-generator` stub (source via tsx) plus symlinks
 * to the repo's SDK and, optionally, zod. Kept in one place so the
 * artifact smoke tests exercise the same stub shape.
 */
export async function installStubs({
  out,
  withZod = false,
}: {
  out: string;
  withZod?: boolean;
}): Promise<void> {
  const generatorStub = join(out, 'node_modules', '@gideon', 'mcp-generator');
  await mkdir(generatorStub, { recursive: true });
  await writeFile(
    join(generatorStub, 'package.json'),
    JSON.stringify({ name: '@gideon/mcp-generator', type: 'module', exports: './index.js' }),
  );
  await writeFile(
    join(generatorStub, 'index.js'),
    `export * from ${JSON.stringify(SOURCE_INDEX)};\n`,
  );
  const packages = [
    {
      source: new URL('../node_modules/@modelcontextprotocol/sdk', import.meta.url),
      target: join(out, 'node_modules', '@modelcontextprotocol', 'sdk'),
    },
    ...(withZod
      ? [
          {
            source: new URL('../node_modules/zod', import.meta.url),
            target: join(out, 'node_modules', 'zod'),
          },
        ]
      : []),
  ];
  for (const { source, target } of packages) {
    await mkdir(dirname(target), { recursive: true });
    await symlink(fileURLToPath(source), target);
  }
}

export type Spec = Record<string, unknown>;

/** Minimal valid OpenAPI 3.0 document around the given path items. */
export function baseSpec(paths: Spec, extra: Spec = {}): Spec {
  return {
    openapi: '3.0.3',
    info: { title: 'Test API', version: '1.0.0' },
    servers: [{ url: 'https://api.example.test' }],
    paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    ...extra,
  };
}

/** A fully described operation with a 200 response; override as needed. */
export function okOperation(extra: Spec = {}): Spec {
  return {
    operationId: 'getThing',
    summary: 'Get thing',
    description: 'Get a thing.',
    responses: { '200': { description: 'OK' } },
    ...extra,
  };
}

/** An operation whose 200 response carries the given JSON schema. */
export function jsonResponse(schema: Spec): Spec {
  return okOperation({
    responses: {
      '200': { description: 'OK', content: { 'application/json': { schema } } },
    },
  });
}

export function codes(report: AuditReport): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

/**
 * Audit specs written into one lazily created temp directory, so a test
 * file needs no shared `before`/`dir` boilerplate of its own.
 */
export function createAudit({ prefix }: { prefix: string }): {
  audit: ({ spec, name }: { spec: Spec | string; name?: string }) => Promise<AuditReport>;
} {
  let dir: string | undefined;
  return {
    audit: async ({ spec, name = 'spec.json' }: { spec: Spec | string; name?: string }) => {
      dir ??= await mkdtemp(join(tmpdir(), prefix));
      const filePath = join(dir, `${Math.random().toString(36).slice(2)}-${name}`);
      await writeFile(filePath, typeof spec === 'string' ? spec : JSON.stringify(spec));
      return runAudit({ specPath: filePath });
    },
  };
}

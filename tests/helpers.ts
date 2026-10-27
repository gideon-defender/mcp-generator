import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAudit, type AuditReport } from '../src/index.js';

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

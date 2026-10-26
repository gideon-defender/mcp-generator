import type { AuditReport, Finding, Severity } from './types.js';

export const SEVERITY_ORDER: Record<Severity, number> = {
  blocker: 0,
  compat31: 1,
  warning: 2,
  info: 3,
};

export function sortFindings({ findings }: { findings: Finding[] }): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.location.localeCompare(b.location) ||
      a.message.localeCompare(b.message),
  );
}

function escapeCell(value: string): string {
  return sanitizeInline(value).replace(/\|/g, '\\|');
}

/** Neutralise spec-controlled text used outside tables (headings, lists, logs). */
export function sanitizeInline(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, "'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

export function renderMarkdown({ report }: { report: AuditReport }): string {
  const { spec, summary } = report;
  const lines: string[] = [
    '# MCP Generator Audit — Phase 0',
    '',
    `- Spec: \`${sanitizeInline(spec.path)}\``,
    `- Title: ${sanitizeInline(spec.title)} (API version ${sanitizeInline(spec.version)})`,
    `- OpenAPI: ${sanitizeInline(spec.openapi)} · Format: ${sanitizeInline(spec.format)} · SHA-256: \`${sanitizeInline(spec.sha256)}\``,
    `- Servers: ${spec.servers.length > 0 ? spec.servers.map((server) => sanitizeInline(server)).join(', ') : '(none declared)'}`,
    `- Readiness: **${summary.readiness}**`,
    '',
    '## Summary',
    '',
    '| Metric | Count |',
    '|---|---|',
    `| Paths | ${summary.paths} |`,
    `| Operations | ${summary.operations} |`,
    `| Read operations | ${summary.readOperations} |`,
    `| Mutate operations | ${summary.mutateOperations} |`,
    `| Blockers | ${summary.findingsBySeverity.blocker} |`,
    `| OpenAPI 3.1 constructs (compat31) | ${summary.findingsBySeverity.compat31} |`,
    `| Warnings | ${summary.findingsBySeverity.warning} |`,
    `| Info | ${summary.findingsBySeverity.info} |`,
    '',
    '## Findings by code',
    '',
    '| Code | Count |',
    '|---|---|',
    ...Object.entries(summary.findingsByCode).map(
      ([code, count]) => `| ${escapeCell(code)} | ${count} |`,
    ),
    '',
    '## Operations',
    '',
    '| Tool (derived) | Method | Path | Class | Operation ID |',
    '|---|---|---|---|---|',
    ...report.operations.map(
      (op) =>
        `| ${escapeCell(op.derivedToolName)} | ${op.method.toUpperCase()} | ${escapeCell(op.path)} | ${op.classification} | ${escapeCell(op.operationId ?? '(missing)')} |`,
    ),
    '',
    '## Findings',
    '',
    '| Severity | Code | Location | Message |',
    '|---|---|---|---|',
    ...report.findings.map(
      (finding) =>
        `| ${escapeCell(finding.severity)} | ${escapeCell(finding.code)} | ${escapeCell(finding.location)} | ${escapeCell(finding.message)} |`,
    ),
  ];
  if (report.docs) {
    lines.push(
      '',
      '## Docs cross-reference',
      '',
      `- Documented paths: ${report.docs.documentedPaths.length}`,
      `- Documented but not in spec (${report.docs.documentedNotInSpec.length}): ${report.docs.documentedNotInSpec.map((path) => sanitizeInline(path)).join(', ') || 'none'}`,
      `- In spec but not documented (${report.docs.specNotDocumented.length}): ${report.docs.specNotDocumented.map((path) => sanitizeInline(path)).join(', ') || 'none'}`,
    );
  }
  lines.push(
    '',
    '## Reading this report',
    '',
    '- **blocker** — cannot be represented faithfully as an MCP tool by the baseline generator; fix the spec or add a generic core capability.',
    '- **compat31** — valid OpenAPI 3.1 / JSON Schema 2020-12 construct that a 3.0-only compiler rejects; requires native 3.1 support (Phase 3 of the generalization plan).',
    '- **warning** — generatable, but needs a product policy decision (allowlist, redaction, upload pattern, auth adapter).',
    '- Derived tool names are a fallback. Curated products pin explicit names in their overlay; duplicates above are blockers until pinned.',
    '',
  );
  return lines.join('\n');
}

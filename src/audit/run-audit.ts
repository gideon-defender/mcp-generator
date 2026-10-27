import { crossReferenceDocs } from './docs.js';
import { buildInventory, operationEntries } from './inventory.js';
import { loadSpec } from './load-spec.js';
import { operationChecks } from './operation-checks.js';
import { sortFindings } from './report.js';
import { MAX_REPORT_BYTES, ReportBudget, estimateJsonBytes } from './report-size.js';
import { schemaChecks } from './schema-entries.js';
import type { AuditReport, AuditSummary, Finding, Severity } from './types.js';

export { MAX_REPORT_BYTES } from './report-size.js';

export const TOOL_NAME = '@gideon/mcp-generator';
export const TOOL_VERSION = '0.1.0';

function summarize({
  paths,
  operations,
  findings,
}: {
  paths: number;
  operations: AuditReport['operations'];
  findings: Finding[];
}): AuditSummary {
  const findingsBySeverity: Record<Severity, number> = {
    blocker: 0,
    compat31: 0,
    warning: 0,
    info: 0,
  };
  const findingsByCode: Record<string, number> = {};
  for (const finding of findings) {
    findingsBySeverity[finding.severity] += 1;
    findingsByCode[finding.code] = (findingsByCode[finding.code] ?? 0) + 1;
  }
  let readiness: AuditSummary['readiness'] = 'ready';
  if (findingsBySeverity.warning > 0) readiness = 'ready-with-warnings';
  if (findingsBySeverity.compat31 > 0) readiness = 'needs-31-support';
  if (findingsBySeverity.blocker > 0) readiness = 'blocked';
  return {
    paths,
    operations: operations.length,
    readOperations: operations.filter((op) => op.classification === 'read').length,
    mutateOperations: operations.filter((op) => op.classification === 'mutate').length,
    findingsBySeverity,
    findingsByCode: Object.fromEntries(
      Object.entries(findingsByCode).sort(([a], [b]) => a.localeCompare(b)),
    ),
    readiness,
  };
}

/**
 * Phase 0 audit: inventory every operation and catalogue everything that
 * prevents (or conditions) faithful MCP generation from this spec.
 * Works with any OpenAPI 3.0.x or 3.1.x document, JSON or YAML.
 */
export async function runAudit({
  specPath,
  docsPaths = [],
}: {
  specPath: string;
  docsPaths?: string[];
}): Promise<AuditReport> {
  const loaded = await loadSpec({ filePath: specPath });
  const { entries, findings: entryFindings } = operationEntries({ document: loaded.document });
  // Charge every record and finding to one budget as it is created.
  // A shared path item expands across many operations, so a single
  // check at the end lets the full expansion build in memory first.
  const budget = new ReportBudget({});
  const findings: Finding[] = [];
  for (const message of loaded.parseIssues) {
    const finding: Finding = {
      code: 'SPEC_PARSE_ISSUE',
      severity: 'blocker',
      category: 'spec',
      message: `Parser issue (later value wins): ${message}`,
      location: '(document)',
    };
    budget.add({ value: finding });
    findings.push(finding);
  }
  for (const message of loaded.flowCommaIssues) {
    const finding: Finding = {
      code: 'SPEC_YAML_FLOW_COMMA',
      severity: 'warning',
      category: 'spec',
      message,
      location: '(document)',
    };
    budget.add({ value: finding });
    findings.push(finding);
  }
  for (const finding of entryFindings) {
    budget.add({ value: finding });
    findings.push(finding);
  }
  const operations = buildInventory({ document: loaded.document, entries, budget });
  // Append in a loop, not with spread: a hostile spec can mint more
  // findings than the call stack accepts as arguments, and the audit
  // must end with the budget error, not a RangeError.
  for (const finding of operationChecks({
    document: loaded.document,
    entries,
    inventory: operations,
    budget,
  })) {
    findings.push(finding);
  }
  for (const finding of schemaChecks({
    document: loaded.document,
    is31: loaded.is31,
    entries,
    budget,
  })) {
    findings.push(finding);
  }
  let docs: AuditReport['docs'];
  if (docsPaths.length > 0) {
    docs = await crossReferenceDocs({
      roots: docsPaths,
      specPaths: [...new Set(operations.map((op) => op.path))],
    });
    if (docs.skippedFiles.length > 0) {
      findings.push({
        code: 'DOC_FILES_SKIPPED',
        severity: 'info',
        category: 'docs',
        message: `${docs.skippedFiles.length} docs file(s) could not be read and were skipped: ${docs.skippedFiles.join(', ')}`,
        location: '(docs)',
      });
    }
    if (docs.documentedNotInSpec.length > 0) {
      findings.push({
        code: 'DOC_NOT_IN_SPEC',
        severity: 'warning',
        category: 'docs',
        message: `${docs.documentedNotInSpec.length} documented path(s) are not in the spec: ${docs.documentedNotInSpec.join(', ')}`,
        location: '(docs)',
      });
    }
    if (docs.specNotDocumented.length > 0) {
      findings.push({
        code: 'DOC_UNDOCUMENTED',
        severity: 'info',
        category: 'docs',
        message: `${docs.specNotDocumented.length} spec path(s) are not mentioned in the supplied docs`,
        location: '(docs)',
      });
    }
  }
  const sorted = sortFindings({ findings });
  const pathsCount = Object.keys(
    (loaded.document['paths'] as Record<string, unknown> | undefined) ?? {},
  ).filter((path) => !path.startsWith('x-')).length;
  const report: AuditReport = {
    tool: { name: TOOL_NAME, version: TOOL_VERSION, phase: '0-audit' },
    spec: {
      path: specPath,
      format: loaded.format,
      sha256: loaded.sha256,
      openapi: loaded.openApiVersion,
      title: loaded.title,
      version: loaded.specVersion,
      servers: loaded.servers,
    },
    summary: summarize({ paths: pathsCount, operations, findings: sorted }),
    operations,
    findings: sorted,
    ...(docs ? { docs } : {}),
  };
  if (docs) budget.add({ value: docs });
  // Final check covers the report shell (tool, spec, summary) that the
  // per-record budget does not charge.
  const reportBytes = estimateJsonBytes({ value: report });
  if (reportBytes > MAX_REPORT_BYTES) {
    throw new Error(
      `Audit report would be about ${reportBytes} bytes; the limit is ${MAX_REPORT_BYTES} bytes`,
    );
  }
  return report;
}

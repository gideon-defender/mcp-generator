export { loadSpec, type LoadedSpec } from './audit/load-spec.js';
export { deriveToolName } from './audit/names.js';
export { renderMarkdown, sanitizeInline } from './audit/report.js';
export { runAudit, TOOL_NAME, TOOL_VERSION } from './audit/run-audit.js';
export type {
  AuditReport,
  AuditSummary,
  DocsCrossReference,
  Finding,
  OperationInventory,
  Severity,
} from './audit/types.js';

export type JsonObject = Record<string, unknown>;

export type Severity = 'blocker' | 'warning' | 'compat31' | 'info';

export type Finding = {
  code: string;
  severity: Severity;
  category: string;
  message: string;
  /** JSON Pointer to the offending node, e.g. /paths/~1v1~1users/get */
  location: string;
  operationId?: string;
  method?: string;
  path?: string;
};

export type OperationInventory = {
  operationId: string | null;
  method: string;
  path: string;
  tags: string[];
  summary: string | null;
  description: string | null;
  derivedToolName: string;
  classification: 'read' | 'mutate';
  security: string[];
  parameters: { name: string; in: string; required: boolean }[];
  requestContentTypes: string[];
  responseContentTypes: string[];
  responseStatuses: string[];
  deprecated: boolean;
};

export type DocsCrossReference = {
  roots: string[];
  skippedFiles: string[];
  documentedPaths: string[];
  documentedNotInSpec: string[];
  specNotDocumented: string[];
};

export type AuditSummary = {
  paths: number;
  operations: number;
  readOperations: number;
  mutateOperations: number;
  findingsBySeverity: Record<Severity, number>;
  findingsByCode: Record<string, number>;
  readiness: 'ready' | 'ready-with-warnings' | 'needs-31-support' | 'blocked';
};

export type AuditReport = {
  tool: { name: string; version: string; phase: string };
  spec: {
    path: string;
    format: 'json' | 'yaml';
    sha256: string;
    openapi: string;
    title: string;
    version: string;
    servers: string[];
  };
  summary: AuditSummary;
  operations: OperationInventory[];
  findings: Finding[];
  docs?: DocsCrossReference;
};

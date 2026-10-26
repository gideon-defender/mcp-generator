import { stringField } from './load-spec.js';
import { escapePointer, type RawOperation } from './inventory.js';
import {
  checkParameters,
  checkRequestBody,
  checkResponses,
  type OperationContext,
} from './operation-rules.js';
import type { ReportBudget } from './report-size.js';
import type { Finding, JsonObject, OperationInventory } from './types.js';

export function operationChecks({
  document,
  entries,
  inventory,
  budget,
}: {
  document: JsonObject;
  entries: RawOperation[];
  inventory: OperationInventory[];
  budget?: ReportBudget;
}): Finding[] {
  const findings: Finding[] = [];
  const push = (finding: Finding) => {
    budget?.add({ value: finding });
    findings.push(finding);
  };

  const byName = new Map<string, OperationInventory[]>();
  for (const op of inventory) {
    const list = byName.get(op.derivedToolName) ?? [];
    list.push(op);
    byName.set(op.derivedToolName, list);
  }
  for (const [name, ops] of byName) {
    if (ops.length < 2) continue;
    for (const op of ops) {
      push({
        code: 'NAME_DUPLICATE',
        severity: 'blocker',
        category: 'naming',
        message: `Derived tool name "${name}" is produced by ${ops.length} operations; pin explicit names`,
        location: `/paths/${escapePointer(op.path)}/${op.method}`,
        ...(op.operationId ? { operationId: op.operationId } : {}),
        method: op.method,
        path: op.path,
      });
    }
  }

  const componentsRaw = document['components'];
  const components: JsonObject =
    typeof componentsRaw === 'object' && componentsRaw !== null && !Array.isArray(componentsRaw)
      ? (componentsRaw as JsonObject)
      : {};
  const schemesRaw = components['securitySchemes'];
  const schemes =
    typeof schemesRaw === 'object' && schemesRaw !== null && !Array.isArray(schemesRaw)
      ? (schemesRaw as JsonObject)
      : {};
  let anySecurity = false;

  for (const entry of entries) {
    const { operation, method, path, location } = entry;
    const operationId = stringField({ object: operation, key: 'operationId' });
    const context: OperationContext = {
      ...(operationId ? { operationId } : {}),
      method,
      path,
    };
    if (!operationId) {
      push({
        code: 'OP_MISSING_ID',
        severity: 'blocker',
        category: 'operation',
        message: 'Operation has no operationId; a stable tool name cannot be derived reliably',
        location,
        ...context,
      });
    }
    if (!stringField({ object: operation, key: 'summary' })) {
      push({
        code: 'OP_MISSING_SUMMARY',
        severity: 'warning',
        category: 'operation',
        message: 'Operation has no summary; MCP tool title/description will be weak',
        location,
        ...context,
      });
    }
    if (!stringField({ object: operation, key: 'description' })) {
      push({
        code: 'OP_MISSING_DESCRIPTION',
        severity: 'warning',
        category: 'operation',
        message: 'Operation has no description; agents cannot reliably discover this tool',
        location,
        ...context,
      });
    }
    if (operation['deprecated'] === true) {
      push({
        code: 'OP_DEPRECATED',
        severity: 'info',
        category: 'operation',
        message: 'Operation is deprecated',
        location,
        ...context,
      });
    }
    checkParameters({ document, entry, push, context });
    checkRequestBody({ operation, location, push, context });
    checkResponses({ document, operation, location, push, context });
    const securityRaw = operation['security'] ?? document['security'];
    if (securityRaw !== undefined && !Array.isArray(securityRaw)) {
      push({
        code: 'SECURITY_INVALID',
        severity: 'blocker',
        category: 'security',
        message: 'Security field is not an array; its requirements cannot be mapped to auth',
        location,
        ...context,
      });
    }
    if (Array.isArray(securityRaw) && securityRaw.length > 0) {
      for (const requirement of securityRaw) {
        if (typeof requirement !== 'object' || requirement === null || Array.isArray(requirement)) {
          push({
            code: 'SECURITY_INVALID',
            severity: 'blocker',
            category: 'security',
            message:
              'Security requirement is not an object; it names no scheme the auth adapter can use',
            location,
            ...context,
          });
          continue;
        }
        // Only a readable requirement counts as security present. A
        // malformed entry (an array, a string) names no scheme, so it
        // must not suppress the SECURITY_NOT_DEFINED warning below.
        anySecurity = true;
        for (const schemeName of Object.keys(requirement as JsonObject)) {
          if (!Object.hasOwn(schemes, schemeName)) {
            push({
              code: 'SECURITY_SCHEME_UNDEFINED',
              severity: 'blocker',
              category: 'security',
              message: `Security scheme is referenced but not defined: ${schemeName}`,
              location,
              ...context,
            });
          }
        }
      }
    }
  }
  if (!anySecurity && Object.keys(schemes).length === 0) {
    push({
      code: 'SECURITY_NOT_DEFINED',
      severity: 'warning',
      category: 'security',
      message:
        'Document defines no security schemes; the auth adapter cannot be derived from the spec',
      location: '/',
    });
  }
  if (!Array.isArray(document['servers']) || document['servers'].length === 0) {
    push({
      code: 'SERVER_MISSING',
      severity: 'warning',
      category: 'server',
      message: 'Document declares no servers; the upstream base URL must come from product config',
      location: '/servers',
    });
  }
  if (typeof document['webhooks'] === 'object' && document['webhooks'] !== null) {
    push({
      code: 'TOPLEVEL_WEBHOOKS_IGNORED',
      severity: 'info',
      category: 'spec',
      message: 'Top-level webhooks are not converted into MCP tools',
      location: '/webhooks',
    });
  }
  return findings;
}

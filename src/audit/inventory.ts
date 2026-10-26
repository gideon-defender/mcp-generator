import { asObject, stringField } from './load-spec.js';
import { deriveToolName } from './names.js';
import { collectParameters } from './parameters.js';
import { resolveRefChain } from './refs.js';
import type { ReportBudget } from './report-size.js';
import type { Finding, JsonObject, OperationInventory } from './types.js';

export const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export type RawOperation = {
  path: string;
  method: string;
  operation: JsonObject;
  pathItem: JsonObject;
  location: string;
};

export function operationEntries({ document }: { document: JsonObject }): {
  entries: RawOperation[];
  findings: Finding[];
} {
  const paths = asObject({ value: document['paths'] ?? {}, location: '#/paths' });
  const entries: RawOperation[] = [];
  const findings: Finding[] = [];
  for (const [path, itemValue] of Object.entries(paths)) {
    // Specification extensions (x-*) are not path items.
    if (path.startsWith('x-')) continue;
    const pathLocation = `/paths/${escapePointer(path)}`;
    if (typeof itemValue !== 'object' || itemValue === null || Array.isArray(itemValue)) {
      findings.push({
        code: 'PATH_ITEM_INVALID',
        severity: 'blocker',
        category: 'operation',
        message: 'Path item is not an object; its operations were skipped',
        location: pathLocation,
        path,
      });
      continue;
    }
    const resolvedItem = resolveRefChain({ document, value: itemValue });
    if (!resolvedItem.object) {
      findings.push({
        code: 'PATH_ITEM_REF_UNSUPPORTED',
        severity: 'blocker',
        category: 'operation',
        message: `Path item $ref could not be resolved (${resolvedItem.reason ?? 'dangling'}): ${resolvedItem.ref ?? ''}`,
        location: pathLocation,
        path,
      });
      continue;
    }
    const pathItem = resolvedItem.object;
    for (const method of METHODS) {
      const operationValue = pathItem[method];
      if (operationValue === undefined) continue;
      if (
        typeof operationValue !== 'object' ||
        operationValue === null ||
        Array.isArray(operationValue)
      ) {
        findings.push({
          code: 'OPERATION_INVALID',
          severity: 'blocker',
          category: 'operation',
          message: 'Operation is not an object; it was skipped',
          location: `${pathLocation}/${method}`,
          method,
          path,
        });
        continue;
      }
      entries.push({
        path,
        method,
        operation: operationValue as JsonObject,
        pathItem,
        location: `${pathLocation}/${method}`,
      });
    }
  }
  return { entries, findings };
}

function securityNames({
  operation,
  document,
}: {
  operation: JsonObject;
  document: JsonObject;
}): string[] {
  const raw = operation['security'] ?? document['security'];
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const requirement of raw) {
    // An array is not a requirement object; its index keys ("0", ...)
    // are not scheme names.
    if (typeof requirement !== 'object' || requirement === null || Array.isArray(requirement))
      continue;
    names.push(...Object.keys(requirement as JsonObject));
  }
  return [...new Set(names)];
}

function contentTypes({
  container,
  document,
}: {
  container: unknown;
  document: JsonObject;
}): string[] {
  const resolved = resolveRefChain({ document, value: container });
  if (!resolved.object) return [];
  const content = resolved.object['content'];
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return [];
  return Object.keys(content as JsonObject).sort();
}

export function buildInventory({
  document,
  entries,
  budget,
}: {
  document: JsonObject;
  entries: RawOperation[];
  budget?: ReportBudget;
}): OperationInventory[] {
  const operations: OperationInventory[] = [];
  for (const entry of entries) {
    const { path, method, operation } = entry;
    const operationId = stringField({ object: operation, key: 'operationId' }) ?? null;
    const parameters = collectParameters({
      document,
      pathItem: entry.pathItem,
      operation,
    }).flatMap((collected) => {
      if (collected.resolution) return [];
      const name = stringField({ object: collected.param, key: 'name' });
      const location = stringField({ object: collected.param, key: 'in' });
      if (!name || !location) return [];
      return [{ name, in: location, required: collected.param['required'] === true }];
    });
    const responses =
      typeof operation['responses'] === 'object' &&
      operation['responses'] !== null &&
      !Array.isArray(operation['responses'])
        ? (operation['responses'] as JsonObject)
        : {};
    const responseContentTypes = [
      ...new Set(
        Object.entries(responses)
          // Specification extensions (x-*) are not responses.
          .filter(([status]) => !status.startsWith('x-'))
          .flatMap(([, response]) => contentTypes({ container: response, document })),
      ),
    ].sort();
    const tagsRaw = Array.isArray(operation['tags']) ? operation['tags'] : [];
    const record: OperationInventory = {
      operationId,
      method,
      path,
      tags: tagsRaw.filter((tag): tag is string => typeof tag === 'string'),
      summary: stringField({ object: operation, key: 'summary' }) ?? null,
      description: stringField({ object: operation, key: 'description' }) ?? null,
      derivedToolName: deriveToolName({ operationId, method, path }),
      classification: ['get', 'head', 'options'].includes(method) ? 'read' : 'mutate',
      security: securityNames({ operation, document }),
      parameters,
      requestContentTypes: contentTypes({ container: operation['requestBody'], document }),
      responseContentTypes,
      responseStatuses: Object.keys(responses)
        .filter((status) => !status.startsWith('x-'))
        .sort(),
      deprecated: operation['deprecated'] === true,
    };
    // Charge each record as it is built. A path item shared by many
    // paths repeats its text in every record, so the report cap must
    // trip here, not after every record already exists.
    budget?.add({ value: record });
    operations.push(record);
  }
  return operations;
}

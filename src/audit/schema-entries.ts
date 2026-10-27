import { escapePointer, type RawOperation } from './inventory.js';
import { collectParameters } from './parameters.js';
import { resolveRefChain } from './refs.js';
import type { ReportBudget } from './report-size.js';
import { walkSchema } from './schema-checks.js';
import type { Finding, JsonObject } from './types.js';

type Push = (finding: Finding) => void;

function walkSchemaOnce({
  schema,
  location,
  document,
  is31,
  push,
  seen,
}: {
  schema: unknown;
  location: string;
  document: JsonObject;
  is31: boolean;
  push: Push;
  seen: Set<object>;
}): void {
  // Hand the shared set to the walker itself, not just to this root check:
  // a schema reused in a nested position must also be checked only once.
  walkSchema({ schema, location, document, is31, push, visited: seen });
}

function walkContent({
  container,
  location,
  document,
  is31,
  push,
  seen,
}: {
  container: unknown;
  location: string;
  document: JsonObject;
  is31: boolean;
  push: Push;
  seen: Set<object>;
}): void {
  if (typeof container !== 'object' || container === null) return;
  const content = (container as JsonObject)['content'];
  if (typeof content !== 'object' || content === null) return;
  for (const [mime, mediaValue] of Object.entries(content as JsonObject)) {
    if (typeof mediaValue !== 'object' || mediaValue === null) continue;
    walkSchemaOnce({
      schema: (mediaValue as JsonObject)['schema'],
      location: `${location}/content/${escapePointer(mime)}/schema`,
      document,
      is31,
      push,
      seen,
    });
  }
}

function walkHeaders({
  container,
  location,
  document,
  is31,
  push,
  seen,
}: {
  container: JsonObject;
  location: string;
  document: JsonObject;
  is31: boolean;
  push: Push;
  seen: Set<object>;
}): void {
  const headers = container['headers'];
  if (typeof headers !== 'object' || headers === null) return;
  for (const [name, headerValue] of Object.entries(headers as JsonObject)) {
    const headerLocation = `${location}/headers/${escapePointer(name)}`;
    const resolved = resolveRefChain({ document, value: headerValue });
    if (!resolved.object) {
      push({
        code: 'HEADER_REF_UNSUPPORTED',
        severity: 'blocker',
        category: 'response',
        message: `Response header $ref could not be resolved (${resolved.reason ?? 'dangling'}): ${resolved.ref}`,
        location: headerLocation,
      });
      continue;
    }
    walkSchemaOnce({
      schema: resolved.object['schema'],
      location: `${headerLocation}/schema`,
      document,
      is31,
      push,
      seen,
    });
    // A header can carry its schema under `content` instead of
    // `schema`. Walk that form too, as parameters already do.
    walkContent({
      container: resolved.object,
      location: headerLocation,
      document,
      is31,
      push,
      seen,
    });
  }
}

/** Resolve a possibly `$ref`d request/response object, then walk its content. */
function walkResolved({
  value,
  location,
  document,
  is31,
  push,
  seen,
}: {
  value: unknown;
  location: string;
  document: JsonObject;
  is31: boolean;
  push: Push;
  seen: Set<object>;
}): void {
  const resolved = resolveRefChain({ document, value });
  if (!resolved.object) return;
  walkContent({ container: resolved.object, location, document, is31, push, seen });
  walkHeaders({ container: resolved.object, location, document, is31, push, seen });
}

function walkComponents({
  document,
  is31,
  push,
  seen,
}: {
  document: JsonObject;
  is31: boolean;
  push: Push;
  seen: Set<object>;
}): void {
  const componentsRaw = document['components'];
  const components: JsonObject =
    typeof componentsRaw === 'object' && componentsRaw !== null && !Array.isArray(componentsRaw)
      ? (componentsRaw as JsonObject)
      : {};
  const schemas = components['schemas'];
  if (typeof schemas === 'object' && schemas !== null) {
    for (const [name, value] of Object.entries(schemas as JsonObject)) {
      walkSchemaOnce({
        schema: value,
        location: `/components/schemas/${escapePointer(name)}`,
        document,
        is31,
        push,
        seen,
      });
    }
  }
  for (const section of ['parameters', 'requestBodies', 'responses', 'headers'] as const) {
    const entries = components[section];
    if (typeof entries !== 'object' || entries === null) continue;
    for (const [name, value] of Object.entries(entries as JsonObject)) {
      const location = `/components/${section}/${escapePointer(name)}`;
      const resolved = resolveRefChain({ document, value });
      if (!resolved.object) {
        // Every section reports its own bad reference. A silent drop
        // here would let a dangling component pass the audit as long
        // as no operation uses it.
        const codes = {
          parameters: ['PARAM_REF_UNSUPPORTED', 'parameter', 'Parameter'],
          requestBodies: ['BODY_REF_UNSUPPORTED', 'request-body', 'Request body'],
          responses: ['RESPONSE_REF_UNSUPPORTED', 'response', 'Response'],
          headers: ['HEADER_REF_UNSUPPORTED', 'response', 'Response header'],
        } as const;
        const [code, category, label] = codes[section];
        push({
          code,
          severity: 'blocker',
          category,
          message: `${label} $ref could not be resolved (${resolved.reason ?? 'dangling'}): ${resolved.ref}`,
          location,
        });
        continue;
      }
      walkSchemaOnce({
        schema: resolved.object['schema'],
        location: `${location}/schema`,
        document,
        is31,
        push,
        seen,
      });
      walkContent({ container: resolved.object, location, document, is31, push, seen });
      walkHeaders({ container: resolved.object, location, document, is31, push, seen });
    }
  }
}

export function schemaChecks({
  document,
  is31,
  entries,
  budget,
}: {
  document: JsonObject;
  is31: boolean;
  entries: RawOperation[];
  budget?: ReportBudget;
}): Finding[] {
  const findings: Finding[] = [];
  const push: Push = (finding) => {
    budget?.add({ value: finding });
    findings.push(finding);
  };
  // One shared identity set: a schema object reached first under components
  // and again under an operation is one fault, not two.
  const seen = new Set<object>();
  walkComponents({ document, is31, push, seen });
  for (const entry of entries) {
    const collected = collectParameters({
      document,
      pathItem: entry.pathItem,
      operation: entry.operation,
    });
    for (const collectedParam of collected) {
      if (collectedParam.resolution) continue; // operation checks report this
      // The merged index is not a document position. Path-level parameters
      // live on the path item, not inside the operation node.
      const location =
        collectedParam.source === 'pathItem'
          ? `/paths/${escapePointer(entry.path)}/parameters/${collectedParam.index}`
          : `${entry.location}/parameters/${collectedParam.index}`;
      walkSchemaOnce({
        schema: collectedParam.param['schema'],
        location: `${location}/schema`,
        document,
        is31,
        push,
        seen,
      });
      walkContent({ container: collectedParam.param, location, document, is31, push, seen });
    }
    walkResolved({
      value: entry.operation['requestBody'],
      location: `${entry.location}/requestBody`,
      document,
      is31,
      push,
      seen,
    });
    const responses = entry.operation['responses'];
    if (typeof responses === 'object' && responses !== null && !Array.isArray(responses)) {
      for (const [status, response] of Object.entries(responses as JsonObject)) {
        // Specification extensions (x-*) are not responses.
        if (status.startsWith('x-')) continue;
        walkResolved({
          value: response,
          location: `${entry.location}/responses/${escapePointer(status)}`,
          document,
          is31,
          push,
          seen,
        });
      }
    }
  }
  return findings;
}

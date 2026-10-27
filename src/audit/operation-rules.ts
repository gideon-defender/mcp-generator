import { escapePointer, type RawOperation } from './inventory.js';
import { stringField } from './load-spec.js';
import { collectParameters } from './parameters.js';
import { resolveRefChain } from './refs.js';
import type { Finding, JsonObject } from './types.js';

export type OperationContext = {
  operationId?: string;
  method: string;
  path: string;
};

type Push = (finding: Finding) => void;

const RESERVED_HEADERS = new Set([
  'authorization',
  'accept',
  'cookie',
  'x-api-key',
  'apikey',
  'host',
  'content-type',
]);

function normalizeMime({ mime }: { mime: string }): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

// Duplicate declarations in one parameters list, memoised per document
// by list identity. A shared path item serves many operations; scanning
// its list again for every operation repeats work that cannot change
// while the document is immutable for the duration of an audit.
const duplicatesByDocument = new WeakMap<
  JsonObject,
  WeakMap<object, { name: string; locationIn: string }[]>
>();

function duplicateParameters({
  document,
  list,
}: {
  document: JsonObject;
  list: unknown[];
}): { name: string; locationIn: string }[] {
  let byList = duplicatesByDocument.get(document);
  if (!byList) {
    byList = new WeakMap();
    duplicatesByDocument.set(document, byList);
  }
  const cached = byList.get(list);
  if (cached) return cached;
  const duplicates: { name: string; locationIn: string }[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const resolved = resolveRefChain({ document, value: raw });
    if (!resolved.object) continue;
    const name = stringField({ object: resolved.object, key: 'name' });
    const locationIn = stringField({ object: resolved.object, key: 'in' });
    if (!name || !locationIn) continue;
    const key = `${locationIn}:${name}`;
    if (seen.has(key)) duplicates.push({ name, locationIn });
    seen.add(key);
  }
  byList.set(list, duplicates);
  return duplicates;
}

function checkDuplicateParameters({
  document,
  entry,
  push,
  context,
}: {
  document: JsonObject;
  entry: RawOperation;
  push: Push;
  context: OperationContext;
}): void {
  const sources: { list: unknown; location: string }[] = [
    { list: entry.pathItem['parameters'], location: `/paths/${escapePointer(entry.path)}` },
    { list: entry.operation['parameters'], location: entry.location },
  ];
  for (const { list, location } of sources) {
    if (!Array.isArray(list)) continue;
    for (const { name, locationIn } of duplicateParameters({ document, list })) {
      push({
        code: 'PARAM_DUPLICATE',
        severity: 'blocker',
        category: 'parameter',
        message: `Parameter "${name}" in "${locationIn}" is declared more than once in the same parameters list`,
        location,
        ...context,
      });
    }
  }
}

export function checkParameters({
  document,
  entry,
  push,
  context,
}: {
  document: JsonObject;
  entry: RawOperation;
  push: Push;
  context: OperationContext;
}): void {
  const { location } = entry;
  // A parameters field that is not an array holds no usable parameter.
  // The collector skips it, so flag the shape here or the operation
  // passes with an empty parameter list.
  for (const [list, listLocation] of [
    [entry.pathItem['parameters'], `/paths/${escapePointer(entry.path)}`],
    [entry.operation['parameters'], location],
  ] as const) {
    if (list !== undefined && !Array.isArray(list)) {
      push({
        code: 'PARAMETERS_INVALID',
        severity: 'blocker',
        category: 'parameter',
        message:
          'Parameters field is not an array; its parameters cannot be mapped to tool arguments',
        location: listLocation,
        ...context,
      });
    }
  }
  checkDuplicateParameters({ document, entry, push, context });
  const collectedParameters = collectParameters({
    document,
    pathItem: entry.pathItem,
    operation: entry.operation,
  });
  for (const collected of collectedParameters) {
    if (collected.resolution) {
      push({
        code: 'PARAM_REF_UNSUPPORTED',
        severity: 'blocker',
        category: 'parameter',
        message: `Parameter $ref could not be resolved (${collected.resolution.reason}): ${collected.resolution.ref}`,
        location,
        ...context,
      });
      continue;
    }
    const param = collected.param;
    // OpenAPI requires `name` on every parameter. Without one the
    // parameter cannot become a tool argument, and the inventory drops
    // it silently, so the missing name must block on its own.
    const rawName = stringField({ object: param, key: 'name' });
    if (!rawName) {
      push({
        code: 'PARAM_NAME_MISSING',
        severity: 'blocker',
        category: 'parameter',
        message: 'Parameter has no name; it cannot be mapped to a tool argument',
        location,
        ...context,
      });
      continue;
    }
    const name = rawName;
    const locationIn = stringField({ object: param, key: 'in' }) ?? '';
    if (!['path', 'query', 'header'].includes(locationIn)) {
      push({
        code: 'PARAM_LOCATION_UNSUPPORTED',
        severity: 'blocker',
        category: 'parameter',
        message: `Parameter "${name}" uses unsupported location "${locationIn || '(missing)'}"`,
        location,
        ...context,
      });
      continue;
    }
    if (param['content'] !== undefined) {
      push({
        code: 'PARAM_CONTENT_UNSUPPORTED',
        severity: 'blocker',
        category: 'parameter',
        message: `Parameter "${name}" uses content-based encoding`,
        location,
        ...context,
      });
    }
    if (param['allowReserved'] === true) {
      push({
        code: 'PARAM_ALLOW_RESERVED',
        severity: 'blocker',
        category: 'parameter',
        message: `Parameter "${name}" sets allowReserved`,
        location,
        ...context,
      });
    }
    // Only an absent style takes the location default. A present style
    // that is not a string is a broken declaration; defaulting it would
    // let the check below pass a parameter it never actually read.
    const rawStyle = param['style'];
    const style =
      typeof rawStyle === 'string'
        ? rawStyle
        : rawStyle === undefined
          ? locationIn === 'query'
            ? 'form'
            : 'simple'
          : '';
    const supported =
      locationIn === 'path'
        ? ['simple', 'label', 'matrix']
        : locationIn === 'header'
          ? ['simple']
          : ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'];
    if (!supported.includes(style)) {
      push({
        code: 'PARAM_STYLE_UNSUPPORTED',
        severity: 'blocker',
        category: 'parameter',
        message:
          rawStyle !== undefined && typeof rawStyle !== 'string'
            ? `Parameter "${name}" has a non-string style; its serialization cannot be mapped to a tool argument`
            : `Parameter "${name}" uses unsupported ${locationIn} style "${style}"`,
        location,
        ...context,
      });
    }
    if (locationIn === 'path' && param['required'] !== true) {
      push({
        code: 'PARAM_PATH_NOT_REQUIRED',
        severity: 'blocker',
        category: 'parameter',
        message: `Path parameter "${name}" is not marked required`,
        location,
        ...context,
      });
    }
    if (locationIn === 'header' && RESERVED_HEADERS.has(name.toLowerCase())) {
      push({
        code: 'PARAM_RESERVED_HEADER',
        severity: 'blocker',
        category: 'parameter',
        message: `Parameter "${name}" collides with a credential/reserved header`,
        location,
        ...context,
      });
    }
  }
  // The path template and the declared path parameters must name the
  // same set. A template name with no declaration has no value at call
  // time, and a declared name absent from the template never binds.
  const templateNames = new Set(
    [...entry.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? ''),
  );
  const declaredPathNames = new Set(
    collectedParameters.flatMap((collected) => {
      if (collected.resolution) return [];
      const name = stringField({ object: collected.param, key: 'name' });
      const locationIn = stringField({ object: collected.param, key: 'in' });
      return name && locationIn === 'path' ? [name] : [];
    }),
  );
  for (const name of templateNames) {
    if (declaredPathNames.has(name)) continue;
    push({
      code: 'PARAM_PATH_UNDECLARED',
      severity: 'blocker',
      category: 'parameter',
      message: `Path parameter "${name}" appears in the path but is not declared`,
      location,
      ...context,
    });
  }
  for (const name of declaredPathNames) {
    if (templateNames.has(name)) continue;
    push({
      code: 'PARAM_PATH_UNUSED',
      severity: 'blocker',
      category: 'parameter',
      message: `Path parameter "${name}" is declared but does not appear in the path`,
      location,
      ...context,
    });
  }
}

export function checkRequestBody({
  operation,
  location,
  push,
  context,
}: {
  operation: JsonObject;
  location: string;
  push: Push;
  context: OperationContext;
}): void {
  const requestBody = operation['requestBody'];
  if (requestBody === undefined) return;
  if (typeof requestBody !== 'object' || requestBody === null || Array.isArray(requestBody)) {
    push({
      code: 'BODY_INVALID',
      severity: 'blocker',
      category: 'request-body',
      message: 'Request body is not an object; its media types cannot be mapped to a tool argument',
      location,
      ...context,
    });
    return;
  }
  const body = requestBody as JsonObject;
  if (typeof body['$ref'] === 'string') {
    push({
      code: 'BODY_REF_UNSUPPORTED',
      severity: 'blocker',
      category: 'request-body',
      message: 'requestBody is a $ref; inline or resolve it before generation',
      location,
      ...context,
    });
  }
  const content = body['content'];
  const types =
    typeof content === 'object' && content !== null && !Array.isArray(content)
      ? Object.keys(content as JsonObject)
      : [];
  if (types.length === 0) {
    // A $ref body already drew BODY_REF_UNSUPPORTED above; a second
    // finding here would only repeat that fault in other words.
    if (typeof body['$ref'] !== 'string') {
      push({
        code: 'BODY_MIME_UNSUPPORTED',
        severity: 'blocker',
        category: 'request-body',
        message:
          'Request body declares no media types; add a JSON media type or use a presigned-upload/s3Key pattern instead',
        location,
        ...context,
      });
    }
  } else if (types.length > 1) {
    push({
      code: 'BODY_MULTIPLE_MIME',
      severity: 'warning',
      category: 'request-body',
      message: `Request body offers ${types.length} media types (${types.join(', ')}); a selection policy is required`,
      location,
      ...context,
    });
    const hasJson = types.some((rawMime) => {
      const mime = normalizeMime({ mime: rawMime });
      return mime === 'application/json' || mime.endsWith('+json');
    });
    if (!hasJson) {
      push({
        code: 'BODY_MIME_UNSUPPORTED',
        severity: 'blocker',
        category: 'request-body',
        message: `Request body offers no JSON media type (${types.join(', ')}); use a presigned-upload/s3Key pattern instead`,
        location,
        ...context,
      });
    }
  } else if (types.length === 1) {
    const [rawMime] = types;
    const mime = rawMime ? normalizeMime({ mime: rawMime }) : '';
    if (mime !== 'application/json' && !mime.endsWith('+json')) {
      push({
        code: 'BODY_MIME_UNSUPPORTED',
        severity: 'blocker',
        category: 'request-body',
        message: `Request body media type is not JSON: ${mime ?? ''} (use a presigned-upload/s3Key pattern instead)`,
        location,
        ...context,
      });
    }
  }
}

export function checkResponses({
  document,
  operation,
  location,
  push,
  context,
}: {
  document: JsonObject;
  operation: JsonObject;
  location: string;
  push: Push;
  context: OperationContext;
}): void {
  const responses = operation['responses'];
  if (typeof responses !== 'object' || responses === null || Array.isArray(responses)) {
    if (responses !== undefined) {
      // A present but non-object responses field is a broken shape,
      // not a missing one. Block it on its own.
      push({
        code: 'RESPONSE_INVALID',
        severity: 'blocker',
        category: 'response',
        message: 'Responses field is not an object; its responses cannot be mapped to tool results',
        location,
        ...context,
      });
      return;
    }
    // OpenAPI requires a responses object; without one there is also no
    // declared success response to map to a tool result.
    push({
      code: 'RESPONSE_NO_SUCCESS',
      severity: 'warning',
      category: 'response',
      message: 'Operation declares no 2xx, 3xx, or default response',
      location,
      ...context,
    });
    return;
  }
  // Specification extensions (x-*) are not responses.
  const statuses = Object.keys(responses as JsonObject).filter(
    (status) => !status.startsWith('x-'),
  );
  // A redirect (3xx) is a terminal success for OAuth/SAML-style flows
  // (authorize/SSO redirects) that never return a 2xx; treat it the same
  // as a 2xx or default for this check.
  if (!statuses.some((status) => /^[23]\d\d$|^[23]XX$|^default$/i.test(status))) {
    push({
      code: 'RESPONSE_NO_SUCCESS',
      severity: 'warning',
      category: 'response',
      message: 'Operation declares no 2xx, 3xx, or default response',
      location,
      ...context,
    });
  }
  for (const [status, response] of Object.entries(responses as JsonObject)) {
    if (status.startsWith('x-')) continue;
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      push({
        code: 'RESPONSE_INVALID',
        severity: 'blocker',
        category: 'response',
        message: `Response "${status}" is not an object; it cannot be mapped to a tool result`,
        location: `${location}/responses/${escapePointer(status)}`,
        ...context,
      });
      continue;
    }
    if (
      typeof response === 'object' &&
      response !== null &&
      !Array.isArray(response) &&
      typeof (response as JsonObject)['$ref'] === 'string'
    ) {
      const refResolution = resolveRefChain({ document, value: response });
      if (!refResolution.object) {
        push({
          code: 'RESPONSE_REF_UNSUPPORTED',
          severity: 'blocker',
          category: 'response',
          message: `Response $ref could not be resolved (${refResolution.reason ?? 'dangling'}): ${refResolution.ref ?? ''}`,
          location: `${location}/responses/${escapePointer(status)}`,
          ...context,
        });
        continue;
      }
    }
    const resolved = resolveRefChain({ document, value: response });
    if (!resolved.object) continue;
    const content = resolved.object['content'];
    if (typeof content !== 'object' || content === null) continue;
    for (const rawMime of Object.keys(content as JsonObject)) {
      const mime = normalizeMime({ mime: rawMime });
      if (mime === 'text/event-stream') {
        push({
          code: 'RESPONSE_MIME_UNSUPPORTED',
          severity: 'blocker',
          category: 'response',
          message: 'SSE (text/event-stream) responses cannot be consumed as MCP tool results',
          location,
          ...context,
        });
      } else if (mime === 'application/octet-stream') {
        push({
          code: 'RESPONSE_BINARY',
          severity: 'warning',
          category: 'response',
          message: 'Binary response needs an explicit MCP content policy',
          location,
          ...context,
        });
      }
    }
  }
}

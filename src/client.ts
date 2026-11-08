import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { serializeRequest } from './request/serialize.js';
import { textResult } from './results.js';
import type { CompiledTool } from './tools.js';
import { projectResponseFields, readBoundedBody, readBoundedText } from './response-policy.js';

export type ApiOptions = {
  apiKey?: string;
  bearerToken?: string;
  serverUrl?: string;
  serverIndex?: number;
  /** Explicit opt-in only; the caller must know the GET/HEAD operation is safe. */
  safeReadRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export function errorResult(message: string): CallToolResult {
  return { ...textResult(message), isError: true };
}

function retryDelay({ response, attempt }: { response?: Response; attempt: number }): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const duration = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(duration) && duration >= 0) return duration;
  }
  return Math.min(500 * 2 ** attempt, 10_000) * (0.5 + Math.random() * 0.5);
}

function resolveServer({
  options,
  servers,
  upstream,
}: {
  options: ApiOptions;
  servers: string[];
  upstream?: string;
}): URL {
  const index = options.serverIndex ?? 0;
  if (!Number.isInteger(index) || index < 0) throw new Error('Invalid server index');
  // The operator's serverUrl wins so a spec extension cannot redirect credentials.
  const selected = options.serverUrl ?? upstream ?? servers[index];
  if (!selected) throw new Error('Missing API server');
  const url = new URL(selected);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid API server');
  }
  return url;
}

async function formatResponse({
  response,
  credential,
  redaction,
  responseFields,
  responseMetadata,
  maxResponseBytes,
}: {
  response: Response;
  credential: string;
  redaction?: boolean | string[];
  responseFields?: string[];
  responseMetadata?: boolean;
  maxResponseBytes?: number;
}): Promise<CallToolResult> {
  const requestId = ['x-request-id', 'x-correlation-id', 'x-amzn-requestid']
    .map((name) => response.headers.get(name))
    .find(
      (value) =>
        value !== null &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
        !value.includes(credential),
    );
  const retry = response.headers.get('retry-after');
  const retryAfterSeconds =
    retry && /^\d{1,4}$/.test(retry) && Number(retry) <= 3600 ? Number(retry) : undefined;
  const category =
    (
      {
        401: 'authentication_required',
        403: 'permission_denied',
        404: 'not_found',
        409: 'conflict',
        429: 'rate_limited',
      } as Record<number, string>
    )[response.status] ?? (response.status >= 500 ? 'upstream_unavailable' : 'request_failed');
  const decorate = (result: CallToolResult): CallToolResult =>
    responseMetadata
      ? {
          ...result,
          _meta: {
            upstream: {
              status: response.status,
              ...(requestId ? { requestId } : {}),
              ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
              ...(!response.ok ? { category } : {}),
            },
          },
        }
      : result;
  // Upstream errors can echo credentials or private request data. Do not expose their bodies.
  if (!response.ok) {
    await response.body?.cancel();
    return decorate(
      errorResult(
        `API request failed (HTTP ${response.status}).` +
          (responseMetadata && requestId ? ` Request ID: ${requestId}.` : ''),
      ),
    );
  }
  if (redaction === true) {
    await response.body?.cancel();
    return decorate(textResult('[REDACTED]'));
  }
  const mimeType = response.headers.get('content-type') ?? '';
  if (responseFields) {
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(mimeType)) {
      await response.body?.cancel();
      return decorate(errorResult('API response withheld: expected a JSON response.'));
    }
    try {
      const projected = projectResponseFields(
        JSON.parse(await readBoundedText(response, maxResponseBytes ?? 1_048_576)),
        responseFields,
      );
      const mask = (item: unknown): unknown => {
        if (typeof item === 'string') return item.replaceAll(credential, '[REDACTED]');
        if (Array.isArray(item)) return item.map(mask);
        if (item && typeof item === 'object')
          return Object.fromEntries(
            Object.entries(item).map(([key, value]) => [
              key,
              Array.isArray(redaction) && redaction.includes(key) ? '[REDACTED]' : mask(value),
            ]),
          );
        return String(item).includes(credential) ? '[REDACTED]' : item;
      };
      return decorate(textResult(JSON.stringify(mask(projected))));
    } catch {
      return decorate(
        errorResult('API response withheld: invalid, oversized, or unexpected JSON response.'),
      );
    }
  }
  const binary = mimeType.startsWith('image/') || mimeType.startsWith('audio/');
  // Field masks only work on JSON; any other body would leak unmasked, so fail closed.
  if (Array.isArray(redaction) && binary) {
    await response.body?.cancel();
    return decorate(textResult('[REDACTED]'));
  }
  if (binary) {
    const bytes = maxResponseBytes
      ? await readBoundedBody(response, maxResponseBytes)
      : new Uint8Array(await response.arrayBuffer());
    const data = Buffer.from(bytes).toString('base64');
    return decorate({
      content: [{ type: mimeType.startsWith('image/') ? 'image' : 'audio', data, mimeType }],
    });
  }
  let text = (
    await (maxResponseBytes ? readBoundedText(response, maxResponseBytes) : response.text())
  ).replaceAll(credential, '[REDACTED]');
  if (Array.isArray(redaction) && text.trim() !== '') {
    try {
      const parsed = JSON.parse(text) as unknown;
      const mask = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(mask);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              redaction.includes(key) ? '[REDACTED]' : mask(item),
            ]),
          );
        return value;
      };
      text = JSON.stringify(mask(parsed));
    } catch {
      return decorate(textResult('[REDACTED]'));
    }
  }
  return decorate(textResult(text));
}

/** Owns the whole deadline, including retries, backoff, and response consumption. */
export async function executeRequest({
  tool,
  input,
  options,
  servers,
  signal,
}: {
  tool: CompiledTool;
  input: unknown;
  options: ApiOptions;
  servers: string[];
  signal?: AbortSignal;
}): Promise<CallToolResult> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)
    return errorResult('Invalid API deadline.');
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const apiKey = options.apiKey?.trim();
    const bearerToken = options.bearerToken?.trim();
    if ((!apiKey && !bearerToken) || (apiKey && bearerToken))
      return errorResult('Missing or conflicting API credentials.');
    const request = serializeRequest({ plan: tool.plan, input, path: tool.path });
    const server = resolveServer({
      options,
      servers,
      ...(tool.upstream ? { upstream: tool.upstream } : {}),
    });
    // Concatenate before URL parsing so an encoded path value cannot change the origin.
    const url = new URL(`${server.href.replace(/\/$/, '')}${request.path}`);
    url.search = request.query.toString();
    if (apiKey) request.headers.set('X-API-Key', apiKey);
    else request.headers.set('Authorization', `Bearer ${bearerToken}`);
    const retries = options.safeReadRetries ?? 0;
    if (!Number.isInteger(retries) || retries < 0 || retries > 3)
      return errorResult('Invalid safe-read retry limit.');
    const retryable = ['get', 'head'].includes(tool.method) && retries > 0;
    for (let attempt = 0; ; attempt++) {
      combined.throwIfAborted();
      let response: Response | undefined;
      try {
        response = await (options.fetch ?? fetch)(url, {
          method: tool.method.toUpperCase(),
          headers: request.headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
          signal: combined,
          redirect: 'manual',
        });
      } catch {
        if (!retryable || attempt >= retries || combined.aborted)
          throw new Error('API connection failed');
      }
      const retryStatus = response && [429, 500, 502, 503, 504].includes(response.status);
      if (response && (!retryStatus || !retryable || attempt >= retries)) {
        const result = await formatResponse({
          response,
          credential: (apiKey ?? bearerToken)!,
          ...(tool.redaction !== undefined ? { redaction: tool.redaction } : {}),
          ...(tool.responseFields ? { responseFields: tool.responseFields } : {}),
          ...(tool.responseMetadata ? { responseMetadata: tool.responseMetadata } : {}),
          ...(tool.maxResponseBytes ? { maxResponseBytes: tool.maxResponseBytes } : {}),
        });
        combined.throwIfAborted();
        return result;
      }
      const waitMs = retryDelay({ ...(response ? { response } : {}), attempt });
      await response?.body?.cancel();
      // Never let a huge Retry-After overflow Node's timer and retry immediately.
      // The total-deadline signal aborts this capped wait before an early retry.
      await delay(Math.min(waitMs, timeoutMs), undefined, { signal: combined });
    }
  } catch {
    if (signal?.aborted) return errorResult('API request cancelled.');
    if (controller.signal.aborted) return errorResult('API request exceeded its deadline.');
    return errorResult('API request failed. Check the input and API configuration.');
  } finally {
    clearTimeout(timer);
  }
}

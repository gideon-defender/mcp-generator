import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorResult, executeRequest, type ApiOptions } from '../src/client.js';
import { resolveApiCredential } from '../src/credentials.js';
import { compileTools, type CompiledTool } from '../src/tools.js';

function registry() {
  return compileTools({
    source: {
      openapi: '3.0.3',
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/widgets': {
          get: {
            operationId: 'widgetsController_list_v1',
            summary: 'List',
            description: 'List widgets.',
            responses: { '200': { description: 'OK' } },
          },
          post: {
            operationId: 'widgetsController_create_v1',
            summary: 'Create',
            description: 'Create a widget.',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    },
    overlay: { version: 1, schemas: [], operations: [] },
  });
}

function fetchStub(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return (async (url: unknown, init: unknown) =>
    handler(url as URL, init as RequestInit)) as typeof fetch;
}

describe('errorResult', () => {
  it('always marks the result as an error text block', () => {
    assert.deepEqual(errorResult('bad'), {
      isError: true,
      content: [{ type: 'text', text: 'bad' }],
    });
  });
});

describe('executeRequest: credentials', () => {
  it('rejects when neither or both credentials are provided', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    const neither = await executeRequest({ tool, input: {}, options: {}, servers });
    assert.deepEqual(neither, errorResult('Missing or conflicting API credentials.'));
    const both = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'a', bearerToken: 'b' },
      servers,
    });
    assert.deepEqual(both, errorResult('Missing or conflicting API credentials.'));
  });

  it('sends the API key or bearer token as the matching header, never both', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    const headersSeen: Headers[] = [];
    const fetch = fetchStub((_url, init) => {
      headersSeen.push(init.headers as Headers);
      return new Response('ok');
    });
    await executeRequest({ tool, input: {}, options: { apiKey: 'key-1', fetch }, servers });
    assert.equal(headersSeen[0]?.get('x-api-key'), 'key-1');
    assert.equal(headersSeen[0]?.get('authorization'), null);

    await executeRequest({ tool, input: {}, options: { bearerToken: 'tok-1', fetch }, servers });
    assert.equal(headersSeen[1]?.get('authorization'), 'Bearer tok-1');
    assert.equal(headersSeen[1]?.get('x-api-key'), null);
  });

  it('redacts the credential if it is echoed back in the response body', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    const fetch = fetchStub(() => new Response('your key was key-1, denied'));
    const result = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'key-1', fetch },
      servers,
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.content[0] as { text: string }).text, 'your key was [REDACTED], denied');
  });
});

describe('executeRequest: server resolution', () => {
  it('builds the request URL from the spec server plus the operation path', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    let seenUrl: URL | undefined;
    const fetch = fetchStub((url) => {
      seenUrl = url;
      return new Response('ok');
    });
    await executeRequest({ tool, input: {}, options: { apiKey: 'k', fetch }, servers });
    assert.equal(seenUrl?.toString(), 'https://api.example.test/widgets');
  });

  it('prefers an explicit serverUrl override over the spec server', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    let seenUrl: URL | undefined;
    const fetch = fetchStub((url) => {
      seenUrl = url;
      return new Response('ok');
    });
    await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', serverUrl: 'https://override.example.test', fetch },
      servers,
    });
    assert.equal(seenUrl?.origin, 'https://override.example.test');
  });

  it('fails softly (not a thrown error) on an invalid or missing server', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    const missing = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', serverIndex: 5 },
      servers: [],
    });
    assert.equal(missing.isError, true);
    const invalidProtocol = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', serverUrl: 'ftp://example.test' },
      servers,
    });
    assert.equal(invalidProtocol.isError, true);
    const withUserinfo = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', serverUrl: 'https://user:pass@example.test' },
      servers,
    });
    assert.equal(withUserinfo.isError, true);
  });
});

describe('executeRequest: retries', () => {
  it('retries a safe (GET) request on a retryable status and returns the eventual success', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    let calls = 0;
    const fetch = fetchStub(() => {
      calls += 1;
      return calls < 3
        ? new Response('busy', { status: 503 })
        : new Response('ok', { status: 200 });
    });
    const result = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', fetch, safeReadRetries: 2 },
      servers,
    });
    assert.equal(calls, 3);
    assert.equal(result.isError, undefined);
  });

  it('gives up after exhausting retries and reports the last HTTP failure', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    let calls = 0;
    const fetch = fetchStub(() => {
      calls += 1;
      return new Response('busy', { status: 500 });
    });
    const result = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', fetch, safeReadRetries: 2 },
      servers,
    });
    assert.equal(calls, 3); // initial attempt + 2 retries
    assert.deepEqual(result, errorResult('API request failed (HTTP 500).'));
  });

  it('never retries a mutating (POST) request even on a retryable status', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'post') as CompiledTool;
    let calls = 0;
    const fetch = fetchStub(() => {
      calls += 1;
      return new Response('busy', { status: 503 });
    });
    await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', fetch, safeReadRetries: 2 },
      servers,
    });
    assert.equal(calls, 1);
  });

  it('rejects an out-of-range safe-read retry count', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    const result = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', safeReadRetries: 4 },
      servers,
    });
    assert.deepEqual(result, errorResult('Invalid safe-read retry limit.'));
  });
});

describe('executeRequest: deadline and cancellation', () => {
  it('rejects an out-of-range timeout before making any request', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    let called = false;
    const fetch = fetchStub(() => {
      called = true;
      return new Response('ok');
    });
    const result = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', fetch, timeoutMs: -1 },
      servers,
    });
    assert.deepEqual(result, errorResult('Invalid API deadline.'));
    assert.equal(called, false);
  });

  it('reports cancellation distinctly when the caller aborts', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    const controller = new AbortController();
    const fetch = fetchStub(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    const result = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', fetch },
      servers,
      signal: controller.signal,
    });
    assert.deepEqual(result, errorResult('API request cancelled.'));
  });

  it('reports a connection failure as a soft error instead of throwing', async () => {
    const { tools, servers } = registry();
    const tool = tools.find((candidate) => candidate.method === 'get') as CompiledTool;
    const fetch = fetchStub(() => {
      throw new Error('ECONNREFUSED');
    });
    const result = await executeRequest({
      tool,
      input: {},
      options: { apiKey: 'k', fetch },
      servers,
    });
    assert.equal(result.isError, true);
  });
});

describe('resolveApiCredential', () => {
  it('prefers the transport header over the static fallback', () => {
    const headers = new Headers({ apikey: 'from-header' });
    assert.equal(resolveApiCredential({ headers, staticApiKey: 'from-flag' }), 'from-header');
  });

  it('falls back to the static key only when static auth is not disabled', () => {
    const headers = new Headers();
    assert.equal(resolveApiCredential({ headers, staticApiKey: 'from-flag' }), 'from-flag');
    assert.equal(
      resolveApiCredential({ headers, staticApiKey: 'from-flag', disableStaticAuth: true }),
      '',
    );
  });

  it('returns an empty string with no header and no static key', () => {
    assert.equal(resolveApiCredential({ headers: new Headers() }), '');
  });
});

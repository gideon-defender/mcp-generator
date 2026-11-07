import assert from 'node:assert/strict';
import { it } from 'node:test';
import { request } from 'node:http';
import { createHostedServer } from '../src/serve.js';
import { createOwnedServer } from '../src/server.js';
import { prepareProtectedResource, trustedOAuthUrl } from '../src/auth/resource.js';
import { baseSpec, okOperation } from './helpers.js';

// Native HTTP lets the test set Host explicitly; fetch may rewrite that header.
function httpFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers))
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolve(
            new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers,
            }),
          );
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

it('publishes protected-resource discovery and host-bound bearer challenges before authentication', async () => {
  let checks = 0;
  const hosted = await createHostedServer({
    createServerForSession: () =>
      createOwnedServer({
        name: 'test',
        version: '1',
        source: baseSpec({ '/ping': { get: okOperation() } }),
        overlay: { version: 1, schemas: [], operations: [] },
      }),
    port: 0,
    transport: 'http',
    protectedResource: {
      resource: 'https://mcp.example.test/mcp',
      authorizationServers: ['https://identity.example.test'],
      scopesSupported: ['tools.read', 'tools.write'],
    },
    allowedOrigins: ['https://client.example.test'],
    authAdapter: {
      authenticate: async ({ headers }) => {
        checks++;
        if (headers.get('authorization') === 'Bearer unavailable')
          return { ok: false, status: 503, message: 'Unavailable' };
        if (headers.get('authorization') === 'Bearer missing-scope')
          return {
            ok: false,
            status: 403,
            message: 'Required scopes are missing.',
            error: 'insufficient_scope',
            requiredScopes: ['tools.read'],
          };
        if (headers.get('authorization') === 'Bearer unspecified-scope')
          return {
            ok: false,
            status: 403,
            message: 'Required scopes are missing.',
            error: 'insufficient_scope',
          };
        return { ok: false, status: 401, message: 'Invalid', error: 'invalid_token' };
      },
    },
  });
  await hosted.listen();
  const address = hosted.server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { host: 'mcp.example.test' };
  try {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await httpFetch(`${url}${path}`, {
        headers: { ...headers, origin: 'https://any-client.example' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(await response.json(), {
        resource: 'https://mcp.example.test/mcp',
        authorization_servers: ['https://identity.example.test'],
        bearer_methods_supported: ['header'],
        scopes_supported: ['tools.read', 'tools.write'],
      });
    }
    assert.equal(checks, 0);
    const denied = await httpFetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        origin: 'https://client.example.test',
      },
      body: 'malformed json',
    });
    assert.equal(denied.status, 401);
    assert.equal(
      denied.headers.get('www-authenticate'),
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    );
    assert.equal(denied.headers.get('access-control-allow-origin'), 'https://client.example.test');
    assert.ok(denied.headers.get('access-control-expose-headers')?.includes('WWW-Authenticate'));
    for (const [token, scope] of [
      ['missing-scope', ', scope="tools.read"'],
      ['unspecified-scope', ''],
    ]) {
      const insufficient = await httpFetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${token}` },
      });
      assert.equal(insufficient.status, 403);
      assert.equal(
        insufficient.headers.get('www-authenticate'),
        `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", error="insufficient_scope"${scope}`,
      );
    }
    const before = checks;
    for (const path of ['/mcp', '/.well-known/oauth-protected-resource/mcp']) {
      assert.equal(
        (
          await httpFetch(`${url}${path}`, {
            headers: { host: 'foreign.example.test', 'x-forwarded-host': 'mcp.example.test' },
          })
        ).status,
        403,
      );
    }
    assert.equal(checks, before);
    const preflight = await httpFetch(`${url}/mcp`, {
      method: 'OPTIONS',
      headers: {
        ...headers,
        origin: 'https://client.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.ok(preflight.headers.get('access-control-allow-headers')?.includes('Authorization'));
    assert.equal(
      (
        await httpFetch(`${url}/mcp`, {
          method: 'OPTIONS',
          headers: { ...headers, origin: 'https://foreign.example.test' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await httpFetch(`${url}/mcp?access_token=secret`, { method: 'POST', headers })).status,
      400,
    );
    const outage = await httpFetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer unavailable' },
    });
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get('www-authenticate'), null);
  } finally {
    await hosted.close();
  }
});

it('requires TLS except on loopback and validates protected-resource configuration', () => {
  for (const value of [
    'http://identity.example.test',
    'https://user:pass@identity.example.test',
    'https://identity.example.test?token=secret',
    'https://identity.example.test#fragment',
  ])
    assert.throws(() => trustedOAuthUrl(value));
  assert.equal(trustedOAuthUrl('http://127.0.0.1:1234/mcp').pathname, '/mcp');
  assert.throws(() =>
    prepareProtectedResource({
      resource: 'https://mcp.example.test/mcp',
      authorizationServers: [],
    }),
  );
  assert.throws(() =>
    prepareProtectedResource({
      resource: 'https://mcp.example.test/mcp',
      authorizationServers: ['https://identity.example.test'],
      scopesSupported: ['bad"scope'],
    }),
  );
  const resource = prepareProtectedResource({
    resource: 'https://mcp.example.test/mcp',
    authorizationServers: ['https://identity.example.test'],
  });
  for (const scope of ['bad"scope', 'bad\\scope', 'bad\r\nscope', ''])
    assert.throws(() => resource.challenge('insufficient_scope', [scope]), /Invalid OAuth scope/);
});

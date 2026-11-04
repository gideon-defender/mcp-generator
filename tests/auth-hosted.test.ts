import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { staticAuth, rejectUnauthenticated } from '../src/auth/adapters.js';
import { oauthAuth } from '../src/auth/oauth.js';
import { McpProjectConfigSchema } from '../src/config/schema.js';
import { createHostedServer } from '../src/serve.js';
import { createOwnedServer } from '../src/server.js';

const SOURCE = {
  openapi: '3.0.3',
  servers: [{ url: 'https://api.example.test' }],
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        summary: 'Ping',
        description: 'Ping.',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};
const OVERLAY = { version: 1, schemas: [], operations: [] };
type TestPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function jwksServer(): Promise<{ server: Server; url: string; privateKey: TestPrivateKey }> {
  const pair = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.use = 'sig';
  publicJwk.kid = 'phase5-test-key';
  publicJwk.alg = 'RS256';
  const jwks = { keys: [publicJwk] };
  const server = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(jwks));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
    privateKey: pair.privateKey as TestPrivateKey,
  };
}

async function signToken({
  privateKey,
  issuer,
  audience,
  scope,
  claims = {},
  expiresIn = '5m',
}: {
  privateKey: TestPrivateKey;
  issuer: string;
  audience: string;
  scope?: string;
  claims?: Record<string, unknown>;
  expiresIn?: string;
}): Promise<string> {
  return new SignJWT({ ...claims, ...(scope ? { scope } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'phase5-test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

describe('Phase 5 auth adapters', () => {
  it('returns exactly one static credential', async () => {
    assert.deepEqual(await staticAuth({ apiKey: 'key' }).authenticate({} as never), {
      ok: true,
      apiOptions: { apiKey: 'key' },
    });
    assert.deepEqual(await staticAuth({ bearerToken: 'token' }).authenticate({} as never), {
      ok: true,
      apiOptions: { bearerToken: 'token' },
    });
    assert.equal(
      (await staticAuth({ apiKey: 'a', bearerToken: 'b' }).authenticate({} as never)).ok,
      false,
    );
  });

  it('rejects missing and unauthenticated static credentials', async () => {
    const missing = await staticAuth({}).authenticate({} as never);
    assert.equal(missing.ok, false);
    if (missing.ok) throw new Error('expected denial');
    assert.equal(missing.status, 401);
    const unauthenticated = await rejectUnauthenticated().authenticate({} as never);
    assert.equal(unauthenticated.ok, false);
    if (unauthenticated.ok) throw new Error('expected denial');
    assert.equal(unauthenticated.status, 401);
  });

  it('validates OAuth issuer, audience, expiration, and scopes', async () => {
    const jwks = await jwksServer();
    try {
      const issuer = 'https://issuer.example';
      const audience = 'https://mcp.example';
      const adapter = oauthAuth({
        issuer,
        audience,
        jwksUrl: jwks.url,
        requiredScopes: ['mcp.tools'],
        upstreamBearerToken: true,
      });
      const headers = (token: string) => new Headers({ authorization: `Bearer ${token}` });
      const valid = await signToken({
        privateKey: jwks.privateKey,
        issuer,
        audience,
        scope: 'mcp.tools',
      });
      const validResult = await adapter.authenticate({
        headers: headers(valid),
        transport: 'http',
      });
      assert.deepEqual(validResult, { ok: true, apiOptions: { bearerToken: valid } });

      const wrongAudience = await signToken({
        privateKey: jwks.privateKey,
        issuer,
        audience: 'https://wrong.example',
        scope: 'mcp.tools',
      });
      const wrongAudienceResult = await adapter.authenticate({
        headers: headers(wrongAudience),
        transport: 'http',
      });
      assert.equal(wrongAudienceResult.ok, false);
      if (wrongAudienceResult.ok) throw new Error('expected audience denial');
      assert.equal(wrongAudienceResult.status, 401);
      const wrongIssuer = await signToken({
        privateKey: jwks.privateKey,
        issuer: 'https://wrong-issuer.example',
        audience,
        scope: 'mcp.tools',
      });
      const wrongIssuerResult = await adapter.authenticate({
        headers: headers(wrongIssuer),
        transport: 'http',
      });
      assert.equal(wrongIssuerResult.ok, false);
      if (wrongIssuerResult.ok) throw new Error('expected issuer denial');
      assert.equal(wrongIssuerResult.status, 401);
      const missingScope = await signToken({
        privateKey: jwks.privateKey,
        issuer,
        audience,
        scope: 'other',
      });
      const missingScopeResult = await adapter.authenticate({
        headers: headers(missingScope),
        transport: 'http',
      });
      assert.equal(missingScopeResult.ok, false);
      if (missingScopeResult.ok) throw new Error('expected scope denial');
      assert.equal(missingScopeResult.status, 403);
      const missingBearerResult = await adapter.authenticate({
        headers: new Headers(),
        transport: 'http',
      });
      assert.equal(missingBearerResult.ok, false);
      if (missingBearerResult.ok) throw new Error('expected bearer denial');
      assert.equal(missingBearerResult.status, 401);

      const noForward = oauthAuth({ issuer, audience, jwksUrl: jwks.url });
      const noCredential = await noForward.authenticate({
        headers: headers(valid),
        transport: 'http',
      });
      assert.equal(noCredential.ok, false);
      if (noCredential.ok) throw new Error('expected credential denial');
      assert.equal(noCredential.status, 403);
      const withClaim = await signToken({
        privateKey: jwks.privateKey,
        issuer,
        audience,
        claims: { api_key: 'claim-key' },
      });
      assert.deepEqual(
        await noForward.authenticate({ headers: headers(withClaim), transport: 'http' }),
        { ok: true, apiOptions: { apiKey: 'claim-key' } },
      );
    } finally {
      await new Promise<void>((resolve) => jwks.server.close(() => resolve()));
    }
  });

  it('requires complete OAuth settings and rejects static hosted config', () => {
    assert.throws(
      () =>
        McpProjectConfigSchema.parse({
          spec: { path: './openapi.json' },
          overlay: './overlay.yaml',
          auth: { mode: 'oauth' },
          hosted: { transport: 'http', port: 3000 },
        }),
      /OAuth auth requires issuer/,
    );
    assert.throws(() =>
      McpProjectConfigSchema.parse({
        spec: { path: './openapi.json' },
        overlay: './overlay.yaml',
        auth: { mode: 'apikey' },
        hosted: { transport: 'http', port: 3000 },
      }),
    );
  });
});

describe('Phase 5 hosted server', () => {
  const ISSUER = 'https://issuer.example';
  const AUDIENCE = 'https://mcp.example';

  function newServer(authAdapter: ReturnType<typeof oauthAuth>, transport: 'http' | 'sse') {
    return createOwnedServer({
      name: 'test',
      version: '1',
      source: SOURCE,
      overlay: OVERLAY,
      authAdapter,
      transport,
    });
  }

  async function withApiStub(run: (seen: Headers[]) => Promise<void>): Promise<void> {
    const realFetch = globalThis.fetch;
    const seen: Headers[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://api.example.test')) return realFetch(input, init);
      seen.push(new Headers(init?.headers));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await run(seen);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('serves health and rejects unauthenticated MCP requests', async () => {
    const hosted = await createHostedServer({
      createServerForSession: () =>
        createOwnedServer({
          name: 'test',
          version: '1',
          source: SOURCE,
          overlay: OVERLAY,
          getOptions: () => ({ apiKey: 'key' }),
        }),
      port: 0,
      transport: 'http',
      authAdapter: rejectUnauthenticated(),
      host: '127.0.0.1',
      allowedOrigins: ['https://client.example'],
    });
    await hosted.listen();
    const address = hosted.server.address();
    assert(address && typeof address !== 'string');
    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });

      const denied = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('www-authenticate'), 'Bearer');

      const wrongOrigin = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: '{}',
      });
      assert.equal(wrongOrigin.status, 403);
    } finally {
      await hosted.close();
    }
  });

  for (const transport of ['http', 'sse'] as const) {
    it(`serves authenticated ${transport} tool calls with the caller's token`, async () => {
      const jwks = await jwksServer();
      const adapter = oauthAuth({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: jwks.url,
        upstreamBearerToken: true,
      });
      const hosted = await createHostedServer({
        createServerForSession: () => newServer(adapter, transport),
        port: 0,
        transport,
        authAdapter: adapter,
        host: '127.0.0.1',
      });
      await hosted.listen();
      const address = hosted.server.address();
      assert(address && typeof address !== 'string');
      const token = await signToken({
        privateKey: jwks.privateKey,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const requestInit = { headers: { authorization: `Bearer ${token}` } };
      const base = new URL(`http://127.0.0.1:${address.port}`);
      const client = new Client({ name: 'test-client', version: '1' });
      try {
        await withApiStub(async (seen) => {
          await client.connect(
            transport === 'http'
              ? new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit })
              : new SSEClientTransport(new URL('/sse', base), { requestInit }),
          );
          const { tools } = await client.listTools();
          assert.equal(tools.length, 1);
          for (let call = 0; call < 2; call++) {
            const result = await client.callTool({ name: tools[0]!.name, arguments: {} });
            assert.notEqual(result.isError, true);
          }
          assert.deepEqual(
            seen.map((headers) => headers.get('authorization')),
            [`Bearer ${token}`, `Bearer ${token}`],
          );
        });
      } finally {
        await client.close();
        await hosted.close();
        await new Promise<void>((resolve) => jwks.server.close(() => resolve()));
      }
    });
  }

  it('closes open SSE sessions once on shutdown without recursing', async () => {
    const servers: ReturnType<typeof createOwnedServer>[] = [];
    const hosted = await createHostedServer({
      createServerForSession: () => {
        const server = createOwnedServer({
          name: 'test',
          version: '1',
          source: SOURCE,
          overlay: OVERLAY,
          transport: 'sse',
          getOptions: () => ({ apiKey: 'key' }),
        });
        servers.push(server);
        return server;
      },
      port: 0,
      transport: 'sse',
      host: '127.0.0.1',
    });
    await hosted.listen();
    const address = hosted.server.address();
    assert(address && typeof address !== 'string');
    const client = new Client({ name: 'test-client', version: '1' });
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${address.port}/sse`)));
    assert.equal(servers.length, 1);
    assert.equal(servers[0]!.isConnected(), true);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        hosted.close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('hosted.close() did not finish')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => undefined);
    }
    assert.equal(servers[0]!.isConnected(), false);
  });

  it('rejects other methods on the stateless MCP endpoint', async () => {
    const jwks = await jwksServer();
    const adapter = oauthAuth({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: jwks.url,
      upstreamBearerToken: true,
    });
    const hosted = await createHostedServer({
      createServerForSession: () => newServer(adapter, 'http'),
      port: 0,
      transport: 'http',
      authAdapter: adapter,
    });
    await hosted.listen();
    const address = hosted.server.address();
    assert(address && typeof address !== 'string');
    try {
      const token = await signToken({
        privateKey: jwks.privateKey,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 405);
    } finally {
      await hosted.close();
      await new Promise<void>((resolve) => jwks.server.close(() => resolve()));
    }
  });
});

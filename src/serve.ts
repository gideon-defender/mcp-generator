import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthAdapter } from './auth/types.js';
import { prepareProtectedResource, type ProtectedResourceOptions } from './auth/resource.js';

export type HostedServeOptions = {
  /** Called once per HTTP request or SSE session; servers are never shared between callers. */
  createServerForSession: () => McpServer;
  port: number;
  host?: string;
  authAdapter?: AuthAdapter;
  transport: 'http' | 'sse';
  maxRequestBodyBytes?: number;
  allowedOrigins?: readonly string[];
  maxSseSessions?: number;
  protectedResource?: ProtectedResourceOptions;
  /** Explicit HTTP endpoint for an independently authenticated product listener. */
  mcpPath?: string;
};

export async function createHostedServer(options: HostedServeOptions): Promise<{
  app: Express;
  server: Server;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error('--port must be an integer between 0 and 65535');
  const app = express();
  const mcpPath = options.mcpPath ?? '/mcp';
  if (
    !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(mcpPath) ||
    ['/healthz', '/sse', '/messages'].includes(mcpPath.toLowerCase()) ||
    (options.transport !== 'http' && mcpPath !== '/mcp')
  )
    throw new Error('Invalid HTTP MCP path.');
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.status(200).json({ status: 'ok' }));
  const resource = options.protectedResource
    ? prepareProtectedResource(options.protectedResource)
    : undefined;
  if (resource) {
    if (!options.authAdapter) throw new Error('Protected resources require an auth adapter.');
    if (resource.resource.pathname !== (options.transport === 'http' ? mcpPath : '/sse'))
      throw new Error('Protected resource URL must match the transport endpoint.');
    app.use((request, response, next) => {
      // Ignore forwarded host/proto: only configured public authority is trusted.
      if (request.headers.host?.toLowerCase() !== resource.resource.host.toLowerCase()) {
        response.status(403).json({ error: 'Host is not allowed.' });
        return;
      }
      next();
    });
    app.get(
      [...new Set([resource.metadataPath, '/.well-known/oauth-protected-resource'])],
      (_request, response) => {
        response
          .set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' })
          .json(resource.document);
      },
    );
  }

  const allowedOrigins = options.allowedOrigins?.length
    ? options.allowedOrigins
    : resource
      ? [resource.resource.origin]
      : undefined;
  if (allowedOrigins?.length) {
    app.use((request, response, next) => {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        response.status(403).json({ error: 'Origin is not allowed.' });
        return;
      }
      if (origin) {
        response.vary('Origin');
        response.set({
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version',
        });
      }
      next();
    });
  }
  app.options([mcpPath, '/sse', '/messages'], (_request, response) => {
    response
      .set({
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      })
      .status(204)
      .end();
  });

  if (options.authAdapter) {
    app.use(async (request, response, next) => {
      if (request.path === '/healthz') return next();
      if ('access_token' in request.query) {
        response.status(400).json({ error: 'Use the Authorization header for bearer tokens.' });
        return;
      }
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(','));
        }
        const result = await options.authAdapter!.authenticate({
          headers,
          transport: options.transport,
        });
        if (!result.ok) {
          if (result.status === 401 || result.error === 'insufficient_scope')
            response.set(
              'WWW-Authenticate',
              resource ? resource.challenge(result.error, result.requiredScopes) : 'Bearer',
            );
          response.status(result.status).json({ error: result.message });
          return;
        }
        next();
      } catch {
        response.set('WWW-Authenticate', resource ? resource.challenge('invalid_token') : 'Bearer');
        response.status(401).json({ error: 'Authentication failed.' });
      }
    });
  }
  app.use(express.json({ limit: options.maxRequestBodyBytes ?? 1_048_576 }));

  if (options.transport === 'http') {
    // Stateless transports handle exactly one request, so each request gets its own server.
    app.post(mcpPath, async (request, response) => {
      const requestServer = options.createServerForSession();
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        maxRequestBodySize: options.maxRequestBodyBytes ?? 1_048_576,
      });
      response.on('close', () => void requestServer.close().catch(() => undefined));
      await requestServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    });
    app.all(mcpPath, (_request, response) => {
      response.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' });
    });
  } else {
    app.get('/sse', async (request, response, next) => {
      const maxSessions = options.maxSseSessions ?? 1000;
      if (sessions.size >= maxSessions) {
        response.status(503).json({ error: 'Too many active SSE sessions.' });
        return;
      }
      const transport = new SSEServerTransport('/messages', response);
      const sessionServer = options.createServerForSession();
      sessions.set(transport.sessionId, { transport, server: sessionServer });
      // SSEServerTransport.close() calls onclose every time, and closing the server closes the
      // transport again, so without this guard the two recurse forever.
      let closed = false;
      transport.onclose = () => {
        if (closed) return;
        closed = true;
        sessions.delete(transport.sessionId);
        void sessionServer.close().catch(() => undefined);
      };
      try {
        await sessionServer.connect(transport);
      } catch (error) {
        sessions.delete(transport.sessionId);
        await sessionServer.close().catch(() => undefined);
        next(error);
      }
    });
    app.post('/messages', async (request, response) => {
      const sessionId = typeof request.query.sessionId === 'string' ? request.query.sessionId : '';
      const session = sessions.get(sessionId);
      if (!session) {
        response.status(404).json({ error: 'Unknown SSE session.' });
        return;
      }
      await session.transport.handlePostMessage(request, response, request.body);
    });
  }

  const httpServer = createServer(app);
  httpServer.requestTimeout = 120_000;
  httpServer.headersTimeout = 125_000;
  return {
    app,
    server: httpServer,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host ?? '127.0.0.1', () => {
          httpServer.off('error', reject);
          resolve();
        });
      }),
    close: async () => {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        active.map(async ({ transport, server }) => {
          await transport.close();
          await server.close().catch(() => undefined);
        }),
      );
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthAdapter } from './auth/types.js';

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
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.status(200).json({ status: 'ok' }));
  app.use(express.json({ limit: options.maxRequestBodyBytes ?? 1_048_576 }));

  const allowedOrigins = options.allowedOrigins;
  if (allowedOrigins?.length) {
    app.use((request, response, next) => {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        response.status(403).json({ error: 'Origin is not allowed.' });
        return;
      }
      next();
    });
  }

  if (options.authAdapter) {
    app.use(async (request, response, next) => {
      if (request.path === '/healthz') return next();
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
          if (result.status === 401) response.set('WWW-Authenticate', 'Bearer');
          response.status(result.status).json({ error: result.message });
          return;
        }
        next();
      } catch {
        response.set('WWW-Authenticate', 'Bearer');
        response.status(401).json({ error: 'Authentication failed.' });
      }
    });
  }

  if (options.transport === 'http') {
    // Stateless transports handle exactly one request, so each request gets its own server.
    app.post('/mcp', async (request, response) => {
      const requestServer = options.createServerForSession();
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        maxRequestBodySize: options.maxRequestBodyBytes ?? 1_048_576,
      });
      response.on('close', () => void requestServer.close().catch(() => undefined));
      await requestServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    });
    app.all('/mcp', (_request, response) => {
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
      transport.onclose = () => {
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
      await Promise.all([...sessions.values()].map(({ transport }) => transport.close()));
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

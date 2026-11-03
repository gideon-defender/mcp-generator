import type { AuthAdapter } from '../auth/types.js';
import { createHostedServer } from '../serve.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ServeOptions = {
  createServerForSession: () => McpServer;
  port?: number;
  host?: string;
  transport?: 'http' | 'sse';
  authAdapter?: AuthAdapter;
  maxRequestBodyBytes?: number;
  allowedOrigins?: readonly string[];
};

export async function runHosted(options: ServeOptions): Promise<void> {
  const hosted = await createHostedServer({
    createServerForSession: options.createServerForSession,
    port: options.port ?? 3000,
    transport: options.transport ?? 'http',
    ...(options.host ? { host: options.host } : {}),
    ...(options.authAdapter ? { authAdapter: options.authAdapter } : {}),
    ...(options.maxRequestBodyBytes ? { maxRequestBodyBytes: options.maxRequestBodyBytes } : {}),
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  await hosted.listen();
  const shutdown = async () => {
    await hosted.close();
    process.exitCode = 0;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

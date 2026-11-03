import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ApiOptions } from '../client.js';
import { createOwnedServer, type AnnotationFilter } from '../server.js';
import { runHosted } from './serve.js';
import type { AuthAdapter } from '../auth/types.js';

const EMPTY_OVERLAY = { version: 1, schemas: [], operations: [] };

async function readDocument({ filePath }: { filePath: string }): Promise<unknown> {
  // YAML is a JSON superset, so one parser covers both accepted formats.
  return parse(await readFile(filePath, 'utf8'));
}

export type StartOptions = {
  specPath: string;
  overlayPath?: string;
  name: string;
  version: string;
  mode?: 'static' | 'dynamic';
  allowedTools?: ReadonlySet<string>;
  annotationFilter?: AnnotationFilter;
  serverUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  timeoutMs?: number;
  hosted?: boolean;
  transport?: 'http' | 'sse';
  port?: number;
  host?: string;
  authAdapter?: AuthAdapter;
  maxRequestBodyBytes?: number;
  allowedOrigins?: readonly string[];
};

/** Connects over stdio and runs until the client disconnects. */
export async function runStart(options: StartOptions): Promise<void> {
  const [source, overlay] = await Promise.all([
    readDocument({ filePath: options.specPath }),
    options.overlayPath ? readDocument({ filePath: options.overlayPath }) : EMPTY_OVERLAY,
  ]);
  const apiOptions: ApiOptions = {
    ...(options.apiKey ? { apiKey: options.apiKey } : { bearerToken: options.bearerToken! }),
    ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  const transport = options.hosted ? (options.transport ?? 'http') : 'stdio';
  // Adapters resolve credentials only; operator server URL and deadline still apply.
  const operatorOptions: ApiOptions = {
    ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  const authAdapter = withOperatorOptions({ adapter: options.authAdapter, operatorOptions });
  const createServer = () =>
    createOwnedServer({
      name: options.name,
      version: options.version,
      source,
      overlay,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.annotationFilter ? { annotationFilter: options.annotationFilter } : {}),
      ...(authAdapter ? { authAdapter } : {}),
      transport,
      // Static stdio callers use one process credential; hosted callers must supply an auth adapter.
      ...(!authAdapter ? { getOptions: () => apiOptions } : {}),
    });
  if (options.hosted) {
    await runHosted({
      createServerForSession: createServer,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.authAdapter ? { authAdapter: options.authAdapter } : {}),
      ...(options.maxRequestBodyBytes ? { maxRequestBodyBytes: options.maxRequestBodyBytes } : {}),
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    });
    return;
  }
  await createServer().connect(new StdioServerTransport());
}

function withOperatorOptions({
  adapter,
  operatorOptions,
}: {
  adapter: AuthAdapter | undefined;
  operatorOptions: ApiOptions;
}): AuthAdapter | undefined {
  if (!adapter || Object.keys(operatorOptions).length === 0) return adapter;
  return {
    async authenticate(authContext) {
      const resolution = await adapter.authenticate(authContext);
      return resolution.ok
        ? { ok: true, apiOptions: { ...operatorOptions, ...resolution.apiOptions } }
        : resolution;
    },
  };
}

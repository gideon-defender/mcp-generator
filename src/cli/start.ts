import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ApiOptions } from '../client.js';
import { createOwnedServer, type AnnotationFilter } from '../server.js';

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
  const server = createOwnedServer({
    name: options.name,
    version: options.version,
    source,
    overlay,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.annotationFilter ? { annotationFilter: options.annotationFilter } : {}),
    // Single local credential for the process lifetime; there is no per-request caller to isolate over stdio.
    getOptions: () => apiOptions,
  });
  await server.connect(new StdioServerTransport());
}

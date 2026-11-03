import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { errorResult, executeRequest, type ApiOptions } from './client.js';
import { registerDiscovery } from './server/discovery.js';
import { compileTools } from './tools.js';
import type { AuthAdapter } from './auth/types.js';

export type ExecutionContext = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type AnnotationFilter = Partial<
  Record<'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint', boolean>
>;

/** Core wiring only: transports and the CLI live in `cli/start.ts` and the generated server. */
export function createOwnedServer({
  name,
  version,
  source,
  overlay,
  mode = 'static',
  allowedTools,
  annotationFilter = {},
  getOptions,
  authAdapter,
  transport = 'stdio',
}: {
  /** Product identity, supplied by the caller — the core carries no product branding. */
  name: string;
  version: string;
  source: unknown;
  overlay: unknown;
  mode?: 'static' | 'dynamic';
  allowedTools?: ReadonlySet<string>;
  annotationFilter?: AnnotationFilter;
  /** Resolve credentials for each call, never a shared hosted-user credential. */
  getOptions?: (context: ExecutionContext) => ApiOptions | Promise<ApiOptions>;
  /** Optional auth adapter to use for credential resolution. */
  authAdapter?: AuthAdapter;
  /** Transport to use for the API. */
  transport?: 'stdio' | 'http' | 'sse';
}) {
  const registry = compileTools({ source, overlay });
  const tools = registry.tools.filter(
    (tool) =>
      (!allowedTools || allowedTools.has(tool.name)) &&
      Object.entries(annotationFilter).every(
        ([key, value]) => Reflect.get(tool.annotations, key) === value,
      ),
  );
  const server = new McpServer({ name, version });
  const resolveOptions = async (context: ExecutionContext): Promise<ApiOptions> => {
    if (authAdapter) {
      const headers = new Headers();
      if (context.requestInfo?.headers) {
        for (const [key, value] of Object.entries(context.requestInfo.headers)) {
          if (typeof value === 'string') headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(','));
        }
      }
      const resolution = await authAdapter.authenticate({
        headers,
        context,
        transport,
      });
      if (!resolution.ok) throw new Error(resolution.message);
      return resolution.apiOptions;
    }
    if (!getOptions) throw new Error('API credential configuration is missing.');
    return getOptions(context);
  };
  const execute = async ({
    name,
    input,
    context,
  }: {
    name: string;
    input: unknown;
    context: ExecutionContext;
  }) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return errorResult(`Unknown tool: ${name}`);
    const parsed = tool.plan.input.safeParse(input);
    if (!parsed.success) return errorResult(`Invalid input for tool ${name}.`);
    try {
      return await executeRequest({
        tool,
        input: parsed.data,
        options: await resolveOptions(context),
        servers: registry.servers,
        signal: context.signal,
      });
    } catch {
      return errorResult('API credential configuration failed.');
    }
  };
  if (mode === 'dynamic') registerDiscovery({ server, tools, execute });
  else
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.plan.input,
          annotations: tool.annotations,
        },
        (input: unknown, context: ExecutionContext) => execute({ name: tool.name, input, context }),
      );
    }
  return server;
}

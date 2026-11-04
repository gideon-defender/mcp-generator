import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { errorResult, executeRequest, type ApiOptions } from './client.js';
import { registerDiscovery } from './server/discovery.js';
import { compileTools, type CompiledTool } from './tools.js';
import {
  compositeResult,
  resolveCompositeTools,
  type CompositeCallTool,
  type CompositeToolDefinition,
  type CompositeToolEntry,
} from './composite.js';
import type { AuthAdapter } from './auth/types.js';

export type ExecutionContext = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type AnnotationFilter = Partial<
  Record<'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint', boolean>
>;

type RegistryTool =
  (CompiledTool & { kind: 'operation'; noInputParameters: boolean }) | CompositeToolEntry;

function inputParserOf(tool: RegistryTool) {
  return tool.kind === 'operation' ? tool.plan.input : tool.input;
}

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
  composites,
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
  /**
   * Product-authored tools that compose existing read-only operations.
   * Governed write composites are intentionally not accepted yet.
   */
  composites?: readonly CompositeToolDefinition[];
}) {
  const registry = compileTools({ source, overlay });
  const operationTools: RegistryTool[] = registry.tools.map((tool) => ({
    ...tool,
    kind: 'operation',
    noInputParameters: tool.plan.parameters.length === 0 && !tool.plan.body,
  }));
  const compositeTools = resolveCompositeTools({
    definitions: composites,
    operationTools: registry.tools,
  });
  const tools = [...operationTools, ...compositeTools.tools].filter(
    (tool) =>
      (!allowedTools || allowedTools.has(tool.name)) &&
      Object.entries(annotationFilter).every(
        ([key, value]) => Reflect.get(tool.annotations, key) === value,
      ),
  );
  // Restrict composite callers to the same tools exposed by policy: an allowlist
  // or read-only annotation filter must never be bypassed through a composite.
  const visibleTools = new Map<string, RegistryTool>(tools.map((tool) => [tool.name, tool]));
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
  // A single MCP request may fan out into at most this many upstream calls
  // through a composite; without a budget one request can consume unbounded
  // upstream quota and credential capacity.
  const MAX_COMPOSITE_SUBCALLS = 25;
  const execute = async ({
    name,
    input,
    context,
    preParsed = false,
  }: {
    name: string;
    input: unknown;
    context: ExecutionContext;
    /** Set when the caller (the MCP SDK) already validated the input; parsing it again would apply zod transforms twice. */
    preParsed?: boolean;
  }) => {
    const entry = visibleTools.get(name);
    if (!entry) return errorResult(`Unknown tool: ${name}`);
    // The MCP SDK validates arguments before a static-mode handler runs and
    // passes the parsed value. Parsing again would apply non-idempotent zod
    // transforms twice, so static mode passes preParsed: true. The dynamic
    // execute_tool path passes raw arguments and must parse here.
    let parsedData: unknown = input;
    if (!preParsed) {
      const parsed = inputParserOf(entry).safeParse(input);
      if (!parsed.success) return errorResult(`Invalid input for tool ${entry.name}.`);
      parsedData = parsed.data;
    }
    let options: ApiOptions;
    try {
      options = await resolveOptions(context);
    } catch {
      return errorResult('API credential configuration failed.');
    }
    if (entry.kind === 'operation') {
      return executeRequest({
        tool: entry,
        input: parsedData,
        options,
        servers: registry.servers,
        signal: context.signal,
      });
    }
    let subcalls = 0;
    const callTool: CompositeCallTool = async (toolName, toolInput = {}) => {
      subcalls += 1;
      if (subcalls > MAX_COMPOSITE_SUBCALLS)
        return errorResult('Composite exceeded the subcall limit.');
      const underlying = visibleTools.get(toolName);
      if (!underlying) return errorResult(`Unknown tool: ${toolName}`);
      if (underlying.kind !== 'operation')
        return errorResult('Composite tools cannot invoke composite tools.');
      if (underlying.classification !== 'read')
        return errorResult(`Tool ${toolName} is not available to read-only composite tools.`);
      const underlyingParsed = inputParserOf(underlying).safeParse(toolInput);
      if (!underlyingParsed.success) return errorResult(`Invalid input for tool ${toolName}.`);
      return executeRequest({
        tool: underlying,
        input: underlyingParsed.data,
        options,
        servers: registry.servers,
        signal: context.signal,
      });
    };
    try {
      const value = await entry.definition.run(parsedData, {
        context,
        signal: context.signal ?? new AbortController().signal,
        callTool,
      });
      return compositeResult(value);
    } catch {
      return errorResult(`Composite tool ${entry.name} failed.`);
    }
  };
  if (mode === 'dynamic') {
    registerDiscovery({
      server,
      tools: tools.map(({ name, description, inputSchema, noInputParameters }) => ({
        name,
        description,
        inputSchema,
        noInputParameters,
      })),
      execute,
    });
    return server;
  }
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputParserOf(tool),
        annotations: tool.annotations,
      },
      // The MCP SDK validates arguments before the handler runs and passes
      // the parsed value, so skip the internal parse to avoid double
      // applying zod transforms.
      (input: unknown, context: ExecutionContext) =>
        execute({ name: tool.name, input, context, preParsed: true }),
    );
  }
  return server;
}

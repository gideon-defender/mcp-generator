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

type RoutedTool = CompiledTool & { apiServerUrl?: string };
type Registry = { tools: RoutedTool[]; servers: string[] };
type RegistryTool =
  (RoutedTool & { kind: 'operation'; noInputParameters: boolean }) | CompositeToolEntry;

function inputParserOf(tool: RegistryTool) {
  return tool.kind === 'operation' ? tool.plan.input : tool.input;
}

export type ServerOptions = {
  name: string;
  version: string;
  mode?: 'static' | 'dynamic';
  /** Names after API namespace prefixes have been applied. */
  allowedTools?: ReadonlySet<string>;
  annotationFilter?: AnnotationFilter;
  /** Resolved independently for every invocation, never cached with the registry. */
  getOptions?: (context: ExecutionContext) => ApiOptions | Promise<ApiOptions>;
  authAdapter?: AuthAdapter;
  transport?: 'stdio' | 'http' | 'sse';
  composites?: readonly CompositeToolDefinition[];
};

export type ApiDefinition = {
  /** Stable lowercase namespace; tool names become `<id>-<operation-tool>`. */
  id: string;
  source: unknown;
  overlay: unknown;
  /** Operator-owned destination. Overrides spec metadata and credential adapter URLs. */
  serverUrl: string;
};

/** Compile independent contracts without merging paths or component schemas. */
function compileApis(apis: readonly ApiDefinition[]): Registry {
  if (!apis.length) throw new Error('At least one API is required.');
  const namespaces = new Set<string>();
  const names = new Set<string>();
  const tools: RoutedTool[] = [];
  for (const api of apis) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(api.id) || namespaces.has(api.id))
      throw new Error(`Invalid or duplicate API namespace: ${api.id}`);
    namespaces.add(api.id);
    const url = new URL(api.serverUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(`Invalid API server URL for ${api.id}`);
    const registry = compileTools(api);
    for (const tool of registry.tools) {
      const name = `${api.id}-${tool.name}`;
      if (name.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(name) || names.has(name))
        throw new Error(`Invalid or duplicate namespaced tool: ${name}`);
      names.add(name);
      tools.push({ ...tool, name, apiServerUrl: url.href });
    }
  }
  return { tools, servers: [] };
}

/** Compile once, then create isolated MCP sessions sharing only immutable tool definitions. */
export function createMultiApiServerFactory({
  apis,
  ...options
}: ServerOptions & { apis: readonly ApiDefinition[] }): () => McpServer {
  const registry = compileApis(apis);
  return () => createRegistryServer(options, registry);
}

export function createMultiApiServer(
  options: ServerOptions & { apis: readonly ApiDefinition[] },
): McpServer {
  return createMultiApiServerFactory(options)();
}

/** Existing single-API entry point retains its tool names and server override behavior. */
export function createOwnedServer({
  source,
  overlay,
  ...options
}: ServerOptions & { source: unknown; overlay: unknown }) {
  return createRegistryServer(options, compileTools({ source, overlay }));
}

function createRegistryServer(
  {
    name,
    version,
    mode = 'static',
    allowedTools,
    annotationFilter = {},
    getOptions,
    authAdapter,
    transport = 'stdio',
    composites,
  }: ServerOptions,
  registry: Registry,
) {
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
  const resolveOptions = async (
    context: ExecutionContext,
    tool: RegistryTool,
    input: unknown,
  ): Promise<ApiOptions> => {
    if (authAdapter) {
      const headers = new Headers();
      if (context.requestInfo?.headers) {
        for (const [key, value] of Object.entries(context.requestInfo.headers)) {
          if (typeof value === 'string') headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(','));
        }
      }
      const authContext = {
        headers,
        context,
        transport,
      };
      const authentication = await authAdapter.authenticate(authContext);
      if (!authentication.ok) throw new Error(authentication.message);
      const resolution = authAdapter.authorizeTool
        ? await authAdapter.authorizeTool({
            ...authContext,
            input,
            tool: {
              name: tool.name,
              classification: tool.classification,
              ...(tool.kind === 'operation'
                ? { operationId: tool.operationId, method: tool.method, path: tool.path }
                : {}),
            },
          })
        : authentication;
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
      options = await resolveOptions(context, entry, parsedData);
    } catch {
      return errorResult(
        authAdapter?.authorizeTool
          ? 'Tool authorization failed.'
          : 'API credential configuration failed.',
      );
    }
    if (entry.kind === 'operation') {
      return executeRequest({
        tool: entry,
        input: parsedData,
        options: entry.apiServerUrl ? { ...options, serverUrl: entry.apiServerUrl } : options,
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
      let subcallOptions = options;
      if (authAdapter?.authorizeTool) {
        try {
          subcallOptions = await resolveOptions(context, underlying, underlyingParsed.data);
        } catch {
          return errorResult('Tool authorization failed.');
        }
      }
      return executeRequest({
        tool: underlying,
        input: underlyingParsed.data,
        options: underlying.apiServerUrl
          ? { ...subcallOptions, serverUrl: underlying.apiServerUrl }
          : subcallOptions,
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

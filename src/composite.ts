import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { textResult } from './results.js';
import type { ExecutionContext } from './server.js';
import type { CompiledTool } from './tools.js';

const COMPOSITE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_TOOL_NAMES = new Set(['list_tools', 'describe_tool_input', 'execute_tool']);
const COMPOSITE_SCHEMA_LABEL = 'Composite tool';
/** Build and start refuse composite modules larger than this (mirrors the spec size limit). */
export const MAX_COMPOSITE_MODULE_BYTES = 32 * 1024 * 1024;

export type CompositeCallTool = (toolName: string, input?: unknown) => Promise<CallToolResult>;

export type CompositeRunEnvironment = {
  /** The raw MCP request context; request-scoped credentials are not shared with other callers. */
  context: ExecutionContext;
  /** Aborts when the MCP request is cancelled or the server shuts down. */
  signal: AbortSignal;
  /** May only call visible, read-classified operation tools; nested composites are rejected. */
  callTool: CompositeCallTool;
};

export type CompositeToolDefinition<Input extends z.ZodTypeAny = z.ZodTypeAny> = {
  /** Lowercase kebab-case name. It must not collide with an operation tool or discovery tool. */
  name: string;
  /** Long-form product description shown to the model. */
  description: string;
  /** Short display title. Defaults to `name`. */
  title?: string;
  /** Only `read` exists for now. `mutate` is deferred until governed writes are approved. */
  classification?: 'read';
  input: Input;
  run(args: z.infer<Input>, env: CompositeRunEnvironment): unknown | Promise<unknown>;
};

type CompositeAnnotations = {
  title: string;
  readOnlyHint: true;
  destructiveHint: false;
  idempotentHint: true;
  openWorldHint: true;
};
export type CompositeToolEntry = {
  kind: 'composite';
  name: string;
  description: string;
  inputSchema: unknown;
  staticInputSchema: unknown;
  input: z.ZodTypeAny;
  annotations: CompositeAnnotations;
  classification: 'read';
  definition: CompositeToolDefinition;
  noInputParameters: boolean;
};
export type ResolvedCompositeTools = {
  tools: CompositeToolEntry[];
};

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    !!value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)
  );
}

export { textResult } from './results.js';

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value ?? null));
}

/** Parses the first text content block produced by an underlying tool. Fails closed on non-JSON. */
export function parseToolJsonResult(result: CallToolResult): unknown {
  const block = (result.content as unknown[]).find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { type?: unknown }).type === 'text' &&
      typeof (candidate as { text?: unknown }).text === 'string',
  ) as { type: 'text'; text: string } | undefined;
  if (!block) throw new Error('Expected text response from tool.');
  try {
    return JSON.parse(block.text) as unknown;
  } catch {
    throw new Error('Expected JSON response from tool.');
  }
}

export function compositeResult(value: unknown): CallToolResult {
  return isCallToolResult(value) ? value : jsonResult(value);
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Composite description must be a non-empty string.');
  return value;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !COMPOSITE_NAME_PATTERN.test(value) || value.length > 64) {
    throw new Error(
      `Composite tool name must be lowercase kebab-case and at most 64 characters: ${String(value)}`,
    );
  }
  return value;
}

function requireReadClassification(value: unknown): 'read' {
  if (value === undefined || value === 'read') return 'read';
  throw new Error(
    'Composite tools with classification "mutate" are not supported yet (governed writes deferred).',
  );
}

function compileInputSchemas({ input, name }: { input: z.ZodTypeAny; name: string }) {
  try {
    return {
      // Same pair used for operation tools: 2020-12 for MCP clients, draft-7 for older clients.
      inputSchema: z.toJSONSchema(input, { io: 'input', target: 'draft-2020-12' }),
      staticInputSchema: z.toJSONSchema(input, { io: 'input', target: 'draft-7' }),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${COMPOSITE_SCHEMA_LABEL} "${name}" input schema does not compile: ${detail}`,
      {
        cause: err,
      },
    );
  }
}

function schemaHasNoInputParameters(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const schema = value as Record<string, unknown>;
  const type = schema['type'];
  const properties = schema['properties'];
  const required = schema['required'];
  if (type !== 'object') return false;
  if (Array.isArray(required) && required.length) return false;
  // Free-form object inputs (records, loose objects, pattern properties)
  // take arguments; a missing `properties` key does not mean "no input".
  if (schema['propertyNames'] !== undefined || schema['patternProperties'] !== undefined)
    return false;
  const additionalProperties = schema['additionalProperties'];
  if (
    additionalProperties === true ||
    (additionalProperties !== null && typeof additionalProperties === 'object')
  )
    return false;
  if (!properties || typeof properties !== 'object') return true;
  return Object.keys(properties as Record<string, unknown>).length === 0;
}

/** Validates a composite list and returns tool entries ready for the normal MCP registry. */
export function resolveCompositeTools({
  definitions,
  operationTools,
}: {
  definitions: readonly CompositeToolDefinition[] | undefined;
  operationTools: readonly CompiledTool[];
}): ResolvedCompositeTools {
  const entries: CompositeToolEntry[] = [];
  const seen = new Set<string>();
  const operationNames = new Set(operationTools.map((tool) => tool.name));
  for (const definition of definitions ?? []) {
    if (!definition || typeof definition !== 'object')
      throw new Error('Composite definition must be an object.');
    const rawName = (definition as CompositeToolDefinition).name;
    // Reserved names are rejected before the kebab-case check so the
    // reserved error is reachable and accurate (the reserved names all
    // contain underscores and would otherwise fail the pattern first).
    if (typeof rawName === 'string' && RESERVED_TOOL_NAMES.has(rawName))
      throw new Error(`Composite tool name is reserved: ${rawName}`);
    const name = normalizeName(rawName);
    if (operationNames.has(name))
      throw new Error(`Composite tool name collides with an operation tool: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate composite tool name: ${name}`);
    const description = normalizeDescription(definition.description);
    requireReadClassification(definition.classification);
    if (typeof definition.input?.safeParse !== 'function')
      throw new Error(`Composite tool "${name}" must provide a zod input schema.`);
    if (typeof definition.run !== 'function')
      throw new Error(`Composite tool "${name}" must provide a run(args, env) function.`);
    const schemas = compileInputSchemas({ input: definition.input, name });
    // MCP arguments are a JSON object; a scalar/union input compiles but
    // could never be called, so reject it at startup instead of bricking the tool.
    const rootType = (schemas.inputSchema as { type?: unknown }).type;
    if (rootType !== 'object')
      throw new Error(`Composite tool "${name}" input must be an object schema.`);
    seen.add(name);
    entries.push({
      kind: 'composite',
      name,
      description,
      input: definition.input,
      ...schemas,
      annotations: {
        title: definition.title?.trim() || name,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      classification: 'read',
      definition,
      noInputParameters: schemaHasNoInputParameters(schemas.inputSchema),
    });
  }
  return {
    tools: entries,
  };
}

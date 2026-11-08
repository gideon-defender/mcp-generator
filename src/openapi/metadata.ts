import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const objectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof objectSchema>;
export const metadataSchema = z
  .object({
    name: z.string().min(1).optional(),
    disabled: z.boolean().optional(),
    description: z.string().min(1).optional(),
    classification: z.enum(['read', 'mutate']).optional(),
    upstream: z.string().min(1).optional(),
    redaction: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
    /** Scalar JSON-pointer leaves to retain; wildcards match array items only. */
    responseFields: z
      .array(z.string().regex(/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/))
      .min(1)
      .optional(),
    /** Preserve bounded, sanitized response status/request-ID/retry metadata. */
    responseMetadata: z.boolean().optional(),
    maxResponseBytes: z.number().int().min(1024).max(16_777_216).optional(),
    /** Overrides the Accept header derived from the declared response media types. */
    accept: z.string().min(1).optional(),
  })
  .strict();
export type McpMetadata = z.infer<typeof metadataSchema>;
export const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export function readMetadata(operation: JsonObject): McpMetadata {
  return operation['x-comp-mcp'] === undefined ? {} : metadataSchema.parse(operation['x-comp-mcp']);
}

export type OperationEntry = { path: string; method: string; operation: JsonObject };

/**
 * `x-speakeasy-mcp` is no longer read. A spec that still carries it loads only
 * when `x-comp-mcp` holds the same values, so a `disabled`, `classification`
 * or `redaction` setting is never silently dropped.
 */
export function assertNoUnmirroredLegacyMetadata(entries: OperationEntry[]): void {
  for (const { operation } of entries) {
    const legacy = operation['x-speakeasy-mcp'];
    if (legacy === undefined) continue;
    const owned = objectSchema.parse(operation['x-comp-mcp'] ?? {});
    const unmirrored = Object.entries(objectSchema.parse(legacy))
      .filter(([key, value]) => !isDeepStrictEqual(owned[key], value))
      .map(([key]) => key);
    if (unmirrored.length)
      throw new Error(
        `Unsupported x-speakeasy-mcp on ${String(operation['operationId'])}: ` +
          `${unmirrored.join(', ')} not set to the same value in x-comp-mcp; move it to x-comp-mcp`,
      );
  }
}

export function operationEntries(paths: Record<string, JsonObject>): OperationEntry[] {
  return Object.entries(paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const value = item[method];
      if (value === undefined) return [];
      const operation = objectSchema.parse(value);
      item[method] = operation;
      return [{ path, method, operation }];
    }),
  );
}

function kebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

export function assignToolNames(entries: OperationEntry[]): void {
  const used = new Set<string>();
  for (const { operation } of entries) {
    const metadata = readMetadata(operation);
    if (metadata.name) {
      if (used.has(metadata.name)) throw new Error(`Duplicate MCP name: ${metadata.name}`);
      used.add(metadata.name); // Reserve disabled names as well as active names.
    }
    operation['x-comp-mcp'] = metadata;
  }
  for (const { operation } of entries) {
    const metadata = readMetadata(operation);
    if (metadata.name || metadata.disabled) continue;
    const id = z
      .string()
      .min(1)
      .parse(operation['operationId'])
      .replace(/_v\d+$/i, '');
    const separator = id.indexOf('_');
    const resource = separator < 0 ? '' : id.slice(0, separator).replace(/Controller$/i, '');
    const method = separator < 0 ? id : id.slice(separator + 1);
    let candidate = kebab(method);
    if (!candidate || used.has(candidate)) candidate = kebab(`${resource}-${method}`);
    let name = candidate;
    let suffix = 2;
    while (used.has(name)) name = `${candidate}-${suffix++}`;
    if (!name) throw new Error(`Cannot derive MCP name: ${id}`);
    used.add(name);
    operation['x-comp-mcp'] = { ...metadata, name };
  }
}

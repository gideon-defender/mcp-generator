import { z } from 'zod';
import {
  assertNoUnmirroredLegacyMetadata,
  assignToolNames,
  metadataSchema,
  objectSchema,
  operationEntries,
  readMetadata,
} from './openapi/metadata.js';
import { applyOwnedOverlay, overlaySchema } from './openapi/overlay.js';

const documentSchema = z
  .object({
    openapi: z.string().startsWith('3.'),
    paths: z.record(z.string(), objectSchema),
  })
  .passthrough();

// Owns the metadata/overlay registry only; schema compilation (schema/compiler.ts)
// and HTTP execution (client.ts) are separate layers built on top of it in tools.ts.
export function loadOpenApi({ source, overlay }: { source: unknown; overlay: unknown }) {
  const document = documentSchema.parse(structuredClone(source));
  const policy = overlaySchema.parse(overlay);
  const entries = operationEntries(document.paths);
  assertNoUnmirroredLegacyMetadata(entries);
  assignToolNames(entries);
  applyOwnedOverlay({ document, entries, overlay: policy });
  // Validate explicit overlay name changes against all names, including disabled.
  const names = new Set<string>();
  for (const { operation } of entries) {
    const metadata = metadataSchema.parse(operation['x-comp-mcp']);
    if (!metadata.name) continue;
    if (names.has(metadata.name)) throw new Error(`Duplicate MCP name: ${metadata.name}`);
    names.add(metadata.name);
  }
  const tools = entries.flatMap(({ path, method, operation }) => {
    const metadata = readMetadata(operation);
    if (metadata.disabled) return [];
    const name = z.string().min(1).parse(metadata.name);
    const operationId = z.string().min(1).parse(operation['operationId']);
    const summary = z.string().min(1).parse(operation['summary']);
    const description = z.string().min(1).parse(operation['description']);
    if (
      policy.allowlist &&
      !policy.allowlist.includes(name) &&
      !policy.allowlist.includes(operationId)
    )
      return [];
    return [
      {
        name,
        description: metadata.description ?? `${summary}\n\n${description}`,
        classification:
          metadata.classification ??
          (['get', 'head', 'options'].includes(method) ? 'read' : 'mutate'),
        upstream: metadata.upstream,
        redaction: metadata.redaction,
        method,
        path,
        operationId,
        operation,
      },
    ];
  });
  return { document, tools };
}

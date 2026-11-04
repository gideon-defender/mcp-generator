import { objectSchema, readMetadata, type JsonObject } from '../openapi/metadata.js';

// An `accept` set in the operation's MCP metadata wins. Otherwise prefer
// `application/json` when a response declares it, then the first declared
// media type, then `*/*`.
export function responseAccept(operation: JsonObject): string {
  const override = readMetadata(operation).accept;
  if (override) return override;
  const responses = objectSchema.parse(operation['responses'] ?? {});
  const mediaTypes = [
    ...new Set(
      Object.values(responses).flatMap((response) =>
        Object.keys(objectSchema.parse(objectSchema.parse(response)['content'] ?? {})),
      ),
    ),
  ];
  if (mediaTypes.includes('application/json')) return 'application/json';
  return mediaTypes[0] ?? '*/*';
}

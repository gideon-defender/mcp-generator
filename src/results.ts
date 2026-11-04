import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A single text content block; the common shape for tool results. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

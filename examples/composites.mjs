/**
 * Example product-authored composite module for the example API in this repo.
 * Copy it into your product repository, replace the composition with your own,
 * and point `composites.module` at the compiled file.
 */
import { z } from 'zod';
import { jsonResult, parseToolJsonResult } from '@gideon/mcp-generator';

export const composites = [
  {
    name: 'health-summary',
    description: 'Return the example service health in a product-friendly summary.',
    title: 'Health summary',
    input: z.object({}),
    async run(_args, { callTool }) {
      const result = await callTool('get-health', {});
      if (result.isError) return result;
      return jsonResult({
        health: parseToolJsonResult(result),
        checkedAt: new Date().toISOString(),
      });
    },
  },
];

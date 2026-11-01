import { z } from 'zod';

export const McpProjectConfigSchema = z
  .object({
    identity: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    spec: z.object({ path: z.string().min(1) }).strict(),
    overlay: z.string().min(1),
    output: z
      .object({
        dir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type McpProjectConfig = z.infer<typeof McpProjectConfigSchema>;

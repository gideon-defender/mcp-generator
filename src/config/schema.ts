import { z } from 'zod';

export const McpProjectConfigSchema = z
  .object({
    identity: z
      .object({
        name: z.string().min(1),
        displayName: z.string().min(1).optional(),
        version: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    spec: z
      .object({
        path: z.string().min(1),
        format: z.enum(['json', 'yaml']).optional(),
      })
      .strict(),
    overlay: z.string().min(1),
    upstreams: z
      .record(
        z.string(),
        z
          .object({
            baseUrlEnv: z.string().min(1).optional(),
            url: z
              .string()
              .url()
              .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
                message: 'url must be http or https',
              })
              .optional(),
          })
          .strict(),
      )
      .optional(),
    auth: z
      .object({
        adapter: z.string().min(1).optional(),
        audience: z.string().optional(),
        issuerEnv: z.string().optional(),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        mode: z.enum(['static', 'dynamic']).optional(),
        defaultClassification: z.enum(['read', 'mutate']).optional(),
      })
      .strict()
      .optional(),
    output: z
      .object({
        dir: z.string().min(1).optional(),
        bin: z.string().min(1).optional(),
        manifest: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type McpProjectConfig = z.infer<typeof McpProjectConfigSchema>;

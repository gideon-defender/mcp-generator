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
        generatorDependency: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        mode: z.enum(['oauth']),
        issuer: z.string().min(1).optional(),
        audience: z.string().min(1).optional(),
        jwksUrl: z.string().url().optional(),
        requiredScopes: z.array(z.string().min(1)).optional(),
        upstreamBearerToken: z.boolean().optional(),
      })
      .strict()
      .optional(),
    hosted: z
      .object({
        transport: z.enum(['http', 'sse']).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        host: z.string().min(1).optional(),
        maxRequestBodyBytes: z.number().int().positive().max(16_777_216).optional(),
        allowedOrigins: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.auth?.mode !== 'oauth') return;
    for (const [key, value] of Object.entries({
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      jwksUrl: config.auth.jwksUrl,
    })) {
      if (!value)
        context.addIssue({
          code: 'custom',
          message: `OAuth auth requires ${key}.`,
          path: ['auth', key],
        });
    }
  });

export type McpProjectConfig = z.infer<typeof McpProjectConfigSchema>;

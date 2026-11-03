import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readDocument } from '../fs/read-document.js';
import { assertPathWithinCwd } from '../fs/safe-path.js';
import { compileTools } from '../tools.js';
import type { McpProjectConfig } from '../config/schema.js';

async function readGeneratorPackage(): Promise<{
  name: string;
  version: string;
  dependencies: Record<string, string>;
}> {
  const packageText = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  return JSON.parse(packageText) as {
    name: string;
    version: string;
    dependencies: Record<string, string>;
  };
}

function exactDependencyVersion(versionRange: string): string {
  return versionRange.replace(/^[~^<>=v\s]+/, '').trim();
}

export async function buildFromConfig(config: McpProjectConfig, cwd: string = process.cwd()) {
  const resolvedCwd = resolve(cwd);
  const specPath = resolve(resolvedCwd, config.spec.path);
  const overlayPath = resolve(resolvedCwd, config.overlay);
  const outputDir = resolve(resolvedCwd, config.output?.dir ?? 'dist');

  assertPathWithinCwd(specPath, resolvedCwd, 'spec.path');
  assertPathWithinCwd(overlayPath, resolvedCwd, 'overlay');
  assertPathWithinCwd(outputDir, resolvedCwd, 'output.dir');
  if (outputDir === resolvedCwd) {
    throw new Error('output.dir must be a subdirectory of the working directory');
  }

  const { text: specText, value: source } = await readDocument({
    filePath: specPath,
    label: 'spec',
    shownPath: config.spec.path,
  });
  const { text: overlayText, value: overlay } = await readDocument({
    filePath: overlayPath,
    label: 'overlay',
    shownPath: config.overlay,
  });

  let tools;
  try {
    tools = compileTools({ source, overlay }).tools;
  } catch (err) {
    throw new Error(`Failed to compile tools: ${err instanceof Error ? err.message : String(err)}`);
  }
  const toolNames = tools.map(({ name, description }) => ({ name, description }));
  const specSha256 = createHash('sha256').update(specText).digest('hex');
  const overlaySha256 = createHash('sha256').update(overlayText).digest('hex');
  const name = config.identity?.name ?? 'mcp-server';
  const version = config.identity?.version ?? '0.0.0';
  const auth = config.auth;
  const hosted = config.hosted;
  const isHosted = hosted !== undefined;
  const generatorPackage = await readGeneratorPackage();
  const sdkVersionRange = generatorPackage.dependencies['@modelcontextprotocol/sdk'];
  if (!sdkVersionRange) {
    throw new Error('Generator package is missing @modelcontextprotocol/sdk dependency metadata');
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'tool-names.json'), `${JSON.stringify(toolNames, null, 2)}\n`);
  await writeFile(
    resolve(outputDir, 'contract-revision.json'),
    `${JSON.stringify(
      {
        name: config.identity?.name,
        specSha256,
        overlaySha256,
        tools: tools.length,
        version,
      },
      null,
      2,
    )}\n`,
  );

  const packageName =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|-+$/g, '') || 'mcp-server';
  const generatedPackageText = `${JSON.stringify(
    {
      name: packageName,
      version,
      private: true,
      type: 'module',
      scripts: { start: 'node server.mjs' },
      dependencies: {
        [generatorPackage.name]: config.output?.generatorDependency ?? generatorPackage.version,
        '@modelcontextprotocol/sdk': exactDependencyVersion(sdkVersionRange),
        ...(hosted
          ? {
              express: exactDependencyVersion(generatorPackage.dependencies['express'] ?? '^5.2.1'),
              jose: exactDependencyVersion(generatorPackage.dependencies['jose'] ?? '^6.2.0'),
            }
          : {}),
      },
    },
    null,
    2,
  )}\n`;
  await writeFile(resolve(outputDir, 'package.json'), generatedPackageText);

  const authMode = auth?.mode;
  if (isHosted && authMode !== 'oauth')
    throw new Error('Hosted builds require auth.mode to be "oauth"');
  const hostedAuthEntry = `const authAdapter = oauthAuth({
  issuer: ${JSON.stringify(auth?.issuer ?? '')},
  audience: ${JSON.stringify(auth?.audience ?? '')},
  jwksUrl: ${JSON.stringify(auth?.jwksUrl ?? '')},
  requiredScopes: ${JSON.stringify(auth?.requiredScopes ?? [])},
  upstreamBearerToken: ${JSON.stringify(auth?.upstreamBearerToken ?? false)},
});`;
  const serverEntry = isHosted
    ? `import { createOwnedServer, oauthAuth, createHostedServer } from '@gideon/mcp-generator';

const source = ${JSON.stringify(source, null, 2)};
const overlay = ${JSON.stringify(overlay, null, 2)};

${hostedAuthEntry}
const createServerForSession = () => createOwnedServer({
  name: ${JSON.stringify(name)},
  version: ${JSON.stringify(version)},
  source,
  overlay,
  authAdapter,
  transport: ${JSON.stringify(hosted?.transport ?? 'http')},
});
const hostedServer = await createHostedServer({
  createServerForSession,
  port: ${JSON.stringify(hosted?.port ?? 3000)},
  transport: ${JSON.stringify(hosted?.transport ?? 'http')},
  authAdapter,
  host: ${JSON.stringify(hosted?.host ?? '127.0.0.1')},
  maxRequestBodyBytes: ${JSON.stringify(hosted?.maxRequestBodyBytes ?? 1_048_576)},
  allowedOrigins: ${JSON.stringify(hosted?.allowedOrigins ?? [])},
});
await hostedServer.listen();
const shutdown = async () => {
  await hostedServer.close();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
`
    : `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOwnedServer } from '@gideon/mcp-generator';

const source = ${JSON.stringify(source, null, 2)};
const overlay = ${JSON.stringify(overlay, null, 2)};

const apiKey = process.env.MCP_GENERATOR_APIKEY?.trim();
const bearerToken = process.env.MCP_GENERATOR_BEARER_TOKEN?.trim();
if ((!apiKey && !bearerToken) || (apiKey && bearerToken)) {
  throw new Error('Provide exactly one of MCP_GENERATOR_APIKEY or MCP_GENERATOR_BEARER_TOKEN');
}

const apiOptions = apiKey ? { apiKey } : { bearerToken };
const server = createOwnedServer({
  name: ${JSON.stringify(name)},
  version: ${JSON.stringify(version)},
  source,
  overlay,
  getOptions: () => apiOptions,
});

await server.connect(new StdioServerTransport());
`;
  await writeFile(resolve(outputDir, 'server.mjs'), serverEntry);

  await writeFile(
    resolve(outputDir, 'artifact.json'),
    `${JSON.stringify(
      {
        format: 1,
        name,
        version,
        specSha256,
        overlaySha256,
        tools: tools.length,
        entrypoint: 'server.mjs',
        packageSha256: createHash('sha256').update(generatedPackageText).digest('hex'),
        serverSha256: createHash('sha256').update(serverEntry).digest('hex'),
      },
      null,
      2,
    )}\n`,
  );

  return { tools, toolNames, outputDir };
}

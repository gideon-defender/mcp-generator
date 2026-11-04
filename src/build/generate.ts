import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { readDocument } from '../fs/read-document.js';
import { assertPathWithinCwd } from '../fs/safe-path.js';
import { assertWritableFile, withPinnedOutputDir } from '../fs/output-dir.js';
import { compileTools } from '../tools.js';
import { MAX_COMPOSITE_MODULE_BYTES } from '../composite.js';
import type { McpProjectConfig } from '../config/schema.js';

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

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

/**
 * Writes the artifact into `output.dir`. While writing, the process working
 * directory is switched to the output directory (see `withPinnedOutputDir`),
 * so do not run other working-directory-relative work, another build, or an
 * audit concurrently in the same process, and do not call it from a worker thread.
 */
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
    throw new Error(
      `Failed to compile tools: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }

  let compositesSha256: string | undefined;
  let compositesModuleBytes: Buffer | undefined;
  if (config.composites) {
    const modulePath = resolve(resolvedCwd, config.composites.module);
    assertPathWithinCwd(modulePath, resolvedCwd, 'composites.module');
    let moduleStat;
    try {
      moduleStat = await lstat(modulePath);
    } catch {
      throw new Error(`composites.module does not exist: ${config.composites.module}`);
    }
    if (!moduleStat.isFile() || moduleStat.isSymbolicLink())
      throw new Error('composites.module must be a real file');
    if (moduleStat.size > MAX_COMPOSITE_MODULE_BYTES)
      throw new Error(
        `composites.module is ${moduleStat.size} bytes; the limit is ${MAX_COMPOSITE_MODULE_BYTES} bytes`,
      );
    const extension = extname(modulePath).toLowerCase();
    if (extension !== '.mjs' && extension !== '.js')
      throw new Error('composites.module must be a compiled .js or .mjs file');
    compositesModuleBytes = await readFile(modulePath);
    compositesSha256 = sha256Hex(compositesModuleBytes);
  }
  const toolNames = tools.map(({ name, description }) => ({ name, description }));
  const specSha256 = sha256Hex(specText);
  const overlaySha256 = sha256Hex(overlayText);
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
  const zodVersionRange = compositesSha256 ? generatorPackage.dependencies['zod'] : undefined;
  if (compositesSha256 && !zodVersionRange) {
    throw new Error('Generator package is missing zod dependency metadata');
  }

  // Every artifact write happens inside withPinnedOutputDir below; a pathname
  // check alone does not bind the writes (a local writer can rename the
  // output directory and plant a symlink at its path, or drop a symlink at
  // an artifact path; both are refused there).
  const contractComposites = compositesSha256
    ? { composites: { module: 'composites.mjs', sha256: compositesSha256 } }
    : {};
  const toolNamesText = `${JSON.stringify(toolNames, null, 2)}\n`;
  const contractRevisionText = `${JSON.stringify(
    {
      name: config.identity?.name,
      specSha256,
      overlaySha256,
      tools: tools.length,
      version,
      ...contractComposites,
    },
    null,
    2,
  )}\n`;

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
        // Product composites import zod directly; it is not otherwise part of the artifact.
        ...(zodVersionRange ? { zod: exactDependencyVersion(zodVersionRange) } : {}),
      },
    },
    null,
    2,
  )}\n`;
  const compositesImport = compositesSha256
    ? `import { composites } from './composites.mjs';\n`
    : '';
  const compositesCheck = compositesSha256
    ? `if (!Array.isArray(composites)) {
  throw new Error('Composite module must export a named "composites" array');
}
`
    : '';
  const compositesCreate = compositesSha256 ? '  composites,\n' : '';
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
    ? `${compositesImport}import { createOwnedServer, oauthAuth, createHostedServer } from '@gideon/mcp-generator';

const source = ${JSON.stringify(source, null, 2)};
const overlay = ${JSON.stringify(overlay, null, 2)};

${compositesCheck}${hostedAuthEntry}
const createServerForSession = () => createOwnedServer({
  name: ${JSON.stringify(name)},
  version: ${JSON.stringify(version)},
  source,
  overlay,
  authAdapter,
  transport: ${JSON.stringify(hosted?.transport ?? 'http')},
${compositesCreate}});
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
    : `${compositesImport}import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOwnedServer } from '@gideon/mcp-generator';

const source = ${JSON.stringify(source, null, 2)};
const overlay = ${JSON.stringify(overlay, null, 2)};

${compositesCheck}
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
${compositesCreate}  getOptions: () => apiOptions,
});

await server.connect(new StdioServerTransport());
`;
  const artifactJsonText = `${JSON.stringify(
    {
      format: 1,
      name,
      version,
      specSha256,
      overlaySha256,
      tools: tools.length,
      entrypoint: 'server.mjs',
      packageSha256: sha256Hex(generatedPackageText),
      serverSha256: sha256Hex(serverEntry),
      ...contractComposites,
    },
    null,
    2,
  )}\n`;

  await mkdir(outputDir, { recursive: true });
  await withPinnedOutputDir({
    outDir: outputDir,
    run: async ({ outDir: pinnedDir }) => {
      // The pinned directory is held by file handle, so a later swap of the
      // output path cannot redirect these writes. Each destination is also
      // checked: a symlink or directory planted at an artifact path is
      // refused instead of followed.
      const writeArtifact = async (name: string, contents: string | Buffer): Promise<void> => {
        const destination = join(pinnedDir, name);
        await assertWritableFile({ filePath: destination });
        await writeFile(destination, contents);
      };
      // Keep the copy at the artifact root so the generated server can import
      // it with a relative path. The copy is the exact buffer whose SHA-256
      // is recorded in artifact.json and contract-revision.json.
      if (compositesModuleBytes) await writeArtifact('composites.mjs', compositesModuleBytes);
      await writeArtifact('tool-names.json', toolNamesText);
      await writeArtifact('contract-revision.json', contractRevisionText);
      await writeArtifact('package.json', generatedPackageText);
      await writeArtifact('server.mjs', serverEntry);
      await writeArtifact('artifact.json', artifactJsonText);
    },
  });

  return { tools, toolNames, outputDir };
}

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readDocument } from '../fs/read-document.js';
import { assertPathWithinCwd } from '../fs/safe-path.js';
import { compileTools } from '../tools.js';
import type { McpProjectConfig } from '../config/schema.js';

export async function buildFromConfig(config: McpProjectConfig, cwd: string = process.cwd()) {
  const resolvedCwd = resolve(cwd);
  const specPath = resolve(resolvedCwd, config.spec.path);
  const overlayPath = resolve(resolvedCwd, config.overlay);
  const outputDir = resolve(resolvedCwd, config.output?.dir ?? 'dist');

  assertPathWithinCwd(specPath, resolvedCwd, 'spec.path');
  assertPathWithinCwd(overlayPath, resolvedCwd, 'overlay');
  assertPathWithinCwd(outputDir, resolvedCwd, 'output.dir');

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
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'tool-names.json'), `${JSON.stringify(toolNames, null, 2)}\n`);
  await writeFile(
    resolve(outputDir, 'contract-revision.json'),
    `${JSON.stringify(
      {
        name: config.identity?.name,
        specSha256: createHash('sha256').update(specText).digest('hex'),
        overlaySha256: createHash('sha256').update(overlayText).digest('hex'),
        tools: tools.length,
        version: config.identity?.version ?? '0.0.0',
      },
      null,
      2,
    )}\n`,
  );

  return { tools, toolNames, outputDir };
}

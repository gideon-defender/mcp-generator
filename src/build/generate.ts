import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertPathWithinCwd } from '../fs/safe-path.js';
import { compileTools } from '../tools.js';
import type { McpProjectConfig } from '../config/schema.js';

export async function buildFromConfig(config: McpProjectConfig, cwd: string = process.cwd()) {
  const resolvedCwd = resolve(cwd);
  const specPath = resolve(resolvedCwd, config.spec.path);
  const overlayPath = resolve(resolvedCwd, config.overlay);

  assertPathWithinCwd(specPath, resolvedCwd, 'spec.path');
  assertPathWithinCwd(overlayPath, resolvedCwd, 'overlay');

  let specText: string;
  let overlayText: string;
  try {
    specText = await readFile(specPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read spec from ${config.spec.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    overlayText = await readFile(overlayPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read overlay from ${config.overlay}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let source: unknown;
  if (config.spec.format === 'yaml' || specPath.endsWith('.yaml') || specPath.endsWith('.yml')) {
    source = parseYaml(specText);
  } else if (config.spec.format === 'json' || specPath.endsWith('.json')) {
    source = JSON.parse(specText);
  } else {
    try {
      source = JSON.parse(specText);
    } catch {
      source = parseYaml(specText);
    }
  }

  let overlay: unknown;
  if (overlayPath.endsWith('.yaml') || overlayPath.endsWith('.yml')) {
    overlay = parseYaml(overlayText);
  } else if (overlayPath.endsWith('.json')) {
    overlay = JSON.parse(overlayText);
  } else {
    try {
      overlay = JSON.parse(overlayText);
    } catch {
      overlay = parseYaml(overlayText);
    }
  }

  let tools;
  try {
    const compiled = compileTools({ source, overlay });
    tools = compiled.tools;
  } catch (err) {
    throw new Error(`Failed to compile tools: ${err instanceof Error ? err.message : String(err)}`);
  }
  const toolNames = tools.map(({ name, description }) => ({ name, description }));
  const outputDir = resolve(cwd, config.output?.dir ?? 'dist');
  assertPathWithinCwd(outputDir, resolvedCwd, 'output.dir');
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'tool-names.json'), `${JSON.stringify(toolNames, null, 2)}\n`);
  await writeFile(
    resolve(outputDir, 'contract-revision.json'),
    `${JSON.stringify(
      {
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

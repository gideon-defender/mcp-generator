import { resolve } from 'node:path';
import { assertPathWithinCwd } from '../fs/safe-path.js';
import { readDocument } from '../fs/read-document.js';
import { McpProjectConfigSchema, type McpProjectConfig } from './schema.js';

export async function loadConfig(
  configPath: string,
  cwd: string = process.cwd(),
): Promise<McpProjectConfig> {
  const resolvedCwd = resolve(cwd);
  const fullPath = resolve(resolvedCwd, configPath);
  assertPathWithinCwd(fullPath, resolvedCwd, 'config path');
  const { value } = await readDocument({
    filePath: fullPath,
    label: 'config',
    shownPath: configPath,
  });
  try {
    return McpProjectConfigSchema.parse(value);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Invalid config at ${fullPath}: ${err.message}`);
    }
    throw err;
  }
}

export function resolveConfigPath(cwd: string = process.cwd()): string {
  return resolve(cwd, 'mcp.config.json');
}

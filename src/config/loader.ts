import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertPathWithinCwd } from '../fs/safe-path.js';
import { McpProjectConfigSchema, type McpProjectConfig } from './schema.js';

export async function loadConfig(
  configPath: string,
  cwd: string = process.cwd(),
): Promise<McpProjectConfig> {
  const resolvedCwd = resolve(cwd);
  const fullPath = resolve(resolvedCwd, configPath);
  assertPathWithinCwd(fullPath, resolvedCwd, 'config path');
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  if (fullPath.endsWith('.json')) {
    parsed = JSON.parse(raw);
  } else if (fullPath.endsWith('.yaml') || fullPath.endsWith('.yml')) {
    parsed = parseYaml(raw);
  } else {
    let jsonError: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      jsonError = err;
      try {
        parsed = parseYaml(raw);
      } catch (yamlErr) {
        const msg = jsonError instanceof Error ? jsonError.message : String(jsonError);
        const ymsg = yamlErr instanceof Error ? yamlErr.message : String(yamlErr);
        throw new Error(`Failed to parse config as JSON (${msg}) or YAML (${ymsg})`);
      }
    }
  }
  try {
    return McpProjectConfigSchema.parse(parsed);
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

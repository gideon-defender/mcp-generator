#!/usr/bin/env node
import { buildFromConfig } from '../build/generate.js';
import { loadConfig, resolveConfigPath } from '../config/loader.js';
import { assertPathWithinCwd } from '../fs/safe-path.js';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];

async function main() {
  if (cmd === 'build') {
    const configPath = args[1] ? args[1] : resolveConfigPath(process.cwd());
    try {
      const cwd = process.cwd();
      const resolvedConfig = resolve(cwd, configPath);
      assertPathWithinCwd(resolvedConfig, cwd, 'config path');
      const config = await loadConfig(configPath, cwd);
      const result = await buildFromConfig(config, cwd);
      console.log(`Built ${result.tools.length} tools -> ${result.outputDir}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  }
  if (cmd === 'init') {
    console.error('Error: init not implemented in this phase');
    process.exit(1);
  }
  console.log('Usage: mcp-generator build [config.json]');
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

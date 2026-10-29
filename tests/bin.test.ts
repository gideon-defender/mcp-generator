import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const BIN = join(process.cwd(), 'src', 'bin', 'mcp-generator.ts');

type BinResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runBin(args: string[]): Promise<BinResult> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--import', 'tsx', BIN, ...args], {
      cwd: process.cwd(),
    }) as unknown as ChildProcess;
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code: number | null) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('mcp-generator bin', () => {
  it('init exits with code 1 and prints the not-implemented error', async () => {
    const { code, stderr } = await runBin(['init']);
    assert.equal(code, 1);
    assert.match(stderr, /init not implemented in this phase/);
  });

  it('unknown command prints usage and exits with code 1', async () => {
    const { code, stdout } = await runBin(['frobnicate']);
    assert.equal(code, 1);
    assert.match(stdout, /Usage: mcp-generator build/);
  });

  it('no args prints usage and exits with code 1', async () => {
    const { code, stdout } = await runBin([]);
    assert.equal(code, 1);
    assert.match(stdout, /Usage: mcp-generator build/);
  });
});

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads a JSON or YAML file. YAML is a JSON superset, so one parser covers both. */
export async function readDocument({
  filePath,
  label,
  shownPath = filePath,
}: {
  filePath: string;
  label: string;
  shownPath?: string;
}): Promise<{ text: string; value: unknown }> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${label} from ${shownPath}: ${describe(err)}`, { cause: err });
  }
  try {
    return { text, value: parseYaml(text) };
  } catch (err) {
    throw new Error(`Failed to parse ${label} ${shownPath}: ${describe(err)}`, { cause: err });
  }
}

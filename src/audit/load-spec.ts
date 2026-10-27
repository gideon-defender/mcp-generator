import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, type YAMLMap } from 'yaml';
import { z } from 'zod';
import type { JsonObject } from './types.js';

const objectSchema = z.record(z.string(), z.unknown());

export function asObject({ value, location }: { value: unknown; location: string }): JsonObject {
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${location}: expected an object`);
  return parsed.data;
}

export function stringField({
  object,
  key,
}: {
  object: JsonObject;
  key: string;
}): string | undefined {
  const value = object[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

type JsonFrame =
  | { kind: 'object'; keys: Set<string>; reported: Set<string>; mode: 'key' | 'value' | 'after' }
  | { kind: 'array'; mode: 'value' | 'after' };

/**
 * JSON.parse keeps the later value for a duplicate key and reports nothing.
 * Scan the (already validated) text so JSON specs get the same duplicate-key
 * findings the YAML path produces. Keys compare after JSON string decoding,
 * so "a" and "\u0061" count as the same key.
 */
function duplicateJsonKeys({ text }: { text: string }): { issues: string[]; total: number } {
  const issues: string[] = [];
  let total = 0;
  const stack: JsonFrame[] = [];
  const completeValue = (): void => {
    const top = stack.at(-1);
    if (top) top.mode = 'after';
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '\\') end += 1;
        else if (text[end] === '"') break;
        end += 1;
      }
      const token = text.slice(index, end + 1);
      index = end + 1;
      const top = stack.at(-1);
      if (top?.kind === 'object' && top.mode === 'key') {
        let key = token;
        try {
          key = JSON.parse(token) as string;
        } catch {
          // Keep the raw token; JSON.parse already validated the document.
        }
        if (top.keys.has(key) && !top.reported.has(key)) {
          top.reported.add(key);
          total += 1;
          // Cap the list as it grows, like the YAML scan: the caller can
          // only fold the overflow into a summary if the scan itself
          // does not first build one string per duplicate.
          if (issues.length < MAX_PARSE_ISSUES) {
            issues.push(`Duplicate JSON key: ${JSON.stringify(key)}`);
          }
        }
        top.keys.add(key);
        top.mode = 'value';
      } else {
        completeValue();
      }
      continue;
    }
    if (char === '{') {
      stack.push({ kind: 'object', keys: new Set(), reported: new Set(), mode: 'key' });
      index += 1;
      continue;
    }
    if (char === '[') {
      stack.push({ kind: 'array', mode: 'value' });
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      completeValue();
      index += 1;
      continue;
    }
    if (char === ',') {
      const top = stack.at(-1);
      if (top?.kind === 'object') top.mode = 'key';
      else if (top) top.mode = 'value';
      index += 1;
      continue;
    }
    if (char === ':') {
      index += 1;
      continue;
    }
    // Primitive (number, true, false, null): consume to the next delimiter.
    while (index < text.length && !',}] \t\n\r'.includes(text[index] ?? '')) index += 1;
    completeValue();
  }
  return { issues, total };
}

/** A merge key parses to a `<<` string or a symbol with that description. */
function isMergeKey({ key }: { key: unknown }): boolean {
  if (!isScalar(key)) return false;
  const value: unknown = key.value;
  return value === '<<' || (typeof value === 'symbol' && value.description === '<<');
}

/**
 * Duplicate YAML keys, found by a linear scan of the parsed maps.
 * The yaml parser check for this scans prior keys for each new key.
 * One large map then costs time squared in the map size. This scan
 * keeps one set per map, so cost stays linear in the map size.
 */
function duplicateYamlKeys({ parsed }: { parsed: ReturnType<typeof parseDocument> }): {
  issues: string[];
  total: number;
} {
  const issues: string[] = [];
  let total = 0;
  visit(parsed, {
    Map(_, map) {
      const seen = new Set<string>();
      const reported = new Set<string>();
      for (const item of map.items) {
        if (!isScalar(item.key)) continue;
        // A merge key holds a shared map; it is not a data key.
        if (isMergeKey({ key: item.key })) continue;
        const key = String(item.key.value);
        if (seen.has(key)) {
          if (!reported.has(key)) {
            reported.add(key);
            total += 1;
            if (issues.length < MAX_PARSE_ISSUES) {
              issues.push(`Duplicate YAML key: ${JSON.stringify(key)}`);
            }
          }
        } else {
          seen.add(key);
        }
      }
    },
  });
  return { issues, total };
}

export type LoadedSpec = {
  filePath: string;
  format: 'json' | 'yaml';
  text: string;
  sha256: string;
  document: JsonObject;
  openApiVersion: string;
  is31: boolean;
  title: string;
  specVersion: string;
  servers: string[];
  /** Non-fatal parse issues (e.g. duplicate YAML keys) surfaced as findings. */
  parseIssues: string[];
};

/**
 * The spec is untrusted input. It is read and parsed whole, so one byte in
 * the file costs many bytes of parsed objects in memory. Cap the file size
 * before the read so a hostile spec cannot exhaust memory in CI.
 */
export const MAX_SPEC_BYTES = 32 * 1024 * 1024;

/**
 * Parse issues become findings one-for-one, and a hostile spec can mint
 * them without limit (one duplicate YAML key is one parser error). Cap the
 * list the audit carries forward and fold the rest into a single summary
 * entry, so report size stays bounded by a constant, not by the spec.
 */
export const MAX_PARSE_ISSUES = 100;

/**
 * The `yaml` library default stops conversion after 100 uses of one
 * anchor. Large real specs reuse a shared schema or response far more
 * often than that, so name a higher bound here. The bound still caps
 * alias expansion from a hostile document, and the spec byte cap
 * above bounds the input that can mint aliases.
 */
export const MAX_YAML_ALIAS_COUNT = 10_000;

/**
 * A merge key (`<<: *anchor`) copies every entry of the anchored map
 * into the merging map at conversion time. The alias count above counts
 * anchor uses, not copied entries, so one anchored map merged into many
 * maps passes the alias check while materialising millions of entries.
 * Cap the total copied entries, counted on the parsed document before
 * conversion allocates them.
 */
export const MAX_YAML_MERGED_KEYS = 1_000_000;

/** Total entries merge keys would copy into other maps, before conversion. */
function yamlMergeExpansion({ parsed }: { parsed: ReturnType<typeof parseDocument> }): number {
  // Resolve every alias to the anchor in force at that alias, in document
  // order, before any size is computed. An alias inside an anchored map
  // keeps its own target even when the anchor name is redefined later, and
  // an anchor defined earlier in the same map counts even though a single
  // counting pass would reach the merge before it visits that definition.
  // This mirrors Alias.resolve in the yaml library.
  const aliasTargets = new Map<object, unknown>();
  const anchors = new Map<string, unknown>();
  visit(parsed, {
    Node(_, node) {
      if (isAlias(node)) {
        aliasTargets.set(node, anchors.get(node.source));
        return;
      }
      const anchor = (node as { anchor?: unknown }).anchor;
      if (typeof anchor === 'string') anchors.set(anchor, node);
    },
  });

  // Entries in a map after its own merge keys resolve. Memoised per map;
  // a node that merges itself counts the in-progress copy as zero rather
  // than recursing for ever (conversion rejects that shape separately).
  // The active set covers sequences too: a sequence of maps is a valid
  // merge source (`<<: *seq`), and a sequence can contain an alias back
  // to itself. Memoisation is safe because alias targets are fixed above,
  // per alias node, instead of depending on when a size is first computed.
  const sizes = new Map<object, number>();
  const active = new Set<object>();
  const sourceSize = (value: unknown): number => {
    if (isAlias(value)) {
      const target = aliasTargets.get(value);
      if (isMap(target)) return mapSize(target);
      if (isSeq(target)) return seqSize(target);
      return 0;
    }
    if (isMap(value)) return mapSize(value);
    if (isSeq(value)) return seqSize(value);
    return 0;
  };
  const seqSize = (seq: object & { items: unknown[] }): number => {
    const cached = sizes.get(seq);
    if (cached !== undefined) return cached;
    if (active.has(seq)) return 0;
    active.add(seq);
    let total = 0;
    for (const item of seq.items) total += sourceSize(item);
    active.delete(seq);
    sizes.set(seq, total);
    return total;
  };
  const mapSize = (map: YAMLMap): number => {
    const cached = sizes.get(map);
    if (cached !== undefined) return cached;
    if (active.has(map)) return 0;
    active.add(map);
    let total = 0;
    for (const item of map.items) {
      if (isMergeKey({ key: item.key })) total += sourceSize(item.value);
      else total += 1;
    }
    active.delete(map);
    sizes.set(map, total);
    return total;
  };

  let expansion = 0;
  visit(parsed, {
    Map(_, map) {
      for (const item of map.items) {
        if (isMergeKey({ key: item.key })) expansion += sourceSize(item.value);
      }
    },
  });
  return expansion;
}

function limitParseIssues({
  issues,
  total = issues.length,
}: {
  issues: string[];
  total?: number;
}): string[] {
  if (total <= MAX_PARSE_ISSUES) return issues.slice(0, MAX_PARSE_ISSUES);
  return [
    ...issues.slice(0, MAX_PARSE_ISSUES),
    `${total - MAX_PARSE_ISSUES} further parse issue(s) omitted (${total} in total); only the first ${MAX_PARSE_ISSUES} are listed`,
  ];
}

/**
 * Read a spec with the byte cap on the data read, not on a prior stat.
 * The stream stops at the cap, so a file that grows after the stat,
 * or a special file with a false size, cannot force a huge read.
 */
async function readSpecText({ filePath }: { filePath: string }): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    let text = '';
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ encoding: 'utf8' })) {
      const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunkText) : chunk.length;
      if (bytes > MAX_SPEC_BYTES) {
        throw new Error(
          `${filePath}: spec is over ${bytes} bytes; the limit is ${MAX_SPEC_BYTES} bytes`,
        );
      }
      text += chunkText;
    }
    return text;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Load and minimally validate any OpenAPI 3.0+ document (JSON or YAML). */
export async function loadSpec({ filePath }: { filePath: string }): Promise<LoadedSpec> {
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) throw new Error(`${filePath}: spec is not a regular file`);
  if (fileInfo.size > MAX_SPEC_BYTES) {
    throw new Error(
      `${filePath}: spec is ${fileInfo.size} bytes; the limit is ${MAX_SPEC_BYTES} bytes`,
    );
  }
  const text = await readSpecText({ filePath });
  const extension = extname(filePath).toLowerCase();
  const format: 'json' | 'yaml' = extension === '.json' ? 'json' : 'yaml';
  let raw: unknown;
  let parseIssues: string[] = [];
  try {
    if (format === 'json') {
      // JSON.parse rejects a UTF-8 byte order mark; YAML parsers accept
      // one. Strip a single leading mark so both formats treat the same
      // file the same way.
      const jsonText = text.startsWith('\uFEFF') ? text.slice(1) : text;
      raw = JSON.parse(jsonText) as unknown;
      const duplicates = duplicateJsonKeys({ text: jsonText });
      parseIssues = limitParseIssues({ issues: duplicates.issues, total: duplicates.total });
    } else {
      // Real-world specs ship duplicate keys; parseDocument collects them
      // as errors (later value wins in toJS) instead of throwing, so the
      // audit can catalogue them as findings rather than refuse the spec.
      // Merge keys stay off by default for YAML 1.2; without this option an
      // anchored path item or operation (`<<: *shared`) keeps a literal
      // `<<` key and its operations silently vanish from the inventory.
      // The parser duplicate-key check costs time squared in one map,
      // so the parser runs with that check off and duplicateYamlKeys
      // finds the same keys with a linear scan of the parsed maps.
      const parsed = parseDocument(text, { merge: true, uniqueKeys: false });
      // Slice before mapping: a hostile document can hold hundreds of
      // thousands of errors, and each mapped string is one finding later.
      const errorIssues = parsed.errors
        .slice(0, MAX_PARSE_ISSUES)
        .map((error) => error.message.split('\n')[0] ?? error.message);
      const duplicates = duplicateYamlKeys({ parsed });
      parseIssues = limitParseIssues({
        issues: [...errorIssues, ...duplicates.issues],
        total: parsed.errors.length + duplicates.total,
      });
      const mergedKeys = yamlMergeExpansion({ parsed });
      if (mergedKeys > MAX_YAML_MERGED_KEYS) {
        throw new Error(
          `YAML merge keys would copy ${mergedKeys} entries; the limit is ${MAX_YAML_MERGED_KEYS} entries`,
        );
      }
      raw = parsed.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT }) as unknown;
    }
  } catch (error) {
    throw new Error(
      `${filePath}: could not parse as ${format.toUpperCase()}: ${
        error instanceof Error ? (error.message.split('\n')[0] ?? '') : 'unknown parse error'
      }`,
    );
  }
  const document = asObject({ value: raw, location: filePath });
  const openApiVersion = stringField({ object: document, key: 'openapi' });
  if (!openApiVersion || !/^3\.(0|1)\.\d+$/.test(openApiVersion)) {
    throw new Error(
      `${filePath}: expected an OpenAPI 3.0 or later document, found ${
        openApiVersion ??
        (document['swagger'] ? `swagger ${String(document['swagger'])}` : 'no openapi field')
      }`,
    );
  }
  const info = asObject({ value: document['info'] ?? {}, location: `${filePath}#/info` });
  const serversRaw = Array.isArray(document['servers']) ? document['servers'] : [];
  const servers = serversRaw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const url = stringField({ object: entry as JsonObject, key: 'url' });
    return url ? [url] : [];
  });
  return {
    filePath,
    format,
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    document,
    openApiVersion,
    is31: openApiVersion.startsWith('3.1.'),
    title: stringField({ object: info, key: 'title' }) ?? '(untitled)',
    specVersion: stringField({ object: info, key: 'version' }) ?? '(unversioned)',
    servers,
    parseIssues,
  };
}

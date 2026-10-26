/**
 * A small spec can mint a huge report: one shared path item under
 * many paths repeats its text in every operation. Cap the report
 * size so a hostile spec cannot fill disk or memory at write time.
 */
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/** Bytes of one string as JSON text, quotes included. */
function jsonStringBytes({ value }: { value: string }): number {
  let total = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c)
      total += 2; // " and \
    else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d)
      total += 2; // \b \t \n \f \r
    else if (code < 0x20)
      total += 6; // \uXXXX
    else if (code < 0x80) total += 1;
    else if (code < 0x800) total += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4;
        index += 1;
      } else total += 6; // lone surrogate, written as \uXXXX
    } else if (code >= 0xdc00 && code <= 0xdfff)
      total += 6; // lone surrogate
    else total += 3;
  }
  return total;
}

type SizeTask = { kind: 'value'; value: unknown; depth: number } | { kind: 'chars'; count: number };

/**
 * Size of a value as the JSON text the CLI writes (two-space indent),
 * without a full string copy. Shared objects count once per use, as
 * they do in the JSON text. The count is exact for plain JSON data:
 * string escapes, separators, newlines, and indentation all count.
 * The walk stops as soon as the total passes `limit`.
 */
export function estimateJsonBytes({
  value,
  limit = MAX_REPORT_BYTES,
}: {
  value: unknown;
  limit?: number;
}): number {
  let total = 0;
  const stack: SizeTask[] = [{ kind: 'value', value, depth: 0 }];
  while (stack.length > 0) {
    const task = stack.pop() as SizeTask;
    if (task.kind === 'chars') {
      total += task.count;
    } else {
      const { depth } = task;
      const current = task.value;
      if (typeof current === 'string') {
        total += jsonStringBytes({ value: current });
      } else if (Array.isArray(current)) {
        if (current.length === 0) {
          total += 2;
        } else {
          total += 1; // [
          stack.push({ kind: 'chars', count: 1 + depth * 2 + 1 }); // newline, indent, ]
          for (let index = current.length - 1; index >= 0; index -= 1) {
            stack.push({ kind: 'value', value: current[index], depth: depth + 1 });
            stack.push({
              kind: 'chars',
              count: (index > 0 ? 1 : 0) + 1 + (depth + 1) * 2, // comma?, newline, indent
            });
          }
        }
      } else if (typeof current === 'object' && current !== null) {
        const entries = Object.entries(current);
        if (entries.length === 0) {
          total += 2;
        } else {
          total += 1; // {
          stack.push({ kind: 'chars', count: 1 + depth * 2 + 1 }); // newline, indent, }
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const [key, item] = entries[index] as [string, unknown];
            stack.push({ kind: 'value', value: item, depth: depth + 1 });
            stack.push({
              kind: 'chars',
              // comma?, newline, indent, "key", colon, space
              count:
                (index > 0 ? 1 : 0) + 1 + (depth + 1) * 2 + jsonStringBytes({ value: key }) + 2,
            });
          }
        }
      } else if (typeof current === 'number') {
        total += Number.isFinite(current) ? String(current).length : 4; // NaN/Infinity write as null
      } else if (current === undefined) {
        total += 4; // undefined array entries write as null
      } else {
        total += String(current).length;
      }
    }
    if (total > limit) return total;
  }
  return total;
}

/**
 * Running report-size budget. Each phase of the audit adds the records
 * it creates, so a shared path item or schema that expands across many
 * operations trips the cap while that phase still runs. Without this,
 * the whole inventory and all findings exist in memory before the
 * first size check can reject them.
 */
export class ReportBudget {
  readonly limit: number;
  #total = 0;

  constructor({ limit = MAX_REPORT_BYTES }: { limit?: number } = {}) {
    this.limit = limit;
  }

  get total(): number {
    return this.#total;
  }

  add({ value }: { value: unknown }): void {
    this.#total += estimateJsonBytes({ value, limit: this.limit });
    if (this.#total > this.limit) {
      throw new Error(
        `Audit report would be about ${this.#total} bytes; the limit is ${this.limit} bytes`,
      );
    }
  }
}

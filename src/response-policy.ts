/** JSON-pointer paths; `*` matches array items only. Selected leaves must be scalar. */
export function projectResponseFields(value: unknown, paths: readonly string[]): unknown {
  type Node = { leaf: boolean; children: Map<string, Node> };
  const root: Node = { leaf: false, children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const segment of path
      .slice(1)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      let child = node.children.get(segment);
      if (!child) {
        child = { leaf: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.leaf = true;
  }
  const visit = (item: unknown, node: Node): unknown => {
    if (item === null) return null;
    if (Array.isArray(item)) {
      const child = node.children.get('*');
      if (!child) throw new Error('Expected a scalar response field');
      return item.map((value) => visit(value, child));
    }
    if (typeof item === 'object') {
      if (node.leaf || node.children.has('*'))
        throw new Error('Unexpected response field structure');
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([key]) => key !== '*' && node.children.has(key))
          .map(([key, value]) => [key, visit(value, node.children.get(key)!)]),
      );
    }
    if (!node.leaf) throw new Error('Expected a structured response field');
    return item;
  };
  return visit(value, root);
}

export async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('API response exceeded its size limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

export async function readBoundedText(response: Response, limit: number): Promise<string> {
  return Buffer.from(await readBoundedBody(response, limit)).toString('utf8');
}

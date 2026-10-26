/**
 * Generic, framework-neutral tool-name derivation.
 *
 * Unlike the OpenComp compiler (which assumes NestJS `XxxController_op_v1`
 * operationIds), this works for any operationId style: camelCase, snake_case,
 * kebab-case, or mixed. Curated products should still pin explicit names in
 * their overlay; derivation is the fallback and the collision detector.
 */
function deriveFromSource({ source }: { source: string }): string {
  const withoutVersion = source.replace(/[_-]v\d+$/i, '');
  // Drop `Controller` only when it is a class-name suffix attached to a
  // resource word (NestJS `UsersController_list_v1`). A real resource named
  // "controller" (`getControllerStatus`) keeps its token.
  const withoutClassSuffix = withoutVersion.replace(/([\p{L}\p{N}])Controller(?=[_-]|$)/gu, '$1');
  // Letters and numbers outside ASCII stay in the name. An ASCII-only
  // split would strip them (`listcafé` and `listcaf` would derive one
  // name) and report a collision that the spec does not have. Combining
  // marks stay too: they are part of the letter they follow (`listकि`
  // and `listक` differ only in a mark), so dropping them invents the
  // same false collision for Indic and similar scripts.
  const tokens = withoutClassSuffix
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
  return tokens.join('-').replace(/-+/g, '-');
}

export function deriveToolName({
  operationId,
  method,
  path,
}: {
  operationId: string | null;
  method: string;
  path: string;
}): string {
  const name = deriveFromSource({ source: operationId ?? `${method} ${path}` });
  if (name.length > 0) return name;
  // The operationId held no usable token (for example `---` or `_v1`).
  // Fall back to the method plus path, as a missing operationId does,
  // instead of one `${method}-root` name for every such operation.
  const fallback = deriveFromSource({ source: `${method} ${path}` });
  return fallback.length > 0 ? fallback : `${method}-root`;
}

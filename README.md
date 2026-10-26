# @gideon/mcp-generator

Standalone OpenAPI 3.0+ → MCP generator. Point it at any OpenAPI **3.0.x or
3.1.x** document (JSON or YAML), plus optionally other docs, and it produces
MCP servers whose tools faithfully represent that API.

This repository is intentionally independent of OpenComp, Gideon Identity, or
any other product repo. Products consume the generator; they do not live in it.

> This project was developed as part of the **Meta Global AI Developer
> Hackathon** (October 26 – November 4, 2026), using Meta's $150 in Muse
> usage credits.

## Status — Phase 0 (contract & reuse audit) ✅

Phase 0 answers, for any spec: _what operations exist, what would their MCP
tools be called, and what exactly prevents or conditions faithful generation?_

```sh
pnpm install
pnpm build

# Audit any OpenAPI 3.0+ spec
node dist/cli.js audit --spec /path/to/openapi.yaml

# Cross-reference prose docs (routes mentioned vs routes in the spec)
node dist/cli.js audit --spec /path/to/openapi.yaml --docs /path/to/docs-dir

# CI mode: exit 1 when generation is blocked
node dist/cli.js audit --spec /path/to/openapi.json --strict
```

Outputs `report.json` (machine-readable inventory + findings) and
`report.md` (human summary) under `audits/<spec-name>/` by default.

### What the audit does

- **Loads** OpenAPI 3.0.x and 3.1.x, JSON or YAML. Swagger 2.0 and older are
  rejected with a clear error. Duplicate YAML keys and other non-fatal parse
  issues are tolerated (later value wins, as in most parsers) and catalogued
  as `SPEC_PARSE_ISSUE` findings instead of aborting the audit.
- **Inventories** every operation: method, path, tags, summary/description,
  security requirements, parameters, request/response media types, a generic
  derived tool name, and `read`/`mutate` classification (GET/HEAD/OPTIONS =
  read, everything else = mutate).
- **Catalogues findings** with stable codes and severities:

  | Severity   | Meaning                                                                                                                                                                                                                                                                                                                                                       |
  | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `blocker`  | Cannot be represented faithfully as an MCP tool by the baseline generator (unsupported schema keyword/format/type, cookie/content parameters, non-JSON request body, SSE response, dangling/external `$ref`, duplicate derived tool name, missing `operationId`, undefined security scheme, spec parse issue). Fix the spec or add a generic core capability. |
  | `compat31` | Valid OpenAPI 3.1 / JSON Schema 2020-12 construct that a 3.0-only compiler rejects (`type: [...]` nullable form, numeric `exclusiveMinimum/Maximum`, `const` and other 2020-12 keywords). Requires native 3.1 support (Phase 3).                                                                                                                              |
  | `warning`  | Generatable, but needs a product policy decision (missing description, multiple request media types, binary response, no security defined, documented path not in spec).                                                                                                                                                                                      |
  | `info`     | Noted and ignored on purpose (deprecated operation, webhooks, undocumented spec paths).                                                                                                                                                                                                                                                                       |

- **Derives tool names generically** from any `operationId` style
  (camelCase, snake_case, kebab-case, `XxxController_op_v1`). Derivation is a
  fallback and a collision detector (`NAME_DUPLICATE` blocker): curated
  products pin explicit names in their overlay in later phases.
- **Cross-references docs** (`--docs`, repeatable; `.md`/`.mdx`/`.txt` files
  or directories): extracts API-looking route paths and reports
  documented-but-not-in-spec (drift or another service's routes) and
  in-spec-but-not-documented paths. Prose pairs such as `Entra/Google` are
  filtered out.

The baseline constraints encoded in the catalogue are derived from the
existing OpenComp owned compiler (`apps/mcp-server/src/schema/compiler.ts`,
`src/schema/value.ts`, `src/request/compile.ts` in the OpenComp repo) — the
generator being generalized — so a `blocker` means "the current generator
really would fail or misrepresent this", not a theoretical concern.

### Verified against (Phase 0 acceptance)

| Spec                                                        | OpenAPI | Operations                  | Readiness                                                         |
| ----------------------------------------------------------- | ------- | --------------------------- | ----------------------------------------------------------------- |
| OpenComp `packages/docs/openapi.json`                       | 3.0.0   | 420 (171 read / 249 mutate) | blocked — 15 (multipart ×3, SSE ×5, `binary` format ×7)           |
| Gideon Auth `../auth/openapi.yaml`                          | 3.1.0   | 691 (276 read / 415 mutate) | blocked — 63 blockers, 642 compat31, 504 missing descriptions     |
| Agent Communications `../agent-communications/openapi.yaml` | 3.1.0   | 169                         | blocked — incl. 46 references to an undefined `bearerAuth` scheme |
| Message Delivery `../message-delivery/openapi.yaml`         | 3.1.0   | 23                          | blocked — small; a good first Phase 8 second-consumer candidate   |

Notable real defects found by the audit (not tool bugs): duplicate path keys
in the Auth spec (5 `SPEC_PARSE_ISSUE`), Auth descriptions in YAML flow
mappings whose unquoted commas parse as bogus schema keys, and 125 paths in
Identity Cockpit's `docs/api-routes.md` that are not in the Auth spec
(cross-service `/health/v1/*`, `/inv/v1/*` routes plus drift candidates).
Regenerate all of these with the commands in `audits/README.md`.

## Development

```sh
pnpm install
pnpm test        # node:test, fixtures under tests/fixtures
pnpm typecheck   # strict TypeScript, no `any`
pnpm build       # emits dist/ (bin: dist/cli.js)
```

Requires Node.js ≥ 22. Package manager: pnpm (pinned via `packageManager`).
Code rules: ≤300 lines per code file, strict types with zod at boundaries,
named parameters for functions with 2+ arguments, early returns.

## Roadmap

Phase 0 (this) is the audit gate in the generalization plan
(`opencomp/docs/plans/2026-10-26-generalize-mcp-generator-gideon-identity.md`):

1. **Phase 1** — extract the product-neutral compiler/runtime core here with
   zero behavioral change for OpenComp (byte-identical 412-tool registry).
2. **Phase 2** — config-driven build & CLI (`mcp.config.json`: spec, overlay,
   upstreams, branding, output) so any project builds a server by pointing at
   its spec.
3. **Phase 3** — native OpenAPI 3.1 support (type arrays, numeric exclusive
   bounds, `const`, plus the most common baseline blockers seen in Phase 0:
   `uniqueItems`, `minProperties`/`maxProperties`, `discriminator`,
   `byte`/`binary`/`hostname` formats).
4. **Phase 4** — overlay v2: allowlist, explicit names, read/mutate
   classification, redaction, per-operation upstream binding.
5. **Phases 5–7** — auth adapter SPI (API key, bearer/OAuth with exact MCP
   audience, agent authorization), hand-authored composite tools, and the
   Gideon Identity MCP product (independently deployed).
6. **Phase 8** — prove generalization with a second unrelated spec using only
   config + overlay + adapter.

See `DECISIONS.md` for the frozen Phase 0 decisions and open questions.

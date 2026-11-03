# @gideon/mcp-generator

Standalone OpenAPI 3.0+ → MCP generator. Point it at any OpenAPI **3.0.x or
3.1.x** document (JSON or YAML), plus optionally other docs, and it produces
MCP servers whose tools faithfully represent that API.

This repository is intentionally independent of OpenComp, Gideon Identity, or
any other product repo. Products consume the generator; they do not live in it.

> This project was developed as part of the **Meta Global AI Developer
> Hackathon** (October 26 – November 4, 2026), using Meta's $150 in Muse
> usage credits.

## Status — Phase 2 (config-driven build) ✅ · Phase 3 (3.1 support) ✅ · Phase 4 (advanced 3.1) ✅

Phase 0 answers, for any spec: _what operations exist, what would their MCP
tools be called, and what exactly prevents or conditions faithful generation?_

Phase 2 is complete: config-driven build via `mcp.config.json`.

Phase 3 is complete: native OpenAPI 3.1 / JSON Schema 2020-12 support with type arrays,
numeric exclusive bounds, const keyword, and additional constraints (uniqueItems,
minProperties, maxProperties). See [Phase 3 details](#phase-3-openapi-31-support) below.

Phase 4 is complete: multi-type arrays, complex const values, `if`/`then`/`else`,
`discriminator` (tag routing for `oneOf`/`anyOf`, implicit `$ref` names and explicit
`mapping`), `propertyNames`, `prefixItems`, `contains`/`minContains`/`maxContains`,
`dependentRequired`/`dependentSchemas`, `unevaluatedProperties`/`unevaluatedItems`,
`contentEncoding`/`contentMediaType`/`contentSchema` (base64 and JSON content are checked;
other media types are annotations), overlay v2 allowlists, explicit classification, and
policy metadata. Core vocabulary keywords such as `$id`, `$anchor`, `$dynamicRef` and
`$defs` still fail the build.

```sh
pnpm install
pnpm build

# Audit any OpenAPI 3.0+ spec
node dist/cli.js audit --spec /path/to/openapi.yaml

# Cross-reference prose docs (routes mentioned vs routes in the spec)
node dist/cli.js audit --spec /path/to/openapi.yaml --docs /path/to/docs-dir

# CI mode: exit 1 when generation is blocked
node dist/cli.js audit --spec /path/to/openapi.json --strict

# Config-driven build (Phase 2)
node dist/cli.js build [./mcp.config.json]
```

Outputs:

- Audit: `report.json` (machine-readable inventory + findings) and `report.md` (human summary) under `audits/<spec-name>/` by default
- Build: `server.mjs`, `package.json`, `artifact.json`, `tool-names.json`, and
  `contract-revision.json` under `output.dir` (default `dist`). The artifact
  depends on `@gideon/mcp-generator`, which is not on the public npm registry, so
  set `output.generatorDependency` first (see Build below). Then run
  `npm install` and `npm start` in `output.dir` to serve over stdio with the
  `MCP_GENERATOR_APIKEY` or `MCP_GENERATOR_BEARER_TOKEN` environment variable.

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

  | Severity   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
  | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `blocker`  | Cannot be represented faithfully as an MCP tool by the baseline generator (unsupported schema keyword/format/type, cookie/content parameters, non-JSON request body, SSE response, dangling/external `$ref`, duplicate derived tool name, missing `operationId`, undefined security scheme, spec parse issue). Fix the spec or add a generic core capability.                                                                                                                   |
  | `compat31` | Valid OpenAPI 3.1 / JSON Schema 2020-12 construct flagged for 3.1-native handling (`type: [...]` nullable form, numeric `exclusiveMinimum/Maximum`, and 2020-12 keywords the compiler rejects, such as `$anchor` or `$dynamicRef`). Keywords the compiler already handles (`const`, `if`/`then`/`else`, `discriminator`, `uniqueItems`, `minProperties`/`maxProperties`, `propertyNames`, `prefixItems`, `contains`, `dependent*`, `unevaluated*`, `content*`) are not flagged. |
  | `warning`  | Generatable, but needs a product policy decision (missing description, multiple request media types, binary response, no security defined, documented path not in spec, unquoted comma in a flow-mapping `description`/`summary`/`title`/`message`).                                                                                                                                                                                                                            |
  | `info`     | Noted and ignored on purpose (deprecated operation, webhooks, undocumented spec paths).                                                                                                                                                                                                                                                                                                                                                                                         |

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

| Spec                                                        | OpenAPI | Operations                  | Readiness                                                     |
| ----------------------------------------------------------- | ------- | --------------------------- | ------------------------------------------------------------- |
| OpenComp `packages/docs/openapi.json`                       | 3.0.0   | 420 (171 read / 249 mutate) | blocked — 15 (multipart ×3, SSE ×5, `binary` format ×7)       |
| Gideon Auth `../auth/openapi.yaml`                          | 3.1.0   | 691 (276 read / 415 mutate) | blocked — 11 blockers, 677 compat31, 504 missing descriptions |
| Agent Communications `../agent-communications/openapi.yaml` | 3.1.0   | 169                         | blocked — 2 blockers, 55 compat31, 139 warnings               |
| Message Delivery `../message-delivery/openapi.yaml`         | 3.1.0   | 23                          | ready with warnings — 0 blockers, 0 compat31, 21 warnings     |

The audit reports no current duplicate path keys or YAML flow-mapping comma
issues in the Auth spec. It reports 122 documented paths that are not in the
Auth spec, including Identity Cockpit's cross-service `/health/v1/*` and
`/inv/v1/*` routes. The audit now treats declared `3xx` responses as success,
so redirect-only OAuth/SAML flows (`samlSsoRedirect`, `samlSsoPost`,
`oidcAuthorizeGet`, `oidcAuthorize`, and
`completeAccessCertificationCollaborationInstallation`) do not produce
`RESPONSE_NO_SUCCESS` warnings. Regenerate local reports with the commands in
[`audits/README.md`](audits/README.md).

### How OpenComp's own generator handles the operations this audit blocks

The 15 OpenComp blockers (multipart uploads, SSE responses, binary response
formats) aren't unhandled in the running OpenComp MCP server — they're
excluded, not supported. `compileTools()` (`apps/mcp-server/src/tools.ts` in
the OpenComp repo) has no per-operation try/catch: one unsupported operation
fails the entire build. So every one of these is either dropped from the
tool registry or hand-patched:

- **Multipart uploads** (`BODY_MIME_UNSUPPORTED`): the 4 operations with a
  multipart or multi-content-type body (3 via `mcp-overlay.yaml`'s
  `operations: [...disabled: true]` list, 1 — `uploadPolicyPdf` — flagged
  `disabled: true` directly in the spec's own `x-comp-mcp`/`x-speakeasy-mcp`
  extension) never become tools. Their JSON-body sibling operations are kept,
  with the overlay rewriting those DTOs (`UploadAndParseDto`,
  `UploadAttachmentDto`, `UploadDocumentDto`, `CompleteChecklistItemDto`) to
  drop the raw-bytes property and require an `s3Key` from a presigned
  upload instead — the same pattern this audit recommends.
- **SSE responses** (`RESPONSE_MIME_UNSUPPORTED`): 2 of 3 streaming
  operations (`auto-answer`, `soa/auto-fill`) are disabled the same way,
  explicitly preserving behavior the old (Speakeasy) generator used to omit
  implicitly. The third (`ai-chat-policy`) is kept active via a hardcoded
  HTTP `Accept` header override (`application/json;q=1, text/event-stream;q=0`
  in `src/schema/value.ts`) that asks the upstream to negotiate down to a
  plain JSON response — called out in a comment as manually
  "verified by exhaustive wire parity", not a general solution.
- **Binary response formats** (`SCHEMA_FORMAT_UNSUPPORTED`): the two
  binary-download operations get the same `Accept` header override. Separately,
  the compiler never type-checks response schemas inlined under `paths` (only
  request parameters/bodies and named `components/schemas/*` entries), so an
  inline `format: binary` response schema is never reached by it regardless.

None of this is generic support — it's a curated allowlist (`disabled: true`)
plus two hand-verified, per-operation `Accept` header shims. It's the same
model this generator's Phase 4 overlay is meant to formalize.

## Known gaps vs OpenComp's shipped server

The tool registry matches (410 tools, same names, descriptions, input schemas and
annotations over `tools/list`). The serving layer does not. OpenComp keeps its own
vendored core plus a CLI and transport layer (`apps/mcp-server/src/cli*`); this
generator's `start` and generated `server.mjs` cover less:

| Area         | OpenComp                                                                                                                               | Generator                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Transports   | stdio, SSE (`--transport sse`) and Streamable HTTP (`serve`, `/mcp`), `/healthz`                                                       | stdio only                                                                                                           |
| Flags        | `--port`, `--transport`, `--tool-annotations`, `--server-index`, `--log-level`, `--env`, `--disable-static-auth`, `--help`/`--version` | `--spec`, `--overlay`, `--name`, `--version`, `--server-url`, `--tool`, `--mode`, `--apikey`/`--bearer`, `--timeout` |
| Credentials  | `--apikey`, then `OPENCOMP_APIKEY`; per-request `apikey` header over HTTP                                                              | `--apikey`/`--bearer`; generated server reads `MCP_GENERATOR_APIKEY` or `MCP_GENERATOR_BEARER_TOKEN`                 |
| Lifecycle    | SIGTERM/SIGINT close the server; startup errors are sanitized so credential flags never reach stderr                                   | no signal handling                                                                                                   |
| Hosted mode  | `--hosted`, `--public-url`, bearer validation against the product API, optional OIDC (`MCP_OIDC_*`)                                    | none; belongs to the Phase 5 auth adapter interface                                                                  |
| Packaging    | single esbuild bundle (`dist-owned/`) plus MCP bundle manifest                                                                         | `server.mjs` and `package.json`; run `npm install` first (depends on `@gideon/mcp-generator`)                        |
| Landing page | branded HTML at `/`                                                                                                                    | none (product-specific)                                                                                              |

`createOwnedServer` already accepts `annotationFilter` and `serverIndex`; the missing
pieces are CLI parsing, the HTTP transports (adds `express`) and the lifecycle
handlers. Adopting this package in OpenComp is blocked on them.

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

Phases 0 (audit gate) and 1 (compiler core) are complete.
Phase 2 (config-driven build) is complete. Phase 3 (OpenAPI 3.1 support) is complete.

1. **Phase 1 (complete)** — product-neutral compiler/runtime core:
   schema compiler, request compiler/serializer, owned OpenAPI loader/overlay,
   and an MCP client/server built on `@modelcontextprotocol/sdk`. The `start` command
   and generated `server.mjs` list the same 410 tools as OpenComp's shipped server
   (name, description, input schema, annotations). OpenComp still ships its own
   vendored copy of the core and its own HTTP/hosted transport layer; adopting this
   package there is not done. Registry parity is gated against a frozen oracle of
   400 captured tools
   (the original 412 minus 12 identity-provider-owned writers removed from OpenComp)
   plus 10 reviewed additions, 410 tools in total
   (`tests/owned-contract.test.mjs`, which reads `../opencomp/packages/docs/openapi.json`).
2. **Phase 2 (complete)** — config-driven build & CLI (`mcp.config.json`: spec, overlay,
   upstreams, branding, output) so any project builds a server by pointing at
   its spec.
3. **Phase 3 (complete)** — native OpenAPI 3.1 / JSON Schema 2020-12 support:
   - ✅ Type arrays (`type: [...]` nullable form)
   - ✅ Numeric exclusive bounds (`exclusiveMinimum`/`exclusiveMaximum` as numbers)
   - ✅ `const` keyword
   - ✅ `uniqueItems`, `minProperties`, `maxProperties` constraints
   - ✅ `byte` format (base64 string)
   - 🚧 `binary` format: rejected on strings; needs a policy (presigned `s3Key` upload vs. reject)
   - ✅ `null` type
   - 🚧 Deferred: full format validation
4. **Phase 4 (complete)** — multi-type arrays, complex const values, `if`/`then`/`else`,
   `discriminator`, `propertyNames`, `prefixItems`, `contains`, `dependent*`,
   `unevaluated*`, `content*`, and overlay v2:
   allowlist, explicit names, read/mutate classification, redaction, per-operation upstream
   binding (used only when no `serverUrl` is configured).
5. **Phases 5–7** — auth adapter SPI (API key, bearer/OAuth with exact MCP
   audience, agent authorization), hand-authored composite tools, and the
   Gideon Identity MCP product (independently deployed).
6. **Phase 8** — prove generalization with a second unrelated spec using only
   config + overlay + adapter.

## Phase 3: OpenAPI 3.1 Support

This release adds comprehensive OpenAPI 3.1 and JSON Schema 2020-12 compatibility.

**Type Arrays (Nullable Form)**

```yaml
# OpenAPI 3.1 nullable style
type: [string, 'null']
# Equivalent to: type: string + nullable: true (OpenAPI 3.0)
```

**Numeric Exclusive Bounds**

```yaml
# OpenAPI 3.1 style: exclusive bounds as numbers
exclusiveMinimum: 0
exclusiveMaximum: 100
# vs OpenAPI 3.0: boolean form with separate minimum/maximum
```

**Const Keyword**

```yaml
# JSON Schema 2020-12 const values (scalars, objects, arrays)
const: 'fixed-value'
```

**Additional Constraints**

```yaml
# uniqueItems with structural comparison for arrays
uniqueItems: true
# Property count constraints for objects
minProperties: 1
maxProperties: 10
```

**Type Safety**: Const values are validated against their schema's type at compile time.
Complex const values (objects, arrays) are compared structurally, independent of key order.

## Config-driven build

Describe a project in `mcp.config.json` (JSON or YAML, see `mcp.config.example.json`):

```json
{
  "identity": { "name": "example", "version": "0.1.0" },
  "spec": { "path": "./examples/openapi.yaml" },
  "overlay": "./examples/mcp-overlay.yaml",
  "output": { "dir": "dist" }
}
```

```sh
mcp-generator build [./mcp.config.json]
```

All paths must stay inside the working directory. The build writes a runnable
stdio server plus `artifact.json`, `tool-names.json`, and
`contract-revision.json` (spec and overlay SHA-256, tool count, name, version)
to `output.dir` (default `dist`).

```sh
cd dist
npm install
npm start
```

Set `MCP_GENERATOR_APIKEY` or `MCP_GENERATOR_BEARER_TOKEN` before starting the
generated server to provide upstream API credentials.

The artifact depends on `@gideon/mcp-generator`, which is not on the public npm
registry. Set `output.generatorDependency` to any npm dependency spec that can
resolve it, for example `file:../mcp-generator-0.1.0.tgz` (from `npm pack` in
the generator checkout, which builds `dist/` first) or a git URL. Without it,
`npm install` in the artifact fails, because the default is the generator's own
version (`0.1.0`).

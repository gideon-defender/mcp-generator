# @gideon/mcp-generator

Standalone OpenAPI 3.0+ → MCP generator. Point it at any OpenAPI **3.0.x or
3.1.x** document (JSON or YAML), plus optionally other docs, and it produces
MCP servers whose tools faithfully represent that API.

This repository is intentionally independent of OpenComp or any other product repo.
Products consume the generator; they do not live in it.

> This project was developed as part of the **Meta Global AI Developer
> Hackathon** (October 26 – November 4, 2026), using Meta's $150 in Muse
> usage credits.

## Features

- **Spec audit.** For any OpenAPI 3.0 or 3.1 spec, reports which operations exist,
  what their MCP tools would be called, and what prevents or conditions faithful
  generation.
- **Config-driven build.** Builds a runnable MCP server from `mcp.config.json`: spec,
  overlay, identity and output.
- **OpenAPI 3.1 / JSON Schema 2020-12.** Type arrays, numeric exclusive bounds, `const`
  (including objects and arrays), `uniqueItems`, `minProperties`/`maxProperties`,
  multi-type arrays, `if`/`then`/`else`, `propertyNames`, `prefixItems`,
  `contains`/`minContains`/`maxContains`, `dependentRequired`/`dependentSchemas` and
  `unevaluatedProperties`/`unevaluatedItems`. `discriminator` routes `oneOf`/`anyOf`
  by tag, with implicit `$ref` names and explicit `mapping`.
  `contentEncoding`/`contentMediaType`/`contentSchema` check base64 and JSON content;
  other media types are annotations. Core vocabulary keywords such as `$id`, `$anchor`,
  `$dynamicRef` and `$defs` still fail the build. See
  [OpenAPI 3.1 Support](#openapi-31-support).
- **Overlay policy.** Allowlists, explicit tool names, read/mutate classification and
  policy metadata, without changing the spec. See [Overlays](#overlays).
- **Authentication and hosted serving.** An auth adapter SPI, OAuth (JWT/JWKS)
  validation, and hosted Streamable HTTP / SSE serving. See
  [Authentication and Hosted Serving](#authentication-and-hosted-serving).
- **Read-only composite tools.** Product-authored named tools that combine visible
  read-only operations through a strict `callTool` gateway. `build` and `start` accept a
  compiled composite module. Governed write composites are not available yet. See
  [Read-only Composite Tools](#read-only-composite-tools).

```sh
pnpm install
pnpm build

# Audit any OpenAPI 3.0+ spec
node dist/cli.js audit --spec /path/to/openapi.yaml

# Cross-reference prose docs (routes mentioned vs routes in the spec)
node dist/cli.js audit --spec /path/to/openapi.yaml --docs /path/to/docs-dir

# CI mode: exit 1 when generation is blocked
node dist/cli.js audit --spec /path/to/openapi.json --strict

# Config-driven build
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
  With `auth` and `hosted` in the config, the artifact serves hosted HTTP/SSE with
  OAuth instead (see [Authentication and Hosted Serving](#authentication-and-hosted-serving)).

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

  | Severity   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                        |
  | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `blocker`  | Cannot be represented faithfully as an MCP tool by the baseline generator (unsupported schema keyword/format/type, cookie/content parameters, non-JSON request body, SSE response, dangling/external `$ref`, duplicate derived tool name, missing `operationId`, undefined security scheme, spec parse issue). Fix the spec or add a generic core capability.                                                  |
  | `compat31` | Valid OpenAPI 3.1 / JSON Schema 2020-12 construct that still needs 3.1-native handling: 2020-12 keywords the compiler rejects, such as `$anchor` or `$dynamicRef`. Keywords the compiler already handles (`const`, `if`/`then`/`else`, `discriminator`, `uniqueItems`, `minProperties`/`maxProperties`, `propertyNames`, `prefixItems`, `contains`, `dependent*`, `unevaluated*`, `content*`) are not flagged. |
  | `warning`  | Generatable, but needs a product policy decision (missing description, multiple request media types, binary response, no security defined, documented path not in spec, unquoted comma in a flow-mapping `description`/`summary`/`title`/`message`).                                                                                                                                                           |
  | `info`     | Noted and ignored on purpose. In a 3.1 document: type arrays, solo null types, and numeric exclusive bounds (natively supported; in a 3.0 document those same constructs are blockers). Also: deprecated operation, webhooks, undocumented spec paths.                                                                                                                                                         |

- **Derives tool names generically** from any `operationId` style
  (camelCase, snake_case, kebab-case, `XxxController_op_v1`). Derivation is a
  fallback and a collision detector (`NAME_DUPLICATE` blocker): curated
  products pin explicit names in their overlay later.
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

### Verified against

| Spec                                  | OpenAPI | Operations                  | Readiness                                               |
| ------------------------------------- | ------- | --------------------------- | ------------------------------------------------------- |
| OpenComp `packages/docs/openapi.json` | 3.0.0   | 420 (171 read / 249 mutate) | blocked — 15 (multipart ×3, SSE ×5, `binary` format ×7) |

The audit treats declared `3xx` responses as success, so redirect-only OAuth/SAML
flows do not produce `RESPONSE_NO_SUCCESS` warnings. Regenerate local reports with
the commands in [`audits/README.md`](audits/README.md).

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
  `disabled: true` directly in the spec's own `x-comp-mcp`
  extension) never become tools. Their JSON-body sibling operations are kept,
  with the overlay rewriting those DTOs (`UploadAndParseDto`,
  `UploadAttachmentDto`, `UploadDocumentDto`, `CompleteChecklistItemDto`) to
  drop the raw-bytes property and require an `s3Key` from a presigned
  upload instead — the same pattern this audit recommends.
- **SSE responses** (`RESPONSE_MIME_UNSUPPORTED`): 2 of 3 streaming
  operations (`auto-answer`, `soa/auto-fill`) are disabled the same way,
  keeping the prior tool registry unchanged. The third (`ai-chat-policy`) is
  kept active; the runtime prefers `application/json` when the response
  declares it, asking the upstream to negotiate down to a plain JSON
  response.
- **Binary response formats** (`SCHEMA_FORMAT_UNSUPPORTED`): the two
  binary-download operations rely on the same `application/json`-preferred
  negotiation. `export-by-id` declares its media types only on error
  responses, so the overlay sets its `accept` metadata to prefer CSV. Separately,
  the compiler never type-checks response schemas inlined under `paths` (only
  request parameters/bodies and named `components/schemas/*` entries), so an
  inline `format: binary` response schema is never reached by it regardless.

None of this is generic support — it's a curated allowlist (`disabled: true`).
It's the same model this generator's overlay formalizes.

## Known gaps vs OpenComp's shipped server

The tool registry matches (410 tools, same names, descriptions, input schemas and
annotations over `tools/list`). The serving layer still does not fully match. OpenComp
keeps its own vendored core plus a CLI and transport layer (`apps/mcp-server/src/cli*`);
this generator's `start` and generated `server.mjs` cover less:

| Area         | OpenComp                                                                                                                               | Generator                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transports   | stdio, SSE (`--transport sse`) and Streamable HTTP (`serve`, `/mcp`), `/healthz`                                                       | stdio (default); hosted: Streamable HTTP (`/mcp`, POST only) or SSE (`/sse`, `/messages`) via `--hosted --transport http/sse` plus `/healthz` on all transports                                                                                                           |
| Flags        | `--port`, `--transport`, `--tool-annotations`, `--server-index`, `--log-level`, `--env`, `--disable-static-auth`, `--help`/`--version` | `--spec`, `--overlay`, `--name`, `--version`, `--server-url`, `--tool`, `--mode`, `--apikey`/`--bearer`, `--timeout`, `--hosted`, `--transport`, `--port`, `--host`, `--allowed-origin`, `--oauth-*`; no `--tool-annotations`, `--server-index`, `--log-level` or `--env` |
| Credentials  | `--apikey`, then `OPENCOMP_APIKEY`; per-request `apikey` header over HTTP                                                              | stdio: `--apikey`/`--bearer` or `MCP_GENERATOR_APIKEY`/`MCP_GENERATOR_BEARER_TOKEN`; hosted: per-request OAuth bearer token only (no `apikey` header, no static fallback)                                                                                                 |
| Lifecycle    | SIGTERM/SIGINT close the server; startup errors are sanitized so credential flags never reach stderr                                   | hosted servers close on SIGTERM/SIGINT; stdio has no signal handling                                                                                                                                                                                                      |
| Hosted mode  | `--hosted`, `--public-url`, bearer validation against the product API, optional OIDC (`MCP_OIDC_*`)                                    | `--hosted` with JWT validation (issuer, audience, JWKS signature, expiry, scopes); no `--public-url`, protected-resource metadata, product-API validation or OIDC discovery                                                                                               |
| Packaging    | single esbuild bundle (`dist-owned/`) plus MCP bundle manifest                                                                         | `server.mjs` and `package.json`; run `npm install` first (depends on `@gideon/mcp-generator`; hosted builds also add `express` and `jose`)                                                                                                                                |
| Landing page | branded HTML at `/`                                                                                                                    | none (product-specific)                                                                                                                                                                                                                                                   |

`createOwnedServer` accepts `annotationFilter`, and `serverIndex` is an `ApiOptions`
field, but `start` exposes neither as a flag. Still missing before OpenComp can adopt
this package: those flags, logging and `--env` handling, the per-request `apikey`
header, product-API or OIDC token validation, protected-resource metadata, and
stdio signal handling.

## Specification requirements and limits

What `build` needs from a spec, beyond what the audit reports:

- **Parameter references.** Local `#/components/parameters/*` references on path items
  and operations are inlined before compilation (`src/openapi/parameter-refs.ts`). A
  reference that is missing, not local, not under `#/components/parameters/`, or that
  points at another reference fails with an error that names the operation.
- **Descriptions.** Every operation needs a `summary` and a `description`. A missing
  `description` fails the build with a raw Zod error, although the audit rates it only
  as the warning `OP_MISSING_DESCRIPTION`.
- **Request bodies.** The compiler accepts exactly one `application/json` request body
  type. An operation with another or additional media type must be disabled in the
  overlay with `metadata: { disabled: true }`. The audit reports multiple media types
  only as the warning `BODY_MULTIPLE_MIME`.
- **String formats.** Supported formats are `date-time`, `date`, `email`, `uuid`, `uri`,
  `hostname`, `byte` and `password`. Other formats, such as `ipv4`, are rejected.
- **The audit ignores the overlay.** It can report a spec as `blocked` for operations
  that the overlay disables, so `build` is the real check.

## Connecting an MCP client

Two different servers get confused here: a **hosted product deployment** (for
example OpenComp's own dev endpoint) and a **server you build and run from this
repo**. They take different configuration.

### Credentials summary

| Deployment             | Endpoint                                                             | Client credential                                               |
| ---------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Built stdio artifact   | client spawns `node server.mjs`                                      | `MCP_GENERATOR_APIKEY` or `MCP_GENERATOR_BEARER_TOKEN` in `env` |
| Built / `start` hosted | `http://<host>:<port>/mcp` (Streamable HTTP) or `/sse` + `/messages` | OAuth bearer token only; **no** static key, no `apikey` header  |
| OpenComp dev (hosted)  | `https://mcp.dev.gideondefender.com/mcp`                             | Organization API key in the `apikey` header, or OAuth (opt-in)  |

`https://opencomp.dev.gideondefender.com` is the **web app**, not an MCP endpoint:
every path (`/`, `/mcp`, `/sse`) answers `307` to `/auth`. Use the `mcp.` host.

### Built stdio server

The artifact reads static credentials from its environment, so pass them in the
client's `env` block and never inline them in `args`:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["/absolute/path/to/dist/server.mjs"],
      "env": { "MCP_GENERATOR_APIKEY": "<upstream-api-key>" }
    }
  }
}
```

`--apikey` is sent upstream as `X-API-Key`; `--bearer` as `Authorization`. Supply
exactly one of the two variables, or startup fails.

### Hosted server built from this repo

Build with `auth` + `hosted` (see [Authentication and Hosted Serving](#authentication-and-hosted-serving)),
then point the client at the URL:

```json
{
  "mcpServers": {
    "example": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Hosted mode resolves credentials per request and rejects static fallbacks, so
`MCP_GENERATOR_APIKEY`/`MCP_GENERATOR_BEARER_TOKEN` are ignored there. A remote
client must obtain a token from the configured issuer for the exact audience
(`--oauth-audience`) and scopes (`--oauth-scope`). Without
`--oauth-forward-token`, the token must also carry an `api_key` claim or callers
receive `403`.

### OpenComp dev deployment

```json
{
  "mcp": {
    "opencomp": {
      "type": "remote",
      "url": "https://mcp.dev.gideondefender.com/mcp",
      "headers": { "apikey": "{env:OPENCOMP_APIKEY}" }
    }
  }
}
```

Use the client's env-reference syntax rather than pasting the key, and prefer an
organization-scoped **read-only** key: an org-wide key can reach mutating
operations (deletes, policy edits, key revocation) through `execute_tool`. The
server validates the key against the API's `/v1/auth/me` on every request, so
revoked or expired keys fail on the next call.

That deployment runs in dynamic mode, so clients see three tools —
`list_tools`, `describe_tool_input`, `execute_tool` — not one per operation.
Allow-list or filter on those names, not on operation names.

Unauthenticated requests return `401` with
`WWW-Authenticate: Bearer resource_metadata="https://mcp.dev.gideondefender.com/.well-known/oauth-protected-resource"`;
`/healthz` is an unauthenticated readiness probe.

### Verifying a connection

```sh
curl -sS https://mcp.dev.gideondefender.com/healthz

curl -sS -X POST https://mcp.dev.gideondefender.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "apikey: $OPENCOMP_APIKEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

A healthy response is a `200` with `serverInfo`, for example
`{"name":"OpenComp","version":"0.3.0"}`. A `401` means the key, its organization
scopes, or its tenant binding is wrong; `503` means the auth service is down.
Neither the hosted helper in this repo nor the OpenComp deployment accepts keys
in the URL, and credential-bearing redirects are not followed.

## Development

```sh
pnpm install
pnpm test        # node:test, fixtures under tests/fixtures
pnpm lint       # eslint (flat config, typescript-eslint)
pnpm typecheck   # strict TypeScript, no `any`
pnpm build       # emits dist/ (bin: dist/cli.js)
```

Requires Node.js ≥ 22. Package manager: pnpm (pinned via `packageManager`).
Code rules: ≤300 lines per code file, strict types with zod at boundaries,
named parameters for functions with 2+ arguments, early returns.

## Roadmap

Everything below except items 7 and 8 is complete. Governed write composites remain
separately gated.

1. **Compiler core (complete)** — product-neutral compiler/runtime core:
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
2. **Config-driven build (complete)** — build & CLI (`mcp.config.json`: spec, overlay,
   upstreams, branding, output) so any project builds a server by pointing at
   its spec.
3. **OpenAPI 3.1 support (complete)** — native OpenAPI 3.1 / JSON Schema 2020-12 support:
   - ✅ Type arrays (`type: [...]` nullable form)
   - ✅ Numeric exclusive bounds (`exclusiveMinimum`/`exclusiveMaximum` as numbers)
   - ✅ `const` keyword
   - ✅ `uniqueItems`, `minProperties`, `maxProperties` constraints
   - ✅ `byte` format (base64 string)
   - ✅ `hostname` format (RFC 1123 hostname)
   - 🚧 `binary` format: rejected on strings; needs a policy (presigned `s3Key` upload vs. reject)
   - ✅ `null` type
   - 🚧 Deferred: full format validation
4. **Advanced 3.1 keywords (complete)** — multi-type arrays, complex const values, `if`/`then`/`else`,
   `discriminator`, `propertyNames`, `prefixItems`, `contains`, `dependent*`,
   `unevaluated*`, `content*`, and overlay v2:
   allowlist, explicit names, read/mutate classification, redaction, per-operation upstream
   binding (used only when no `serverUrl` is configured).
5. **Auth and hosted serving (complete)** — auth adapter SPI (static, reject, OAuth with exact MCP
   audience) and hosted Streamable HTTP / SSE serving. Agent authorization is not
   implemented.
6. **Read-only composite tools (complete, read-only scope)** — product-owned composite tools declared
   with Zod and compiled to MCP; `mcp.config.json` can copy a compiled module into
   the artifact, or `start --composites` can import it at runtime. Governed write
   composites are deferred.
7. **Phase 7** — a first product built on the generator, deployed independently of
   this repository.
8. **Phase 8** — prove generalization with a second unrelated spec using only
   config + overlay + adapter.

## OpenAPI 3.1 Support

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

**Discriminator for Tagged Unions**

```yaml
oneOf:
  - $ref: '#/components/schemas/Cat'
  - $ref: '#/components/schemas/Dog'
discriminator:
  propertyName: type
  mapping:
    cat: Cat
    dog: Dog
```

**Complete Keyword Support**

| Feature                                                  | Implementation                   |
| -------------------------------------------------------- | -------------------------------- |
| Type arrays with null                                    | ✅ Natively compiled             |
| Numeric exclusive bounds                                 | ✅ Natively compiled             |
| `const` (scalars, objects, arrays)                       | ✅ Natively compiled             |
| `uniqueItems`                                            | ✅ Array constraint              |
| `minProperties` / `maxProperties`                        | ✅ Object size constraints       |
| `discriminator` (tag routing)                            | ✅ Implicit and explicit mapping |
| `propertyNames`                                          | ✅ Dynamic key validation        |
| `prefixItems` / `items`                                  | ✅ Tuple and array composition   |
| `contains` / `minContains` / `maxContains`               | ✅ Array item matching           |
| `dependentRequired` / `dependentSchemas`                 | ✅ Conditional properties        |
| `unevaluatedProperties` / `unevaluatedItems`             | ✅ Validation-time constraints   |
| `contentEncoding` / `contentMediaType` / `contentSchema` | ✅ Base64 and JSON content       |
| `if` / `then` / `else`                                   | ✅ Conditional schemas           |

**Audit Impact**: In a 3.1 document, type arrays, solo null types, and numeric exclusive bounds are now `info` (noted) instead of `compat31` (required for 3.1 support). Regenerating the reports under `audits/` shows 0 `compat31` everywhere. In the specs audited so far, these constructs (type arrays, solo null types and exclusive bounds) are all `info`. In a 3.0 document these same constructs are blockers. 2020-12 keywords the compiler still rejects are unchanged and stay `compat31`.

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
server (stdio, or hosted when `auth` and `hosted` are set) plus `artifact.json`,
`tool-names.json`, and
`contract-revision.json` (spec and overlay SHA-256, tool count, name, version)
to `output.dir` (default `dist`).

```sh
cd dist
npm install
npm start
```

Set `MCP_GENERATOR_APIKEY` or `MCP_GENERATOR_BEARER_TOKEN` before starting the
generated stdio server to provide upstream API credentials. A hosted artifact reads
no static credentials; callers authenticate per request (see [Authentication and Hosted Serving](#authentication-and-hosted-serving)).

The artifact depends on `@gideon/mcp-generator`, which is not on the public npm
registry. Set `output.generatorDependency` to any npm dependency spec that can
resolve it, for example `file:../mcp-generator-0.1.0.tgz` (from `npm pack` in
the generator checkout, which builds `dist/` first) or a git URL. Without it,
`npm install` in the artifact fails, because the default is the generator's own
version (`0.1.0`).

## Overlays

An overlay is a JSON or YAML policy file that the generator applies to a copy of the
spec. It decides which operations become tools, what they are called and how they
behave. The spec file is never changed.

- Set it with `overlay` in `mcp.config.json`, or with `start --overlay <path>`. Without
  `--overlay`, `start` uses an empty overlay.
- `build` records the overlay's SHA-256 in `contract-revision.json` and `artifact.json`.
- The audit does not read the overlay, so `build` is the real check.

### Structure

| Key          | Required | Purpose                                                   |
| ------------ | -------- | --------------------------------------------------------- |
| `version`    | yes      | `1` or `2`. Both are accepted and behave the same.        |
| `schemas`    | yes      | Edits to named component schemas. Use `[]` for none.      |
| `operations` | yes      | Per-operation metadata. Use `[]` for none.                |
| `allowlist`  | no       | Tool names or `operationId`s. Everything else is dropped. |

Unknown keys are rejected at every level.

```yaml
version: 2
schemas:
  - name: UploadDto
    removeProperties: [fileData]
    properties:
      s3Key:
        description: Key returned by the presigned upload step.
operations:
  - path: /v1/uploads
    method: post
    metadata: { disabled: true }
  - path: /v1/users/{id}
    method: get
    metadata:
      name: get-user
      redaction: [ssn, dateOfBirth]
  - path: /v1/search
    method: post
    metadata: { classification: read }
  - path: /v1/reports/export
    method: post
    metadata:
      accept: text/csv;q=1, application/pdf;q=0.7
```

### Operation metadata

Each `operations` entry has a `path` (starting with `/`), a lowercase `method` and a
`metadata` object. The same fields can be set in the spec under an operation's
`x-comp-mcp` extension. The overlay is merged on top of it, and the overlay wins.

| Field            | Type                      | Effect                                                                                                                                                |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | string                    | The tool name. See [Tool names](#tool-names).                                                                                                         |
| `disabled`       | boolean                   | `true` removes the operation from the tools.                                                                                                          |
| `description`    | string                    | Replaces the generated tool description, which is the operation's `summary`, a blank line and `description`.                                          |
| `classification` | `read` or `mutate`        | Overrides the default classification. See [Classification](#classification).                                                                          |
| `upstream`       | string                    | The API server for this operation. See [Upstream server](#upstream-server).                                                                           |
| `redaction`      | `true` or list of strings | Hides response data. See [Redaction](#redaction).                                                                                                     |
| `accept`         | string                    | The `Accept` header to send. By default it is `application/json` if a response declares it, otherwise the first declared media type, otherwise `*/*`. |

Empty strings are rejected, and unknown fields are rejected. An operation without an
`x-comp-mcp` extension is unaffected until the overlay names it.

The old `x-speakeasy-mcp` extension is not read. A spec that still carries it loads only
when `x-comp-mcp` holds the same values for every key. Otherwise `build` fails with
`Unsupported x-speakeasy-mcp on <operationId>`, so a `disabled`, `classification` or
`redaction` value is never dropped silently.

### Tool names

A name set in `x-comp-mcp` or in the overlay is used as given. Other operations get a
derived name:

1. Remove a trailing `_v<N>` from the `operationId`.
2. Split at the first `_` into a resource and an action, and drop `Controller` from the
   resource. An `operationId` without `_` is used whole.
3. Use the action in kebab-case. `widgetsController_get_v1` becomes `get`.
4. If that name is taken, use `resource-action`, such as `gadgets-get`. If that is also
   taken, add `-2`, `-3` and so on.

Explicit names are reserved first, including the names of disabled operations. Two
explicit names that are equal fail with `Duplicate MCP name`, whether they come from the
spec or from the overlay.

Derived names are assigned before the overlay is applied. An operation that the overlay
disables therefore still takes its derived name, and an operation after it in the spec
may get the longer `resource-action` form. An overlay `name` replaces the derived name
but does not free it for others. Pin names explicitly for any tool whose name clients
depend on. An operation disabled in the spec's own `x-comp-mcp` never takes a name.

### Classification

By default `GET`, `HEAD` and `OPTIONS` are `read`, and every other method is `mutate`.
Set `classification` to override this, for example for a `POST` search that changes
nothing.

The classification becomes the tool's MCP annotations:

| Annotation        | Value                               |
| ----------------- | ----------------------------------- |
| `readOnlyHint`    | `true` for `read`                   |
| `destructiveHint` | `true` for `mutate`                 |
| `idempotentHint`  | `true` for `read`, and for `DELETE` |
| `openWorldHint`   | always `true`                       |

`annotationFilter` keeps only the tools whose annotations match, so a read-only server
can hide every `mutate` tool. Composite tools can call only `read` tools.

### Redaction

Redaction runs on the response body before the tool returns it.

- `redaction: true` returns `[REDACTED]` and never reads the body.
- `redaction: [key, ...]` replaces the value of each listed key with `[REDACTED]` at any
  depth in a JSON response. Key names are matched exactly, including case.
- A body that is not valid JSON, or an image or audio response, returns `[REDACTED]`
  instead of passing through unmasked.
- An empty body is returned as is.

Upstream error bodies are never returned. A failed request gives only
`API request failed (HTTP <status>).`. Any copy of the caller's credential in a response
is replaced with `[REDACTED]` for every tool.

### Upstream server

By default a tool calls the first entry of the spec's `servers`. `upstream` sends that
operation to another server. The operator's choice wins over both: the `--server-url`
flag, or `serverUrl` in `ApiOptions`, so a spec cannot redirect credentials. The URL must
be `http` or `https` with no user name, password, query or fragment. `upstream` is used
only when no operator URL is set.

### Schema changes

Each `schemas` entry names a component schema and can:

- `removeProperties`: delete properties from it. They are also removed from `required`.
  Use this to hide fields that a tool cannot send, such as a raw file body.
- `properties`: replace the `description` of a property, with `{ description: '...' }`.
  Nothing else about the property changes.

A schema or property that does not exist fails the build with
`Missing overlay property: <Schema>.<property>`.

### Allowlist

When `allowlist` is present, only operations whose tool `name` or `operationId` is listed
become tools. It applies after `disabled`. An entry that matches nothing is ignored, so
check the tool list after changing it.

### Errors

| Error                         | Cause                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `Duplicate overlay operation` | Two entries for the same method and path.                    |
| `Missing overlay operation`   | An entry for a method and path that is not in the spec.      |
| `Missing overlay property`    | A `schemas` entry names a schema or property that is absent. |
| `Duplicate MCP name`          | Two operations end up with the same explicit name.           |
| `Unsupported x-speakeasy-mcp` | A legacy extension holds a value that `x-comp-mcp` lacks.    |

### How it is applied

1. The spec is cloned, and local parameter references are inlined.
2. The overlay is validated.
3. Names are reserved and derived.
4. `schemas` and `operations` are applied. Operation metadata is merged over `x-comp-mcp`.
5. Names are checked again for duplicates.
6. Disabled operations and operations outside the allowlist are dropped. The rest become
   tools, and each needs a `summary` and a `description` in the spec.

## Authentication and Hosted Serving

This adds a transport-independent authentication adapter and hosted HTTP/SSE serving.

```sh
# Local stdio deployment
node dist/cli.js start --spec openapi.yaml --name example --version 1.0.0 \
  --apikey "$MCP_API_KEY"

# Hosted Streamable HTTP with exact OAuth issuer/audience validation
node dist/cli.js start --spec openapi.yaml --name example --version 1.0.0 \
  --hosted --transport http --port 3000 \
  --oauth-issuer https://issuer.example.com \
  --oauth-audience https://mcp.example.com \
  --oauth-jwks-url https://issuer.example.com/.well-known/jwks.json \
  --oauth-scope mcp.tools \
  --oauth-forward-token
```

Hosted mode exposes `/mcp` for Streamable HTTP (stateless, POST only) or `/sse` plus `/messages` for legacy SSE, and `/healthz`. Hosted credentials are resolved per MCP request; static API-key and bearer environment credentials are not accepted as hosted fallbacks.

A config-driven build produces a hosted server when the config sets both `auth` and `hosted`:

```json
{
  "auth": {
    "mode": "oauth",
    "issuer": "https://issuer.example.com",
    "audience": "https://mcp.example.com",
    "jwksUrl": "https://issuer.example.com/.well-known/jwks.json",
    "requiredScopes": ["mcp.tools"]
  },
  "hosted": { "transport": "http", "port": 3000, "allowedOrigins": [] }
}
```

The public auth SPI exports `AuthAdapter`, static adapters, OAuth adapters, and hosted serving helpers from the package entrypoint. OAuth verification validates issuer, exact audience, signature, expiry, and required scopes. The upstream bearer option (`--oauth-forward-token`, `auth.upstreamBearerToken`) is off by default because it sends a token issued for the MCP server to the API; enable it only when the API accepts that audience. Without it, the token must carry an `api_key` claim, and callers without one receive 403.

## Read-only Composite Tools

Product-authored tools can compose MCP operations without forking the generator.
They are compiled and registered like spec-derived tools, so `tools/list`, dynamic
discovery, `allowedTools`, and `annotationFilter` apply normally.

Create a compiled module with a named `composites` export (see [`examples/composites.mjs`](examples/composites.mjs)):

```js
import { z } from 'zod';
import { jsonResult, parseToolJsonResult } from '@gideon/mcp-generator';

export const composites = [
  {
    name: 'health-summary',
    description: 'Return the service health in a product-friendly summary.',
    title: 'Health summary',
    input: z.object({}),
    async run(_args, { callTool }) {
      const result = await callTool('get-health', {});
      if (result.isError) return result;
      return jsonResult({ health: parseToolJsonResult(result) });
    },
  },
];
```

For tools with parameters, pass the arguments at the operation MCP layer, for example `{ request: { userId: "ada" } }` for an operation whose parameters are nested under `request`.

Declare the module in `mcp.config.json`:

```json
{
  "identity": { "name": "example", "version": "0.1.0" },
  "spec": { "path": "./openapi.yaml" },
  "overlay": "./mcp-overlay.yaml",
  "composites": { "module": "./composites.mjs" },
  "output": { "dir": "dist" }
}
```

`mcp-generator build` validates that `composites.module` is inside the working directory and is a regular `.js` or `.mjs` file, hashes and copies it to `output.dir/composites.mjs`, and makes the generated server import it at startup (the module is **not** executed at build time). The artifact includes `zod` as a dependency when composites are configured, and `artifact.json` / `contract-revision.json` record the copied module SHA-256.

Use `mcp-generator start --composites ./composites.mjs ...` for the same behavior without a build. The module may use Node.js built-ins and package dependencies that the artifact installs (`@gideon/mcp-generator` and its dependencies).

Safety rules enforced by the runtime:

- Composite names must be lowercase kebab-case, at most 64 characters, and cannot collide with operation tools or dynamic discovery tools. Duplicates fail at startup.
- Composite `classification` is fixed to `read` for now; a `mutate` definition fails fast with a clear error because governed writes are deferred.
- Annotations advertise `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`. Governed write composites are intentionally unavailable in this release.
- `callTool` may only invoke **visible** operation tools (after `allowedTools` and `annotationFilter`) classified as `read`. It cannot invoke another composite, and it cannot invoke hidden or mutating operations.
- Input is validated before the composite runs. Underlying calls are validated the same way. Credentials are resolved once per top-level MCP request and are not shared with other callers; `callTool` passes the caller’s abort signal to outbound requests.
- If a composite throws, callers receive `Composite tool <name> failed.` rather than internal details. Unhandled API and configuration errors use existing generic messages.
- A composite may make at most 25 subcalls per MCP request. Calls beyond the limit fail with an error result, so one request cannot consume unbounded upstream quota.
- At startup, invalid definitions fail the whole server/build; nothing is silently dropped.

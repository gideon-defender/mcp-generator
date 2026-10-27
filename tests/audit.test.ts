import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PARSE_ISSUES, MAX_SPEC_BYTES, loadSpec } from '../src/audit/load-spec.js';
import { renderMarkdown } from '../src/audit/report.js';
import { runAudit } from '../src/audit/run-audit.js';
import { codes } from './helpers.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => resolve(fixtures, name);

describe('loadSpec', () => {
  it('parses an OpenAPI 3.0 JSON document', async () => {
    const loaded = await loadSpec({ filePath: fixture('openapi-30.json') });
    assert.equal(loaded.openApiVersion, '3.0.3');
    assert.equal(loaded.title, 'Widget API');
    assert.equal(loaded.specVersion, '1.2.3');
    assert.deepEqual(loaded.servers, ['https://api.example.test']);
  });

  it('parses an OpenAPI 3.1 YAML document', async () => {
    const loaded = await loadSpec({ filePath: fixture('openapi-31.yaml') });
    assert.equal(loaded.openApiVersion, '3.1.0');
    assert.equal(loaded.title, 'Identity API');
  });

  it('rejects Swagger 2.0 documents', async () => {
    await assert.rejects(
      () => loadSpec({ filePath: fixture('swagger-20.json') }),
      /OpenAPI 3\.0 or later/,
    );
  });

  it('parses a JSON document that starts with a UTF-8 byte order mark', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-bom-'));
    const bomPath = join(dir, 'bom.json');
    await writeFile(
      bomPath,
      '\uFEFF' +
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'BOM API', version: '1' },
          paths: {},
        }),
    );
    const loaded = await loadSpec({ filePath: bomPath });
    assert.equal(loaded.title, 'BOM API');
    assert.deepEqual(loaded.parseIssues, []);
  });

  it('rejects a spec over the size limit before parsing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-bigspec-'));
    const bigPath = join(dir, 'big.json');
    await writeFile(bigPath, Buffer.alloc(MAX_SPEC_BYTES + 1));
    await assert.rejects(() => loadSpec({ filePath: bigPath }), /limit is/);
  });

  it('rejects a spec that is not a regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-dirspec-'));
    await assert.rejects(() => loadSpec({ filePath: dir }), /not a regular file/);
  });

  it('rejects a YAML merge through an alias to a sequence of maps past the limit', async () => {
    const keys = Array.from({ length: 2_000 }, (_, index) => `  k${index}: 1`).join('\n');
    const holders = Array.from({ length: 501 }, () => '  - {<<: *seq}').join('\n');
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths: {}',
      'x-big: &big',
      keys,
      'x-seq: &seq [*big]',
      'x-holders:',
      holders,
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-mergedseq-'));
    const specPath = join(dir, 'merged-seq.yaml');
    await writeFile(specPath, yaml);
    await assert.rejects(() => loadSpec({ filePath: specPath }), /merge keys would copy/);
  });

  it('counts YAML merges against the anchor in force at the merge, not a later one', async () => {
    const keys = Array.from({ length: 2_000 }, (_, index) => `  k${index}: 1`).join('\n');
    const holders = Array.from({ length: 600 }, () => '  - {<<: *shared}').join('\n');
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths: {}',
      'x-big: &shared',
      keys,
      'x-holders:',
      holders,
      'x-small: &shared {only: 1}',
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-mergedanchor-'));
    const specPath = join(dir, 'merged-anchor.yaml');
    await writeFile(specPath, yaml);
    await assert.rejects(() => loadSpec({ filePath: specPath }), /merge keys would copy/);
  });

  it('counts a merge through an anchored map against the anchor in force inside it', async () => {
    const keys = Array.from({ length: 2_000 }, (_, index) => `  k${index}: 1`).join('\n');
    const holders = Array.from({ length: 600 }, () => '  - {<<: *container}').join('\n');
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths: {}',
      'x-big: &shared',
      keys,
      'x-container: &container {<<: *shared}',
      'x-small: &shared {only: 1}',
      'x-holders:',
      holders,
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-mergedcontainer-'));
    const specPath = join(dir, 'merged-container.yaml');
    await writeFile(specPath, yaml);
    await assert.rejects(() => loadSpec({ filePath: specPath }), /merge keys would copy/);
  });

  it('counts a merge against an anchor defined earlier in the same map', async () => {
    const keys = Array.from({ length: 2_000 }, (_, index) => `  k${index}: 1`).join('\n');
    const merges = Array.from({ length: 501 }, () => '<<: *shared').join('\n');
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths: {}',
      'x-big: &shared',
      keys,
      merges,
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-mergedsamemap-'));
    const specPath = join(dir, 'merged-same-map.yaml');
    await writeFile(specPath, yaml);
    await assert.rejects(() => loadSpec({ filePath: specPath }), /merge keys would copy/);
  });

  it('caps JSON duplicate-key issues and folds the rest into one summary entry', async () => {
    const objects = Array.from({ length: 300 }, () => '{"k": 1, "k": 2}').join(', ');
    const text = `{"openapi":"3.0.3","info":{"title":"T","version":"1"},"paths":{},"x-data":[${objects}]}`;
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-dupjson-'));
    const specPath = join(dir, 'dup.json');
    await writeFile(specPath, text);
    const loaded = await loadSpec({ filePath: specPath });
    assert.equal(loaded.parseIssues.length, MAX_PARSE_ISSUES + 1);
    assert.match(
      loaded.parseIssues.at(-1) ?? '',
      /further parse issue\(s\) omitted \(300 in total\)/,
    );
  });

  it('parses a YAML document with one very large mapping', async () => {
    // The parser duplicate-key check made this shape cost time squared
    // in the number of paths; the audit scan keeps the cost linear.
    const lines = ['openapi: 3.0.3', "info: {title: T, version: '1'}", 'paths:'];
    for (let index = 0; index < 20_000; index += 1) {
      lines.push(
        `  /p${index}: {get: {operationId: op${index}, responses: {"200": {description: ok}}}}`,
      );
    }
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-wideyaml-'));
    const specPath = join(dir, 'wide.yaml');
    await writeFile(specPath, lines.join('\n'));
    const loaded = await loadSpec({ filePath: specPath });
    assert.equal(loaded.openApiVersion, '3.0.3');
    assert.deepEqual(loaded.parseIssues, []);
  });
});

describe('runAudit inventory', () => {
  it('inventories operations with classification and derived tool names', async () => {
    const report = await runAudit({ specPath: fixture('openapi-30.json') });
    assert.equal(report.summary.paths, 3);
    assert.equal(report.summary.operations, 5);
    const list = report.operations.find((op) => op.operationId === 'listUsers');
    assert.equal(list?.classification, 'read');
    assert.equal(list?.derivedToolName, 'list-users');
    const create = report.operations.find((op) => op.operationId === 'createUser');
    assert.equal(create?.classification, 'mutate');
    assert.deepEqual(create?.requestContentTypes, ['application/json']);
  });
});

describe('runAudit catalogue', () => {
  it('catalogues blockers from the baseline generator constraints', async () => {
    const report = await runAudit({ specPath: fixture('openapi-30.json') });
    const found = codes(report);
    assert.ok(found.has('PARAM_LOCATION_UNSUPPORTED'), 'cookie param');
    assert.ok(found.has('BODY_MIME_UNSUPPORTED'), 'multipart body');
    assert.ok(found.has('RESPONSE_MIME_UNSUPPORTED'), 'SSE response');
    assert.ok(found.has('SCHEMA_FORMAT_UNSUPPORTED'), 'hostname format');
    assert.ok(found.has('SCHEMA_REF_DANGLING'), 'missing $ref target');
    assert.ok(found.has('NAME_DUPLICATE'), 'get-user collision');
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('catalogues 3.1 constructs as compat31, not blockers', async () => {
    const report = await runAudit({ specPath: fixture('openapi-31.yaml') });
    const compat = report.findings.filter((finding) => finding.severity === 'compat31');
    const compatCodes = new Set(compat.map((finding) => finding.code));
    assert.ok(compatCodes.has('SPEC31_TYPE_ARRAY'));
    assert.ok(compatCodes.has('SPEC31_EXCLUSIVE_BOUND'));
    assert.ok(compatCodes.has('SPEC31_KEYWORD'));
    assert.equal(report.findings.filter((finding) => finding.severity === 'blocker').length, 0);
  });
});

describe('duplicate YAML keys', () => {
  it('audits with later-value-wins and catalogues SPEC_PARSE_ISSUE', async () => {
    const report = await runAudit({ specPath: fixture('duplicate-keys.yaml') });
    assert.equal(report.summary.operations, 1);
    assert.equal(report.operations[0]?.operationId, 'listThingsV2');
    assert.ok(codes(report).has('SPEC_PARSE_ISSUE'));
  });

  it('caps parse issue findings and folds the rest into one summary entry', async () => {
    const duplicates = Array.from(
      { length: 300 },
      (_, index) => `  k${index}: 1\n  k${index}: 2`,
    ).join('\n');
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths: {}',
      'x-data:',
      duplicates,
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-dupcap-'));
    const specPath = join(dir, 'dup.yaml');
    await writeFile(specPath, yaml);
    const report = await runAudit({ specPath });
    const issues = report.findings.filter((finding) => finding.code === 'SPEC_PARSE_ISSUE');
    assert.equal(issues.length, MAX_PARSE_ISSUES + 1);
    const summary = issues.find((finding) => /further parse issue/.test(finding.message));
    assert.ok(summary, 'expected one summary entry for the omitted issues');
    assert.match(summary.message, /omitted \(300 in total\)/);
    assert.equal(report.summary.readiness, 'blocked');
  });
});

describe('unquoted flow-mapping commas', () => {
  it('catches a mangled response description with no schema involved', async () => {
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths:',
      '  /v1/things:',
      '    post:',
      '      operationId: createThing',
      '      responses:',
      "        '400': {description: Missing disposition, revision, reason, or idempotency key}",
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-flowcomma-'));
    const specPath = join(dir, 'flow-comma.yaml');
    await writeFile(specPath, yaml);
    const report = await runAudit({ specPath });
    // This response is not under a schema, so the only earlier signal
    // (SCHEMA_KEYWORD_UNSUPPORTED) never fires; the dedicated check must.
    assert.ok(!codes(report).has('SCHEMA_KEYWORD_UNSUPPORTED'));
    const finding = report.findings.find((item) => item.code === 'SPEC_YAML_FLOW_COMMA');
    assert.ok(finding, 'expected a SPEC_YAML_FLOW_COMMA finding');
    assert.equal(finding.severity, 'warning');
    assert.match(finding.message, /"revision"/);
    assert.match(finding.message, /"reason"/);
    assert.match(finding.message, /"or idempotency key"/);
    assert.match(finding.message, /Missing disposition, revision, reason, or idempotency key/);
  });

  it('catches the same bug in a parameter description', async () => {
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths:',
      '  /v1/things:',
      '    get:',
      '      operationId: listThings',
      '      parameters:',
      '        - {name: cursor, in: query, description: Opaque cursor, do not parse}',
      "      responses: {'200': {description: OK}}",
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-flowcomma-param-'));
    const specPath = join(dir, 'flow-comma-param.yaml');
    await writeFile(specPath, yaml);
    const report = await runAudit({ specPath });
    const finding = report.findings.find((item) => item.code === 'SPEC_YAML_FLOW_COMMA');
    assert.ok(finding, 'expected a SPEC_YAML_FLOW_COMMA finding for the parameter');
    assert.match(finding.message, /"do not parse"/);
  });

  it('does not flag a quoted description with a comma', async () => {
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths:',
      '  /v1/things:',
      '    post:',
      '      operationId: createThing',
      '      responses:',
      "        '400': {description: 'Missing disposition, revision, or reason'}",
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-flowcomma-quoted-'));
    const specPath = join(dir, 'flow-comma-quoted.yaml');
    await writeFile(specPath, yaml);
    const report = await runAudit({ specPath });
    assert.ok(!codes(report).has('SPEC_YAML_FLOW_COMMA'));
  });

  it('does not flag an ordinary two-field flow mapping', async () => {
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'paths:',
      '  /v1/things:',
      '    get:',
      '      operationId: listThings',
      '      summary: List things',
      '      description: Lists all things',
      "      responses: {'200': {description: OK}}",
      '',
    ].join('\n');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-flowcomma-ok-'));
    const specPath = join(dir, 'flow-comma-ok.yaml');
    await writeFile(specPath, yaml);
    const report = await runAudit({ specPath });
    assert.ok(!codes(report).has('SPEC_YAML_FLOW_COMMA'));
  });
});

describe('docs cross-reference', () => {
  it('reports documented paths missing from the spec and undocumented operations', async () => {
    const report = await runAudit({
      specPath: fixture('openapi-30.json'),
      docsPaths: [fixture('docs')],
    });
    assert.ok(report.docs);
    assert.ok(report.docs.documentedNotInSpec.includes('/v1/ghost'));
    assert.ok(!report.docs.documentedPaths.includes('/Entra/Google'));
    assert.ok(!report.docs.documentedPaths.includes('/SAML/SCIM'));
    assert.ok(report.docs.specNotDocumented.includes('/v1/widgets'));
    assert.ok(!report.docs.specNotDocumented.includes('/v1/users'));
  });
});

describe('runAudit report bound', () => {
  it('rejects a report that a shared path item inflates past the limit', async () => {
    const longName = 'x'.repeat(20_000);
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 1_800; index += 1) {
      paths[`/p${index}`] = { $ref: '#/components/pathItems/Shared' };
    }
    const spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://x.test' }],
      paths,
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        pathItems: {
          Shared: {
            get: {
              operationId: 'getThing',
              summary: 'Get thing',
              description: 'Get a thing.',
              parameters: [{ name: longName, in: 'query', schema: { type: 'string' } }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-amplified-'));
    const specPath = join(dir, 'amplified.json');
    await writeFile(specPath, JSON.stringify(spec));
    await assert.rejects(() => runAudit({ specPath }), /the limit is/);
  });
});

describe('runAudit finding volume', () => {
  it('never dies with a stack error when a spec mints findings at scale', async () => {
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < 160_000; index += 1) {
      schemas[`S${index}`] = { type: 'bogus' };
    }
    const spec = {
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://x.test' }],
      paths: {},
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        schemas,
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'mcp-gen-manyfindings-'));
    const specPath = join(dir, 'many.json');
    await writeFile(specPath, JSON.stringify(spec));
    let error: unknown;
    let report: Awaited<ReturnType<typeof runAudit>> | undefined;
    try {
      report = await runAudit({ specPath });
    } catch (caught) {
      error = caught;
    }
    if (error !== undefined) {
      // The report-size budget may still reject the audit; a RangeError
      // from spreading findings into push() must not.
      assert.ok(error instanceof Error && !(error instanceof RangeError));
      assert.match(error.message, /the limit is/);
    } else {
      assert.ok(report);
      assert.ok(
        report.findings.filter((finding) => finding.code === 'SCHEMA_TYPE_UNSUPPORTED').length >=
          160_000,
      );
    }
  });
});

describe('renderMarkdown', () => {
  it('renders summary, inventory and findings sections', async () => {
    const report = await runAudit({ specPath: fixture('openapi-31.yaml') });
    const markdown = renderMarkdown({ report });
    assert.match(markdown, /# MCP Generator Audit/);
    assert.match(markdown, /## Operations/);
    assert.match(markdown, /## Findings/);
    assert.match(markdown, /list-admin-users/);
  });
});

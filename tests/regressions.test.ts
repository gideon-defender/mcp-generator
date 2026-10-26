import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_YAML_ALIAS_COUNT } from '../src/audit/load-spec.js';
import { estimateJsonBytes } from '../src/audit/report-size.js';
import { deriveToolName } from '../src/audit/names.js';
import { renderMarkdown } from '../src/audit/report.js';
import { runAudit } from '../src/index.js';
import { baseSpec, codes, createAudit, jsonResponse, okOperation, type Spec } from './helpers.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const { audit } = createAudit({ prefix: 'mcp-gen-regressions-' });

describe('review regressions', () => {
  it('blocks a multi-type request body with no JSON type', async () => {
    const spec = baseSpec({
      '/v1/a': {
        post: okOperation({
          operationId: 'postThing',
          requestBody: {
            content: {
              'text/plain': { schema: { type: 'string' } },
              'application/xml': { schema: { type: 'object' } },
            },
          },
        }),
      },
    });
    const report = await audit({ spec });
    assert.ok(codes(report).has('BODY_MULTIPLE_MIME'));
    assert.ok(codes(report).has('BODY_MIME_UNSUPPORTED'));
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('keeps a multi-type body with a JSON type as a warning only', async () => {
    const spec = baseSpec({
      '/v1/a': {
        post: okOperation({
          operationId: 'postThing',
          requestBody: {
            content: {
              'application/json': { schema: { type: 'object' } },
              'text/plain': { schema: { type: 'string' } },
            },
          },
        }),
      },
    });
    const report = await audit({ spec });
    assert.ok(codes(report).has('BODY_MULTIPLE_MIME'));
    assert.ok(!codes(report).has('BODY_MIME_UNSUPPORTED'));
  });

  it('reports dangling and external path item refs instead of dropping operations', async () => {
    const dangling = await audit({
      spec: baseSpec({
        '/v1/users': { $ref: '#/components/pathItems/Missing' },
        '/v1/ok': { get: okOperation({ operationId: 'okOp' }) },
      }),
    });
    assert.equal(dangling.summary.operations, 1);
    assert.ok(codes(dangling).has('PATH_ITEM_REF_UNSUPPORTED'));
    assert.equal(dangling.summary.readiness, 'blocked');

    const external = await audit({
      spec: baseSpec({ '/v1/users': { $ref: 'https://example.test/pi.yaml' } }),
    });
    assert.equal(external.summary.operations, 0);
    assert.ok(codes(external).has('PATH_ITEM_REF_UNSUPPORTED'));
    assert.equal(external.summary.readiness, 'blocked');
  });

  it('reports a dangling response ref', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({ responses: { '200': { $ref: '#/components/responses/Missing' } } }),
      },
    });
    const report = await audit({ spec });
    assert.ok(codes(report).has('RESPONSE_REF_UNSUPPORTED'));
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('skips bad path items and operations without aborting the audit', async () => {
    const spec = baseSpec({
      '/bad': { get: null },
      '/broken': null,
      '/v1/good': { get: okOperation({ operationId: 'goodOp' }) },
    });
    const report = await audit({ spec });
    assert.equal(report.summary.operations, 1);
    assert.equal(report.operations[0]?.operationId, 'goodOp');
    assert.ok(codes(report).has('OPERATION_INVALID'));
    assert.ok(codes(report).has('PATH_ITEM_INVALID'));
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('treats $defs as a 3.1 keyword and walks schemas under it', async () => {
    const spec: Spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://x.test' }],
      paths: {
        '/v1/a': {
          get: jsonResponse({
            type: 'object',
            $defs: { Bad: { type: 'string', format: 'hostname' } },
          }),
        },
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    };
    const report = await audit({ spec });
    assert.ok(codes(report).has('SPEC31_KEYWORD'));
    const format = report.findings.filter(
      (finding) => finding.code === 'SCHEMA_FORMAT_UNSUPPORTED',
    );
    assert.equal(format.length, 1);
    assert.ok(format[0]?.location.includes('/$defs/'));
  });

  it('flags a schema ref that points at a non-schema value', async () => {
    const spec = baseSpec({ '/v1/a': { get: jsonResponse({ $ref: '#/info/title' }) } });
    const report = await audit({ spec });
    assert.ok(codes(report).has('SCHEMA_REF_DANGLING'));
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('blocks schema nodes that are not objects and non-string $ref values', async () => {
    const cases: { schema: Spec; code: string }[] = [
      { schema: { type: 'array', items: [{ type: 'bogus' }] }, code: 'SCHEMA_INVALID' },
      { schema: { allOf: { type: 'bogus' } }, code: 'SCHEMA_TYPE_UNSUPPORTED' },
      { schema: { type: 'object', properties: { x: 'nope' } }, code: 'SCHEMA_INVALID' },
      { schema: { $ref: 123 }, code: 'SCHEMA_INVALID' },
    ];
    for (const { schema, code } of cases) {
      const report = await audit({ spec: baseSpec({ '/v1/a': { get: jsonResponse(schema) } }) });
      assert.ok(
        codes(report).has(code),
        `expected ${code} for ${JSON.stringify(schema)}, got ${[...codes(report)].join(', ')}`,
      );
      assert.equal(report.summary.readiness, 'blocked');
    }

    const component = await audit({
      spec: baseSpec(
        { '/v1/a': { get: okOperation() } },
        {
          components: {
            securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
            schemas: { Bad: 'nope' },
          },
        },
      ),
    });
    assert.ok(codes(component).has('SCHEMA_INVALID'));
    assert.equal(component.summary.readiness, 'blocked');
  });

  it('accepts a 3.1 schema ref that points at a boolean schema', async () => {
    const spec: Spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://x.test' }],
      paths: { '/v1/a': { get: jsonResponse({ $ref: '#/components/schemas/Flag' }) } },
      components: {
        schemas: { Flag: true },
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    };
    const report = await audit({ spec });
    assert.ok(!codes(report).has('SCHEMA_REF_DANGLING'));
  });

  it('counts a shared component schema fault once', async () => {
    const spec = baseSpec(
      {
        '/v1/a': {
          get: okOperation({ responses: { '200': { $ref: '#/components/responses/Bad' } } }),
        },
      },
      {
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          responses: {
            Bad: {
              description: 'x',
              content: { 'application/json': { schema: { type: 'string', format: 'hostname' } } },
            },
          },
        },
      },
    );
    const report = await audit({ spec });
    const format = report.findings.filter(
      (finding) => finding.code === 'SCHEMA_FORMAT_UNSUPPORTED',
    );
    assert.equal(format.length, 1);
  });

  it('classifies $schema in a 3.1 document as compat31, not a blocker', async () => {
    const spec: Spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://x.test' }],
      paths: {
        '/v1/a': {
          get: jsonResponse({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'string',
          }),
        },
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    };
    const report = await audit({ spec });
    const keyword = report.findings.filter((finding) => finding.code === 'SPEC31_KEYWORD');
    assert.equal(keyword.length, 1);
    assert.equal(keyword[0]?.severity, 'compat31');
    assert.ok(!codes(report).has('SCHEMA_KEYWORD_UNSUPPORTED'));
    assert.equal(report.summary.readiness, 'needs-31-support');
  });

  it('flags type null and boolean schemas in a 3.0 document', async () => {
    const nullReport = await audit({
      spec: baseSpec({ '/v1/a': { get: jsonResponse({ type: 'null' }) } }),
    });
    assert.ok(codes(nullReport).has('SCHEMA_TYPE_UNSUPPORTED'));
    assert.equal(nullReport.summary.readiness, 'blocked');

    const boolReport = await audit({
      spec: baseSpec(
        {
          '/v1/a': {
            get: jsonResponse({ type: 'object', properties: { x: false } }),
          },
        },
        {
          components: {
            schemas: { Flag: false },
            securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          },
        },
      ),
    });
    const booleans = boolReport.findings.filter(
      (finding) => finding.code === 'SPEC31_BOOLEAN_SCHEMA',
    );
    // One for the boolean component schema, one for the boolean property.
    assert.equal(booleans.length, 2);
    assert.equal(boolReport.summary.readiness, 'blocked');
  });

  it('catalogues boolean schemas and solo null types as compat31 in a 3.1 document', async () => {
    const spec: Spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://x.test' }],
      paths: {
        '/v1/a': {
          get: jsonResponse({
            type: 'object',
            properties: { x: false, nothing: { type: 'null' } },
          }),
        },
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    };
    const report = await audit({ spec });
    const booleans = report.findings.filter((finding) => finding.code === 'SPEC31_BOOLEAN_SCHEMA');
    assert.equal(booleans.length, 1);
    assert.equal(booleans[0]?.severity, 'compat31');
    const nulls = report.findings.filter((finding) => finding.code === 'SPEC31_TYPE_NULL');
    assert.equal(nulls.length, 1);
    assert.equal(nulls[0]?.severity, 'compat31');
    assert.equal(report.findings.filter((finding) => finding.severity === 'blocker').length, 0);
    assert.equal(report.summary.readiness, 'needs-31-support');
  });

  it('counts a YAML-anchored schema reused in a nested position once', async () => {
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      "servers: [{url: 'https://x.test'}]",
      'components:',
      '  securitySchemes: {bearerAuth: {type: http, scheme: bearer}}',
      '  schemas:',
      '    Bad: &bad',
      '      type: string',
      '      format: hostname',
      'paths:',
      '  /v1/a:',
      '    get:',
      '      operationId: getThing',
      '      summary: s',
      '      description: d',
      '      responses:',
      "        '200':",
      '          description: OK',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      '                properties:',
      '                  nested: *bad',
      '',
    ].join('\n');
    const report = await audit({ spec: yaml, name: 'shared.yaml' });
    const format = report.findings.filter(
      (finding) => finding.code === 'SCHEMA_FORMAT_UNSUPPORTED',
    );
    assert.equal(format.length, 1);
  });

  it('audits a long chain of schema references without quadratic delay', async () => {
    const schemas: Spec = {};
    const count = 4000;
    for (let index = 0; index < count; index += 1) {
      schemas[`S${index}`] =
        index === count - 1 ? { type: 'string' } : { $ref: `#/components/schemas/S${index + 1}` };
    }
    const spec = baseSpec(
      { '/v1/a': { get: okOperation() } },
      {
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          schemas,
        },
      },
    );
    const started = Date.now();
    const report = await audit({ spec });
    assert.ok(!codes(report).has('SCHEMA_REF_DANGLING'));
    assert.ok(!codes(report).has('SCHEMA_REF_CYCLE'));
    assert.ok(Date.now() - started < 2000, 'chained ref resolution should stay linear');
  });

  it('audits many paths that share one path item without quadratic delay', async () => {
    const paths: Spec = {};
    for (let index = 0; index < 2_000; index += 1) {
      paths[`/p${index}`] = { $ref: '#/components/pathItems/Shared' };
    }
    const spec = baseSpec(paths, {
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        pathItems: {
          Shared: {
            parameters: Array.from({ length: 2_000 }, () => ({
              $ref: '#/components/parameters/Missing',
            })),
            get: okOperation(),
          },
        },
      },
    });
    const started = Date.now();
    const report = await audit({ spec });
    assert.equal(report.summary.operations, 2_000);
    assert.ok(codes(report).has('PARAM_REF_UNSUPPORTED'));
    assert.ok(Date.now() - started < 2000, 'shared path-item parameters should be collected once');
  });

  it('derives a name from a long uppercase operationId without delay', () => {
    const started = Date.now();
    const name = deriveToolName({ operationId: 'A'.repeat(60_000), method: 'get', path: '/x' });
    assert.equal(name, 'a'.repeat(60_000));
    assert.ok(Date.now() - started < 2000, 'derivation should stay linear');
  });

  it('keeps spec text inside Markdown cells and out of link syntax', async () => {
    const spec = baseSpec({
      '/v1/a\r## INJECTED': { get: okOperation() },
    });
    (spec['info'] as Spec)['title'] = 'T [click](https://evil.example/phish)';
    const report = await audit({ spec });
    const markdown = renderMarkdown({ report });
    assert.ok(!markdown.includes('\r'));
    assert.ok(!markdown.split('\n').some((line) => line.startsWith('## INJECTED')));
    assert.ok(!markdown.includes('[click]('));
    assert.ok(markdown.includes('\\[click\\]'));
  });

  it('blocks a request body that declares no media types', async () => {
    const spec = baseSpec({
      '/v1/a': {
        post: okOperation({
          operationId: 'postThing',
          requestBody: { required: true, content: {} },
        }),
      },
    });
    const report = await audit({ spec });
    const mime = report.findings.filter((finding) => finding.code === 'BODY_MIME_UNSUPPORTED');
    assert.equal(mime.length, 1);
    assert.equal(mime[0]?.severity, 'blocker');
    assert.equal(report.summary.readiness, 'blocked');

    // A $ref body gets the ref finding only, not a second no-media finding.
    const refReport = await audit({
      spec: baseSpec({
        '/v1/a': {
          post: okOperation({
            operationId: 'postThing',
            requestBody: { $ref: '#/components/requestBodies/X' },
          }),
        },
      }),
    });
    assert.ok(codes(refReport).has('BODY_REF_UNSUPPORTED'));
    assert.ok(!codes(refReport).has('BODY_MIME_UNSUPPORTED'));
  });

  it('does not invent "0" entries from array-shaped responses, content, or security', async () => {
    const spec = baseSpec({
      '/v1/a': {
        post: okOperation({
          operationId: 'postThing',
          security: [['bearerAuth']],
          requestBody: { content: ['application/json'] },
          responses: ['200'],
        }),
      },
    });
    const report = await audit({ spec });
    const op = report.operations[0];
    assert.deepEqual(op?.responseStatuses, []);
    assert.deepEqual(op?.responseContentTypes, []);
    assert.deepEqual(op?.requestContentTypes, []);
    assert.deepEqual(op?.security, []);
  });

  it('resolves percent-encoded tilde escapes in $ref targets', async () => {
    const spec = baseSpec(
      {
        '/v1/a': { get: jsonResponse({ $ref: '#/components/schemas/a%7E1b' }) },
        '/v1/b': {
          get: okOperation({
            operationId: 'getOther',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/a%7E0b' } },
                },
              },
            },
          }),
        },
      },
      {
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          schemas: {
            'a/b': { type: 'string' },
            'a~b': { type: 'string' },
          },
        },
      },
    );
    const report = await audit({ spec });
    assert.ok(!codes(report).has('SCHEMA_REF_DANGLING'));
  });

  it('blocks malformed request body and response shapes', async () => {
    const body = await audit({
      spec: baseSpec({
        '/v1/a': { post: okOperation({ operationId: 'postThing', requestBody: 'plain' }) },
      }),
    });
    assert.ok(codes(body).has('BODY_INVALID'));
    assert.equal(body.summary.readiness, 'blocked');

    const response = await audit({
      spec: baseSpec({
        '/v1/a': { get: okOperation({ responses: { '200': 'OK' } }) },
      }),
    });
    assert.ok(codes(response).has('RESPONSE_INVALID'));
    assert.equal(response.summary.readiness, 'blocked');

    const responses = await audit({
      spec: baseSpec({
        '/v1/a': { get: okOperation({ responses: 'none' }) },
      }),
    });
    assert.ok(codes(responses).has('RESPONSE_INVALID'));
    assert.equal(responses.summary.readiness, 'blocked');
  });

  it('reports dangling header refs and walks header content schemas', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          responses: {
            '200': {
              description: 'OK',
              headers: {
                'X-Missing': { $ref: '#/components/headers/Missing' },
                'X-Bad': {
                  content: {
                    'application/json': { schema: { type: 'string', format: 'hostname' } },
                  },
                },
              },
            },
          },
        }),
      },
    });
    const report = await audit({ spec });
    const ref = report.findings.find((entry) => entry.code === 'HEADER_REF_UNSUPPORTED');
    assert.ok(ref, 'expected a HEADER_REF_UNSUPPORTED finding');
    assert.equal(ref.severity, 'blocker');
    const format = report.findings.find((entry) => entry.code === 'SCHEMA_FORMAT_UNSUPPORTED');
    assert.ok(format, 'expected a SCHEMA_FORMAT_UNSUPPORTED finding for the header content');
    assert.ok(format.location.includes('/headers/X-Bad/content/'));
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('rejects a shared path item expansion at the report limit', async () => {
    const paths: Spec = {
      '/shared': {
        get: okOperation({
          operationId: 'sharedOp',
          description: 'd'.repeat(20_000),
        }),
      },
    };
    for (let index = 0; index < 2500; index += 1) {
      paths[`/v1/p${index}`] = { $ref: '#/paths/~1shared' };
    }
    await assert.rejects(audit({ spec: baseSpec(paths) }), /Audit report would be about/);
  });

  it('audits a YAML anchor reused more than 100 times', async () => {
    const lines = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      "servers: [{url: 'https://x.test'}]",
      'components:',
      '  securitySchemes: {bearerAuth: {type: http, scheme: bearer}}',
      '  schemas:',
      '    Shared: &shared {type: string}',
      'paths:',
    ];
    for (let index = 0; index < 105; index += 1) {
      lines.push(
        `  /v1/p${index}:`,
        '    get:',
        `      operationId: op${index}`,
        '      summary: s',
        '      description: d',
        "      responses: {'200': {description: OK, content: {application/json: {schema: *shared}}}}",
      );
    }
    const report = await audit({ spec: lines.join('\n'), name: 'aliases.yaml' });
    assert.equal(report.summary.operations, 105);
  });

  it('still rejects a YAML document past the alias limit', async () => {
    const count = MAX_YAML_ALIAS_COUNT + 5;
    const lines = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      'components: {schemas: {Shared: &shared {type: string}}}',
      'paths:',
      '  /v1/a:',
      '    get:',
      '      operationId: op',
      '      summary: s',
      '      description: d',
      "      responses: {'200': {description: OK, content: {application/json: {schema: {type: object, properties: {",
    ];
    for (let index = 0; index < count; index += 1) {
      lines.push(`        p${index}: *shared,`);
    }
    lines.push('      }}}}}}');
    await assert.rejects(
      audit({ spec: lines.join('\n'), name: 'too-many-aliases.yaml' }),
      /could not parse as YAML/,
    );
  });

  it('rejects a YAML merge-key expansion past the merged-keys limit', async () => {
    const lines = ['openapi: 3.0.3', "info: {title: T, version: '1'}", 'shared: &shared'];
    for (let index = 0; index < 2_000; index += 1) lines.push(`  k${index}: 1`);
    lines.push('holders:');
    for (let index = 0; index < 600; index += 1) lines.push(`  h${index}: {<<: *shared}`);
    await assert.rejects(
      audit({ spec: lines.join('\n'), name: 'merge-bomb.yaml' }),
      /could not parse as YAML: YAML merge keys would copy/,
    );
  });

  it('counts JSON size as written, escapes and indentation included', () => {
    const values: unknown[] = [
      'plain',
      '\u0001'.repeat(1_000),
      'quote " backslash \\ newline \n emoji \u{1F600} accent é',
      { nested: { list: [1, 'two', { deep: [true, null] }] }, empty: {}, emptyList: [] },
      [{ a: 1 }, { b: [2, 3] }],
      'x'.repeat(5_000),
    ];
    for (const value of values) {
      assert.equal(
        estimateJsonBytes({ value }),
        Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) - 1,
      );
    }
  });

  it('still audits the cyclic fixture', async () => {
    const report = await runAudit({ specPath: resolve(fixtures, 'cyclic.yaml') });
    assert.equal(report.summary.operations, 1);
  });
});

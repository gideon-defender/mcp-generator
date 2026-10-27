import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveToolName } from '../src/audit/names.js';
import { walkSchema } from '../src/audit/schema-checks.js';
import { runAudit, type AuditReport } from '../src/index.js';
import { baseSpec, codes, createAudit, okOperation, type Spec } from './helpers.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const { audit } = createAudit({ prefix: 'mcp-gen-codes-' });

describe('deriveToolName', () => {
  it('keeps a real controller resource token', () => {
    assert.equal(
      deriveToolName({ operationId: 'getControllerStatus', method: 'get', path: '/x' }),
      'get-controller-status',
    );
    assert.equal(
      deriveToolName({ operationId: 'getStatus', method: 'get', path: '/y' }),
      'get-status',
    );
  });

  it('keeps non-ASCII letters that tell operationIds apart', () => {
    assert.equal(
      deriveToolName({ operationId: 'listcafé', method: 'get', path: '/x' }),
      'listcafé',
    );
    assert.equal(
      deriveToolName({ operationId: 'caféList', method: 'get', path: '/x' }),
      'café-list',
    );
    assert.notEqual(
      deriveToolName({ operationId: 'listcafé', method: 'get', path: '/x' }),
      deriveToolName({ operationId: 'listcaf', method: 'get', path: '/x' }),
    );
  });

  it('keeps combining marks that tell operationIds apart', () => {
    assert.equal(deriveToolName({ operationId: 'listकि', method: 'get', path: '/x' }), 'listकि');
    assert.notEqual(
      deriveToolName({ operationId: 'listकि', method: 'get', path: '/x' }),
      deriveToolName({ operationId: 'listक', method: 'get', path: '/x' }),
    );
    assert.notEqual(
      deriveToolName({ operationId: 'café', method: 'get', path: '/x' }),
      deriveToolName({ operationId: 'cafe', method: 'get', path: '/x' }),
    );
  });

  it('derives a name from the path when the operationId has no usable token', () => {
    assert.equal(
      deriveToolName({ operationId: '---', method: 'get', path: '/v1/users' }),
      'get-v1-users',
    );
    assert.equal(
      deriveToolName({ operationId: '_v1', method: 'get', path: '/v1/items' }),
      'get-v1-items',
    );
  });

  it('drops only the NestJS class-name suffix', () => {
    assert.equal(
      deriveToolName({ operationId: 'UsersController_listUsers_v1', method: 'get', path: '/x' }),
      'users-list-users',
    );
    assert.equal(
      deriveToolName({ operationId: 'get_user', method: 'get', path: '/x' }),
      'get-user',
    );
    assert.equal(
      deriveToolName({ operationId: null, method: 'get', path: '/v1/users/{id}' }),
      'get-v1-users-id',
    );
  });
});

describe('spec parse issues', () => {
  it('reports duplicate keys in JSON specs, including escaped spellings', async () => {
    const raw =
      '{"openapi":"3.0.3","info":{"title":"Dup","\\u0074itle":"Dup again","version":"1"},"paths":{}}';
    const report = await audit({ spec: raw, name: 'dup.json' });
    const issue = report.findings.find((finding) => finding.code === 'SPEC_PARSE_ISSUE');
    assert.ok(issue, 'expected a SPEC_PARSE_ISSUE finding');
    assert.equal(issue.severity, 'blocker');
    assert.match(issue.message, /Duplicate JSON key: "title"/);
  });
});

describe('review fixes', () => {
  it('inventories operations shared through YAML merge keys', async () => {
    const yaml = [
      'openapi: 3.0.3',
      "info: {title: T, version: '1'}",
      "servers: [{url: 'https://x.test'}]",
      'components: {securitySchemes: {bearerAuth: {type: http, scheme: bearer}}}',
      'paths:',
      '  /v1/a:',
      '    <<: &shared',
      '      get:',
      '        operationId: getThing',
      '        summary: s',
      '        description: d',
      "        responses: {'200': {description: OK}}",
      '  /v1/b:',
      '    get: &op',
      '      operationId: getOther',
      '      summary: s',
      '      description: d',
      "      responses: {'200': {description: OK}}",
      '  /v1/c:',
      '    get:',
      '      <<: *op',
      '      operationId: getThird',
      '',
    ].join('\n');
    const report = await audit({ spec: yaml, name: 'merged.yaml' });
    assert.equal(report.summary.operations, 3);
    assert.deepEqual(report.operations.map((op) => op.operationId).sort(), [
      'getOther',
      'getThing',
      'getThird',
    ]);
    // The merged operation keeps the shared summary and responses.
    const third = report.operations.find((op) => op.operationId === 'getThird');
    assert.equal(third?.summary, 's');
    assert.deepEqual(third?.responseStatuses, ['200']);
    assert.ok(!codes(report).has('SPEC_PARSE_ISSUE'));
  });

  it('ignores x- response extensions that carry content', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            'x-note': {
              description: 'Extension',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
        }),
      },
    });
    const report = await audit({ spec });
    assert.ok(!codes(report).has('RESPONSE_MIME_UNSUPPORTED'));
    assert.deepEqual(report.operations[0]?.responseContentTypes, ['application/json']);
    assert.equal(report.summary.readiness, 'ready');
  });

  it('warns when an operation declares no responses at all', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: { operationId: 'getThing', summary: 's', description: 'd' },
      },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'RESPONSE_NO_SUCCESS');
    assert.ok(finding, 'expected a RESPONSE_NO_SUCCESS finding');
    assert.equal(finding.severity, 'warning');
    assert.equal(report.summary.readiness, 'ready-with-warnings');
  });

  it('treats a declared 3xx response as a terminal success (redirect-only OAuth/SAML flows)', async () => {
    const spec = baseSpec({
      '/v1/saml/sso': {
        get: okOperation({
          operationId: 'samlSsoRedirect',
          responses: {
            '302': { description: 'Redirect to the identity provider' },
            '400': { description: 'Bad request' },
          },
        }),
      },
    });
    const report = await audit({ spec });
    assert.ok(!codes(report).has('RESPONSE_NO_SUCCESS'));
    assert.equal(report.summary.readiness, 'ready');
  });

  it('still warns when an operation declares only error responses, no 2xx/3xx/default', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          responses: {
            '400': { description: 'Bad request' },
            '404': { description: 'Not found' },
          },
        }),
      },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'RESPONSE_NO_SUCCESS');
    assert.ok(finding, 'expected a RESPONSE_NO_SUCCESS finding');
  });

  it('flags non-string schema types and non-numeric, non-boolean bounds', async () => {
    const numeric = await audit({
      spec: baseSpec({
        '/v1/a': {
          get: okOperation({
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        bad: { type: 123 },
                        alsoBad: { type: ['string', 42] },
                        bound: { type: 'number', exclusiveMinimum: '5' },
                      },
                    },
                  },
                },
              },
            },
          }),
        },
      }),
    });
    assert.equal(
      numeric.findings.filter((entry) => entry.code === 'SCHEMA_TYPE_UNSUPPORTED').length,
      2,
    );
    const bound = numeric.findings.find(
      (entry) => entry.code === 'SCHEMA_EXCLUSIVE_BOUND_UNSUPPORTED',
    );
    assert.ok(bound, 'expected a SCHEMA_EXCLUSIVE_BOUND_UNSUPPORTED finding');
    assert.equal(bound.severity, 'blocker');
    assert.equal(numeric.summary.readiness, 'blocked');
  });
});

describe('schema walker guards', () => {
  it('checks an aliased schema first reached past the depth limit', () => {
    const leaf: Spec = { bogusKeyword: true };
    let deep: Spec = leaf;
    // 100 wrappers put the leaf itself at depth 101: the walk calls the
    // leaf check past the limit instead of stopping one level above it.
    for (let level = 0; level < 100; level += 1) {
      deep = { type: 'object', properties: { next: deep } };
    }
    const root: Spec = { type: 'object', properties: { deep, shallow: leaf } };
    const findings: AuditReport['findings'] = [];
    walkSchema({
      schema: root,
      location: '/test',
      document: {},
      is31: false,
      push: (finding) => findings.push(finding),
    });
    assert.ok(findings.some((finding) => finding.code === 'SCHEMA_DEPTH_EXCEEDED'));
    assert.ok(
      findings.some((finding) => finding.code === 'SCHEMA_KEYWORD_UNSUPPORTED'),
      'the shallow alias visit must still check the shared schema',
    );
  });

  it('checks an aliased schema first reached just before the depth limit', () => {
    const bad: Spec = { bogusKeyword: true };
    const shared: Spec = { type: 'object', properties: { bad } };
    let deep: Spec = shared;
    // 100 wrappers put the shared schema at depth 100: it is checked,
    // but its child sits past the limit and cannot be checked there.
    for (let level = 0; level < 100; level += 1) {
      deep = { type: 'object', properties: { next: deep } };
    }
    const root: Spec = { type: 'object', properties: { deep, shallow: shared } };
    const findings: AuditReport['findings'] = [];
    walkSchema({
      schema: root,
      location: '/test',
      document: {},
      is31: false,
      push: (finding) => findings.push(finding),
    });
    assert.ok(findings.some((finding) => finding.code === 'SCHEMA_DEPTH_EXCEEDED'));
    assert.ok(
      findings.some((finding) => finding.code === 'SCHEMA_KEYWORD_UNSUPPORTED'),
      'the shallow alias visit must resume and check the truncated child',
    );
  });

  it('audits a cyclic YAML-anchor schema instead of crashing', async () => {
    const report = await runAudit({ specPath: resolve(fixtures, 'cyclic.yaml') });
    assert.equal(report.summary.operations, 1);
  });

  it('does not resolve prototype members as refs or schemes', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          security: [{ toString: [] }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/toString' } },
              },
            },
          },
        }),
      },
    });
    const found = codes(await audit({ spec }));
    assert.ok(found.has('SECURITY_SCHEME_UNDEFINED'));
    assert.ok(found.has('SCHEMA_REF_DANGLING'));
  });

  it('does not treat an array securitySchemes value as a scheme map', async () => {
    const withIndexedScheme = baseSpec(
      { '/v1/a': { get: okOperation({ security: [{ '0': [] }] }) } },
      { components: { securitySchemes: ['bearerAuth'] } },
    );
    assert.ok(codes(await audit({ spec: withIndexedScheme })).has('SECURITY_SCHEME_UNDEFINED'));

    const withoutSecurity = baseSpec(
      { '/v1/a': { get: okOperation() } },
      { components: { securitySchemes: ['bearerAuth'] } },
    );
    assert.ok(codes(await audit({ spec: withoutSecurity })).has('SECURITY_NOT_DEFINED'));
  });

  it('flags second-hop external and dangling refs', async () => {
    const spec = baseSpec(
      { '/v1/a': { get: okOperation() } },
      {
        components: {
          schemas: {
            A: { $ref: '#/components/schemas/B' },
            B: { $ref: '#/components/schemas/Missing' },
            C: { $ref: '#/components/schemas/D' },
            D: { $ref: 'https://example.test/schema.json' },
            E: { $ref: '#/components/schemas/F' },
            F: { $ref: '#/components/schemas/E' },
          },
        },
      },
    );
    const found = codes(await audit({ spec }));
    assert.ok(found.has('SCHEMA_REF_DANGLING'));
    assert.ok(found.has('SCHEMA_REF_EXTERNAL'));
    assert.ok(found.has('SCHEMA_REF_CYCLE'));
  });

  it('judges format against the declared type', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      bad: { type: 'string', format: 'int32' },
                      badInt: { type: 'integer', format: 'uuid' },
                      good: { type: 'string', format: 'uuid' },
                      weird: { type: 'array', items: { type: 'string' }, uniqueItems: true },
                      bogus: { type: 'nope' },
                    },
                  },
                },
              },
            },
          },
        }),
      },
    });
    const report = await audit({ spec });
    const formatFindings = report.findings.filter((f) => f.code === 'SCHEMA_FORMAT_UNSUPPORTED');
    assert.equal(formatFindings.length, 2);
    assert.ok(codes(report).has('SCHEMA_KEYWORD_UNSUPPORTED'));
    assert.ok(codes(report).has('SCHEMA_TYPE_UNSUPPORTED'));
  });

  it('flags the 3.0 boolean exclusive form inside a 3.1 document', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://x.test' }],
      paths: {
        '/v1/a': {
          get: okOperation({
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'number', exclusiveMinimum: true },
                  },
                },
              },
            },
          }),
        },
      },
    };
    assert.ok(codes(await audit({ spec })).has('SPEC31_EXCLUSIVE_BOOLEAN'));
  });
});

describe('operation, body, response, and security codes', () => {
  it('blocks a parameter whose style is present but not a string', async () => {
    for (const style of [123, null] as unknown[]) {
      const spec = baseSpec({
        '/v1/a': {
          get: okOperation({
            parameters: [{ name: 'q', in: 'query', style, schema: { type: 'string' } }],
          }),
        },
      });
      const report = await audit({ spec });
      const finding = report.findings.find((entry) => entry.code === 'PARAM_STYLE_UNSUPPORTED');
      assert.ok(finding, `expected PARAM_STYLE_UNSUPPORTED for style ${String(style)}`);
      assert.equal(finding.severity, 'blocker');
      assert.match(finding.message, /non-string style/);
      assert.equal(report.summary.readiness, 'blocked');
    }
  });

  it('emits every code for a kitchen-sink operation', async () => {
    const spec: Spec = {
      openapi: '3.0.3',
      info: { title: 'Kitchen', version: '1' },
      paths: {
        '/v1/kitchen': {
          get: {
            deprecated: true,
            parameters: [
              { name: 'c', in: 'query', content: { 'application/json': { schema: {} } } },
              { name: 'r', in: 'query', allowReserved: true, schema: { type: 'string' } },
              { name: 's', in: 'header', style: 'form', schema: { type: 'string' } },
              { name: 'id', in: 'path', schema: { type: 'string' } },
              { name: 'authorization', in: 'header', schema: { type: 'string' } },
            ],
            requestBody: { $ref: '#/components/requestBodies/X' },
            responses: { '404': { description: 'Nope' } },
          },
          post: {
            operationId: 'multiMime',
            summary: 'Multi',
            description: 'Multi mime.',
            requestBody: {
              content: {
                'application/json': { schema: { type: 'object' } },
                'text/plain': { schema: { type: 'string' } },
              },
            },
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/octet-stream': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
      webhooks: { hook: {} },
    };
    const report = await audit({ spec });
    const found = codes(report);
    // Severity drives readiness; a code at the wrong severity must fail.
    const expectedSeverity: Record<string, string> = {
      OP_MISSING_ID: 'blocker',
      OP_MISSING_SUMMARY: 'warning',
      OP_MISSING_DESCRIPTION: 'warning',
      OP_DEPRECATED: 'info',
      PARAM_CONTENT_UNSUPPORTED: 'blocker',
      PARAM_ALLOW_RESERVED: 'blocker',
      PARAM_STYLE_UNSUPPORTED: 'blocker',
      PARAM_PATH_NOT_REQUIRED: 'blocker',
      PARAM_RESERVED_HEADER: 'blocker',
      BODY_REF_UNSUPPORTED: 'blocker',
      BODY_MULTIPLE_MIME: 'warning',
      RESPONSE_NO_SUCCESS: 'warning',
      RESPONSE_BINARY: 'warning',
      SECURITY_NOT_DEFINED: 'warning',
      SERVER_MISSING: 'warning',
      TOPLEVEL_WEBHOOKS_IGNORED: 'info',
    };
    for (const [code, severity] of Object.entries(expectedSeverity)) {
      assert.ok(found.has(code), `expected ${code}`);
      const matches = report.findings.filter((finding) => finding.code === code);
      assert.ok(
        matches.every((finding) => finding.severity === severity),
        `expected ${code} at severity ${severity}`,
      );
    }
    const triples = report.findings.map(
      (finding) => `${finding.code}|${finding.location}|${finding.message}`,
    );
    assert.equal(new Set(triples).size, triples.length, 'duplicate findings emitted');
  });

  it('ignores x- extensions under paths and responses', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          responses: { '200': { description: 'OK' }, 'x-note': { description: 'Ext' } },
        }),
      },
      'x-group': 'not a path item',
      'x-object': { get: okOperation({ operationId: 'phantom' }) },
    });
    const report = await audit({ spec });
    assert.equal(report.summary.operations, 1);
    assert.equal(report.summary.paths, 1);
    assert.ok(!codes(report).has('PATH_ITEM_INVALID'));
    assert.deepEqual(report.operations[0]?.responseStatuses, ['200']);
  });

  it('resolves $ref responses, normalizes media case, and accepts 2XX', async () => {
    const spec = baseSpec(
      {
        '/v1/stream': {
          get: okOperation({
            responses: { '2XX': { $ref: '#/components/responses/Sse' } },
          }),
          post: okOperation({
            operationId: 'postThing',
            requestBody: {
              content: { 'Application/JSON': { schema: { type: 'object' } } },
            },
            responses: {
              '200': {
                description: 'OK',
                content: { 'Text/Event-Stream; charset=utf-8': { schema: { type: 'string' } } },
              },
            },
          }),
        },
      },
      {
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          responses: {
            Sse: {
              description: 'Stream',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
        },
      },
    );
    const report = await audit({ spec });
    assert.equal(report.findings.filter((f) => f.code === 'RESPONSE_MIME_UNSUPPORTED').length, 2);
    assert.ok(!codes(report).has('RESPONSE_NO_SUCCESS'));
    assert.ok(!codes(report).has('BODY_MIME_UNSUPPORTED'));
  });

  it('blocks a malformed security requirement instead of counting it as present', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          security: [['bearerAuth']] as unknown as Spec[],
        }),
      },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'SECURITY_INVALID');
    assert.ok(finding, 'expected a SECURITY_INVALID finding');
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.location, '/paths/~1v1~1a/get');
    assert.ok(!codes(report).has('SECURITY_SCHEME_UNDEFINED'));
    assert.deepEqual(report.operations[0]?.security, []);
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('resolves a plain-name $anchor reference in the same document', async () => {
    const spec = {
      ...baseSpec(
        {
          '/v1/a': {
            get: okOperation({
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: { $ref: '#PetAnchor' } } },
                },
              },
            }),
          },
        },
        {
          components: {
            securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
            schemas: {
              Pet: {
                $anchor: 'PetAnchor',
                type: 'object',
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      ),
      openapi: '3.1.0',
    };
    const report = await audit({ spec });
    assert.ok(!codes(report).has('SCHEMA_REF_EXTERNAL'));
    assert.ok(!codes(report).has('SCHEMA_REF_DANGLING'));
  });

  it('reports bad references in unused component entries of every section', async () => {
    const spec = baseSpec(
      { '/v1/a': { get: okOperation() } },
      {
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          parameters: { Bad: { $ref: '#/components/parameters/Missing' } },
          requestBodies: { Bad: { $ref: '#/components/requestBodies/Missing' } },
          responses: { Bad: { $ref: '#/components/responses/Missing' } },
          headers: { Bad: { $ref: '#/components/headers/Missing' } },
        },
      },
    );
    const report = await audit({ spec });
    const found = codes(report);
    assert.ok(found.has('PARAM_REF_UNSUPPORTED'));
    assert.ok(found.has('BODY_REF_UNSUPPORTED'));
    assert.ok(found.has('RESPONSE_REF_UNSUPPORTED'));
    assert.ok(found.has('HEADER_REF_UNSUPPORTED'));
    const locations = report.findings
      .filter((finding) => finding.code.endsWith('_REF_UNSUPPORTED'))
      .map((finding) => finding.location)
      .sort();
    assert.deepEqual(locations, [
      '/components/headers/Bad',
      '/components/parameters/Bad',
      '/components/requestBodies/Bad',
      '/components/responses/Bad',
    ]);
  });

  it('escapes duplicate-name locations as JSON Pointers', async () => {
    const spec = baseSpec({
      '/v1/a/{id}': {
        get: okOperation({ operationId: 'get_thing' }),
        delete: okOperation({ operationId: 'getThing' }),
      },
    });
    const report = await audit({ spec });
    const locations = report.findings
      .filter((f) => f.code === 'NAME_DUPLICATE')
      .map((f) => f.location)
      .sort();
    assert.deepEqual(locations, ['/paths/~1v1~1a~1{id}/delete', '/paths/~1v1~1a~1{id}/get']);
  });
});

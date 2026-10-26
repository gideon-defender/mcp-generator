import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseSpec, codes, createAudit, okOperation } from './helpers.js';

const { audit } = createAudit({ prefix: 'mcp-gen-parameters-' });

describe('parameter collection', () => {
  it('checks path-item parameters, merges them, and lets operations override', async () => {
    const spec = baseSpec({
      '/v1/users/{id}': {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'bogus' } },
          {
            name: 'q',
            in: 'query',
            content: { 'application/json': { schema: { type: 'string' } } },
          },
        ],
        get: okOperation({
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        }),
      },
    });
    const report = await audit({ spec });
    assert.ok(codes(report).has('SCHEMA_TYPE_UNSUPPORTED'), 'path-item param schema is checked');
    assert.ok(!codes(report).has('PARAM_CONTENT_UNSUPPORTED'), 'operation override wins');
    const op = report.operations[0];
    assert.deepEqual(op?.parameters.map((param) => param.name).sort(), ['id', 'q']);
  });

  it('points schema findings at the path item for path-level parameters', async () => {
    const spec = baseSpec({
      '/v1/users/{id}': {
        parameters: [
          { name: 'verbose', in: 'query', schema: { type: 'string', format: 'hostname' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'bogus' } },
        ],
        get: okOperation(),
      },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'SCHEMA_TYPE_UNSUPPORTED');
    // The second path-level parameter lives on the path item. The pointer
    // must not place it inside the operation node.
    assert.equal(finding?.location, '/paths/~1v1~1users~1{id}/parameters/1/schema');
  });

  it('blocks a parameter with no name instead of dropping it silently', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          parameters: [{ in: 'query', schema: { type: 'string' } }],
        }),
      },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'PARAM_NAME_MISSING');
    assert.ok(finding, 'expected a PARAM_NAME_MISSING finding');
    assert.equal(finding.severity, 'blocker');
    assert.equal(report.summary.readiness, 'blocked');
    assert.deepEqual(report.operations[0]?.parameters, []);
  });

  it('reports each parameter with no name instead of merging them into one', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          parameters: [
            { in: 'query', content: { 'application/json': { schema: { type: 'string' } } } },
            { in: 'query', schema: { type: 'string' } },
          ],
        }),
      },
    });
    const report = await audit({ spec });
    assert.equal(report.findings.filter((entry) => entry.code === 'PARAM_NAME_MISSING').length, 2);
    assert.deepEqual(report.operations[0]?.parameters, []);
  });

  it('blocks an Accept header parameter that OpenAPI says to ignore', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          parameters: [{ name: 'Accept', in: 'header', schema: { type: 'string' } }],
        }),
      },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'PARAM_RESERVED_HEADER');
    assert.ok(finding, 'expected a PARAM_RESERVED_HEADER finding');
    assert.match(finding.message, /Accept/);
    assert.equal(finding.severity, 'blocker');
  });

  it('blocks duplicate parameters declared in the same list', async () => {
    const spec = baseSpec({
      '/v1/a': {
        get: okOperation({
          parameters: [
            {
              name: 'q',
              in: 'query',
              content: { 'application/json': { schema: { type: 'string' } } },
            },
            { name: 'q', in: 'query', schema: { type: 'string' } },
          ],
        }),
      },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'PARAM_DUPLICATE');
    assert.ok(finding, 'expected a PARAM_DUPLICATE finding');
    assert.equal(finding.severity, 'blocker');
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('blocks path parameters that do not match the path template', async () => {
    const undeclared = await audit({
      spec: baseSpec({ '/v1/users/{id}': { get: okOperation() } }),
    });
    const missing = undeclared.findings.find((entry) => entry.code === 'PARAM_PATH_UNDECLARED');
    assert.ok(missing, 'expected a PARAM_PATH_UNDECLARED finding');
    assert.equal(missing.severity, 'blocker');
    assert.equal(undeclared.summary.readiness, 'blocked');

    const unused = await audit({
      spec: baseSpec({
        '/v1/users': {
          get: okOperation({
            parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }],
          }),
        },
      }),
    });
    const extra = unused.findings.find((entry) => entry.code === 'PARAM_PATH_UNUSED');
    assert.ok(extra, 'expected a PARAM_PATH_UNUSED finding');
    assert.equal(extra.severity, 'blocker');
    assert.equal(unused.summary.readiness, 'blocked');
  });

  it('blocks a parameters field that is not an array', async () => {
    const spec = baseSpec({
      '/v1/a': { get: okOperation({ parameters: 'q' }) },
    });
    const report = await audit({ spec });
    const finding = report.findings.find((entry) => entry.code === 'PARAMETERS_INVALID');
    assert.ok(finding, 'expected a PARAMETERS_INVALID finding');
    assert.equal(finding.severity, 'blocker');
    assert.equal(report.summary.readiness, 'blocked');
  });

  it('resolves chained $ref parameters and reports dangling ones', async () => {
    const spec = baseSpec(
      {
        '/v1/a': {
          get: okOperation({
            parameters: [
              { $ref: '#/components/parameters/Alias' },
              { $ref: '#/components/parameters/Gone' },
            ],
          }),
        },
      },
      {
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          parameters: {
            Alias: { $ref: '#/components/parameters/Real' },
            Real: { name: 'x-trace', in: 'header', schema: { type: 'string' } },
          },
        },
      },
    );
    const report = await audit({ spec });
    assert.ok(codes(report).has('PARAM_REF_UNSUPPORTED'));
    assert.ok(!codes(report).has('PARAM_LOCATION_UNSUPPORTED'));
    assert.deepEqual(
      report.operations[0]?.parameters.map((param) => param.name),
      ['x-trace'],
    );
  });
});

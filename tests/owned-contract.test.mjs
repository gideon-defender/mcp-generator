import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadOpenApi } from '../src/openapi-loader.ts';

// The registry source of truth is opencomp's main spec; the checkout is a sibling directory.
const specPath =
  process.env['OPENCOMP_OPENAPI'] ??
  fileURLToPath(new URL('../../opencomp/packages/docs/openapi.json', import.meta.url));
const source = existsSync(specPath) ? JSON.parse(readFileSync(specPath, 'utf8')) : undefined;
// Set in CI so a missing spec fails the run instead of silently skipping the parity checks.
if (source === undefined && process.env['REQUIRE_OPENCOMP_SPEC'] === '1') {
  throw new Error(`REQUIRE_OPENCOMP_SPEC=1 but no spec at ${specPath}; set OPENCOMP_OPENAPI`);
}
const withSpec = { skip: source === undefined && `no spec at ${specPath}; set OPENCOMP_OPENAPI` };
const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/parity-fixture.json', import.meta.url), 'utf8'),
);
const reviewedAdditions = JSON.parse(
  readFileSync(new URL('./fixtures/reviewed-additions.json', import.meta.url), 'utf8'),
);
const overlay = parse(readFileSync(new URL('../mcp-overlay.yaml', import.meta.url), 'utf8'));
const emptyOverlay = { version: 1, schemas: [], operations: [] };
const operation = (id) => ({ operationId: id, summary: 'Summary', description: 'Description' });
const tinyDocument = (paths) => ({ openapi: '3.0.0', paths, components: { schemas: {} } });

// The frozen oracle is the 400 captured tools; additions are reviewed one by one.
function assertReviewedRegistry({ tools, baseline }) {
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...baseline.tools, ...reviewedAdditions].map((tool) => tool.name).sort(),
  );
  for (const addition of reviewedAdditions) {
    const tool = tools.find((item) => item.name === addition.name);
    for (const field of ['method', 'path', 'operationId'])
      assert.equal(tool[field], addition[field], addition.name);
  }
}

test(
  'owned registry keeps the 400 captured tools and exactly the reviewed additions',
  withSpec,
  () => {
    const before = structuredClone(source);
    const result = loadOpenApi({ source, overlay });
    assertReviewedRegistry({ tools: result.tools, baseline });
    for (const tool of baseline.tools) {
      const actual = result.tools.find((item) => item.name === tool.name);
      assert(actual, tool.name);
      assert.equal(actual.description, tool.description, tool.name);
      assert.equal(actual.path, tool.envelope.path, tool.name);
      assert.equal(actual.method, tool.envelope.method, tool.name);
      assert.equal(actual.operationId, tool.envelope.operationId, tool.name);
    }
    assert.deepEqual(source, before, 'Public docs must remain untouched');
  },
);

test('all captured tools remain available with owned metadata only', withSpec, () => {
  const owned = structuredClone(source);
  for (const item of Object.values(owned.paths)) {
    for (const operation of Object.values(item)) {
      if (operation && typeof operation === 'object') delete operation['x-speakeasy-mcp'];
    }
  }
  const { tools } = loadOpenApi({ source: owned, overlay });
  assertReviewedRegistry({ tools, baseline });
  for (const captured of baseline.tools) {
    assert.equal(
      tools.find((tool) => tool.name === captured.name).description,
      captured.description,
    );
  }
});

test(
  'disabled tools and all four inline-upload fields stay absent; source fields remain',
  withSpec,
  () => {
    const { document, tools } = loadOpenApi({ source, overlay });
    for (const item of overlay.operations) {
      assert(!tools.some((tool) => tool.path === item.path && tool.method === item.method));
    }
    assert(!tools.some((tool) => tool.path === '/v1/policies/{id}/pdf' && tool.method === 'post'));
    for (const schema of overlay.schemas) {
      assert.equal(document.components.schemas[schema.name].properties.fileData, undefined);
      assert(source.components.schemas[schema.name].properties.fileData);
    }
    const description = document.components.schemas.UploadAndParseDto.properties.s3Key.description;
    assert(typeof description === 'string' && description.length > 0);
  },
);

test('owned-only operations derive compatible names and reserve disabled names', () => {
  const paths = {
    '/disabled': {
      post: {
        ...operation('FilesController_upload_v1'),
        'x-comp-mcp': { name: 'upload', disabled: true },
      },
    },
    '/a': { post: operation('FilesController_upload_v2') },
    '/b': { post: operation('FilesController_upload_v3') },
  };
  const { tools } = loadOpenApi({ source: tinyDocument(paths), overlay: emptyOverlay });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['files-upload', 'files-upload-2'],
  );
});

test('name collisions and conflicting owned/legacy declarations fail compilation', () => {
  const same = { ...operation('AController_get_v1'), 'x-comp-mcp': { name: 'same' } };
  assert.throws(
    () =>
      loadOpenApi({
        source: tinyDocument({ '/a': { get: same }, '/b': { get: same } }),
        overlay: emptyOverlay,
      }),
    /Duplicate MCP name/,
  );
  assert.throws(
    () =>
      loadOpenApi({
        source: tinyDocument({
          '/a': {
            get: {
              ...same,
              'x-speakeasy-mcp': { name: 'different' },
            },
          },
        }),
        overlay: emptyOverlay,
      }),
    /Conflicting MCP name/,
  );
});

test('overlay required-field removal leaves no dangling required key', () => {
  const doc = {
    ...tinyDocument({}),
    components: {
      schemas: {
        Upload: {
          type: 'object',
          properties: { fileData: { type: 'string' }, s3Key: { type: 'string' } },
          required: ['fileData', 's3Key'],
        },
      },
    },
  };
  const policy = { ...emptyOverlay, schemas: [{ name: 'Upload', removeProperties: ['fileData'] }] };
  const { document } = loadOpenApi({ source: doc, overlay: policy });
  assert.deepEqual(document.components.schemas.Upload.required, ['s3Key']);
  assert.deepEqual(doc.components.schemas.Upload.required, ['fileData', 's3Key']);
});

test(
  'stale or unsupported overlay targets fail rather than silently exposing tools',
  withSpec,
  () => {
    assert.throws(() => loadOpenApi({ source, overlay: { ...overlay, version: 3 } }));
    assert.throws(
      () =>
        loadOpenApi({
          source,
          overlay: {
            ...emptyOverlay,
            operations: [{ path: '/missing', method: 'get', metadata: { disabled: true } }],
          },
        }),
      /Missing overlay operation/,
    );
    assert.throws(
      () =>
        loadOpenApi({
          source,
          overlay: {
            ...emptyOverlay,
            schemas: [{ name: 'UploadAndParseDto', removeProperties: ['missing'] }],
          },
        }),
      /Missing overlay property/,
    );
  },
);

test('overlay name changes are collision-checked and descriptions are tool-only', () => {
  const doc = tinyDocument({
    '/a': { get: { ...operation('AController_read_v1'), 'x-comp-mcp': { name: 'one' } } },
    '/b': { get: { ...operation('BController_read_v1'), 'x-comp-mcp': { name: 'two' } } },
  });
  assert.throws(
    () =>
      loadOpenApi({
        source: doc,
        overlay: {
          ...emptyOverlay,
          operations: [{ path: '/b', method: 'get', metadata: { name: 'one' } }],
        },
      }),
    /Duplicate MCP name/,
  );
  const result = loadOpenApi({
    source: doc,
    overlay: {
      ...emptyOverlay,
      operations: [{ path: '/a', method: 'get', metadata: { description: 'Agent guidance' } }],
    },
  });
  assert.equal(result.tools[0].description, 'Agent guidance');
  assert.equal(doc.paths['/a'].get.description, 'Description');
});

test('overlay v2 allowlist and operation policy metadata are enforced', () => {
  const doc = tinyDocument({
    '/a': { get: { ...operation('AController_read_v1') } },
    '/b': { post: { ...operation('BController_mutate_v1') } },
  });
  const filtered = loadOpenApi({
    source: doc,
    overlay: {
      version: 2,
      allowlist: ['read-a'],
      schemas: [],
      operations: [
        {
          path: '/a',
          method: 'get',
          metadata: {
            name: 'read-a',
            classification: 'read',
            upstream: 'https://read.example.test',
            redaction: ['token'],
          },
        },
      ],
    },
  });
  assert.deepEqual(
    filtered.tools.map((tool) => tool.name),
    ['read-a'],
  );
  assert.equal(filtered.tools[0].classification, 'read');
  assert.equal(filtered.tools[0].upstream, 'https://read.example.test');
  assert.deepEqual(filtered.tools[0].redaction, ['token']);
});

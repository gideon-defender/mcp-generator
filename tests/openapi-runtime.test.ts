import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignToolNames,
  operationEntries,
  readMetadata,
  type JsonObject,
} from '../src/openapi/metadata.js';
import { applyOwnedOverlay, overlaySchema } from '../src/openapi/overlay.js';
import { loadOpenApi } from '../src/openapi-loader.js';

function op(extra: JsonObject = {}): JsonObject {
  return { operationId: 'resourceAction_v1', summary: 's', description: 'd', ...extra };
}

describe('readMetadata', () => {
  it('prefers the owned extension over the legacy one when they agree or only one is set', () => {
    assert.deepEqual(readMetadata({ 'x-speakeasy-mcp': { name: 'legacy' } }), { name: 'legacy' });
    assert.deepEqual(readMetadata({ 'x-comp-mcp': { name: 'owned' } }), { name: 'owned' });
    assert.deepEqual(
      readMetadata({ 'x-comp-mcp': { disabled: true }, 'x-speakeasy-mcp': { name: 'legacy' } }),
      { name: 'legacy', disabled: true },
    );
  });

  it('rejects a conflicting value between the owned and legacy extensions', () => {
    assert.throws(
      () =>
        readMetadata({
          operationId: 'op1',
          'x-comp-mcp': { name: 'a' },
          'x-speakeasy-mcp': { name: 'b' },
        }),
      /Conflicting MCP name: op1/,
    );
  });
});

describe('operationEntries', () => {
  it('collects every HTTP method present on a path item and normalizes it in place', () => {
    const paths = { '/a': { get: op(), post: op(), summary: 'ignored, not a method' } };
    const entries = operationEntries(paths);
    assert.deepEqual(entries.map((entry) => entry.method).sort(), ['get', 'post']);
    assert.equal(entries[0]?.operation, paths['/a']?.['get']);
  });
});

describe('assignToolNames', () => {
  it('keeps an explicit name and still derives names for the rest', () => {
    const entries = operationEntries({
      '/a': { get: op({ operationId: 'widgets_list_v1', 'x-comp-mcp': { name: 'ls-widgets' } }) },
      '/b': { get: op({ operationId: 'widgetsController_get_v1' }) },
    });
    assignToolNames(entries);
    assert.equal(readMetadata(entries[0]!.operation).name, 'ls-widgets');
    assert.equal(readMetadata(entries[1]!.operation).name, 'get');
  });

  it('falls back to resource-method when the bare method name is already taken', () => {
    const entries = operationEntries({
      '/a': { get: op({ operationId: 'widgetsController_get_v1' }) },
      '/b': { get: op({ operationId: 'gadgetsController_get_v1' }) },
    });
    assignToolNames(entries);
    // First entry claims the bare method name; the next one falls back to resource-method.
    assert.equal(readMetadata(entries[0]!.operation).name, 'get');
    assert.equal(readMetadata(entries[1]!.operation).name, 'gadgets-get');
  });

  it('disambiguates a remaining collision with a numeric suffix', () => {
    const entries = operationEntries({
      '/a': { get: op({ operationId: 'widgetsController_get_v1' }) },
      '/b': { get: op({ operationId: 'gadgetsController_get_v1' }) },
      '/c': { get: op({ operationId: 'gadgetsController_get_v2' }) },
    });
    assignToolNames(entries);
    assert.equal(readMetadata(entries[0]!.operation).name, 'get');
    assert.equal(readMetadata(entries[1]!.operation).name, 'gadgets-get');
    assert.equal(readMetadata(entries[2]!.operation).name, 'gadgets-get-2');
  });

  it('rejects two explicit names that collide, including a disabled one', () => {
    const entries = operationEntries({
      '/a': { get: op({ 'x-comp-mcp': { name: 'dup' } }) },
      '/b': { get: op({ 'x-comp-mcp': { name: 'dup', disabled: true } }) },
    });
    assert.throws(() => assignToolNames(entries), /Duplicate MCP name: dup/);
  });

  it('never derives a name for a disabled operation', () => {
    const entries = operationEntries({
      '/a': { get: op({ 'x-comp-mcp': { disabled: true } }) },
    });
    assignToolNames(entries);
    assert.equal(readMetadata(entries[0]!.operation).name, undefined);
  });
});

describe('applyOwnedOverlay', () => {
  it('removes a schema property and drops it from required', () => {
    const document: JsonObject = {
      components: {
        schemas: {
          Widget: {
            type: 'object',
            properties: { id: { type: 'string' }, secret: { type: 'string' } },
            required: ['id', 'secret'],
          },
        },
      },
    };
    const overlay = overlaySchema.parse({
      version: 1,
      schemas: [{ name: 'Widget', removeProperties: ['secret'] }],
      operations: [],
    });
    applyOwnedOverlay({ document, entries: [], overlay });
    const widget = (document.components as JsonObject).schemas as JsonObject;
    const schema = widget.Widget as JsonObject;
    assert.deepEqual(Object.keys(schema.properties as JsonObject), ['id']);
    assert.deepEqual(schema.required, ['id']);
  });

  it('rewrites a property description without touching its type', () => {
    const document: JsonObject = {
      components: {
        schemas: { Widget: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    };
    const overlay = overlaySchema.parse({
      version: 1,
      schemas: [{ name: 'Widget', properties: { id: { description: 'new text' } } }],
      operations: [],
    });
    applyOwnedOverlay({ document, entries: [], overlay });
    const schemas = (document.components as JsonObject).schemas as JsonObject;
    const idProp = ((schemas.Widget as JsonObject).properties as JsonObject).id as JsonObject;
    assert.equal(idProp.description, 'new text');
    assert.equal(idProp.type, 'string');
  });

  it('applies to a document with no components section at all (no overlay schema entries)', () => {
    // Regression: applyOwnedOverlay used to require components.schemas to
    // already exist, which crashed on a perfectly valid spec that has no
    // components section and an overlay with nothing to change.
    const document: JsonObject = { paths: {} };
    const overlay = overlaySchema.parse({ version: 1, schemas: [], operations: [] });
    assert.doesNotThrow(() => applyOwnedOverlay({ document, entries: [], overlay }));
    assert.deepEqual((document.components as JsonObject).schemas, {});
  });

  it('throws when the overlay names a schema or property that does not exist', () => {
    const document: JsonObject = { components: { schemas: {} } };
    const missingSchema = overlaySchema.parse({
      version: 1,
      schemas: [{ name: 'Ghost', removeProperties: ['x'] }],
      operations: [],
    });
    assert.throws(
      () => applyOwnedOverlay({ document, entries: [], overlay: missingSchema }),
      /expected record, received undefined|Ghost/,
    );
  });

  it('disables an operation and migrates it off the legacy extension', () => {
    const entries = operationEntries({
      '/a': { get: op({ 'x-speakeasy-mcp': { name: 'old' } }) },
    });
    const overlay = overlaySchema.parse({
      version: 1,
      schemas: [],
      operations: [{ path: '/a', method: 'get', metadata: { disabled: true } }],
    });
    applyOwnedOverlay({ document: {}, entries, overlay });
    const operation = entries[0]!.operation;
    assert.equal(operation['x-speakeasy-mcp'], undefined);
    assert.deepEqual(operation['x-comp-mcp'], { name: 'old', disabled: true });
  });

  it('rejects a duplicate overlay operation and a reference to a missing operation', () => {
    const entries = operationEntries({ '/a': { get: op() } });
    const duplicate = overlaySchema.parse({
      version: 1,
      schemas: [],
      operations: [
        { path: '/a', method: 'get', metadata: { disabled: true } },
        { path: '/a', method: 'get', metadata: { disabled: false } },
      ],
    });
    assert.throws(
      () => applyOwnedOverlay({ document: {}, entries, overlay: duplicate }),
      /Duplicate overlay operation/,
    );
    const missing = overlaySchema.parse({
      version: 1,
      schemas: [],
      operations: [{ path: '/missing', method: 'get', metadata: { disabled: true } }],
    });
    assert.throws(
      () => applyOwnedOverlay({ document: {}, entries, overlay: missing }),
      /Missing overlay operation/,
    );
  });
});

describe('loadOpenApi', () => {
  function spec(paths: JsonObject): JsonObject {
    return { openapi: '3.0.3', paths };
  }

  it('builds the tool list, skipping disabled operations', () => {
    const { tools } = loadOpenApi({
      source: spec({
        '/a': { get: op({ operationId: 'widgetsController_get_v1' }) },
        '/b': {
          get: op({ operationId: 'widgetsController_remove_v1', 'x-comp-mcp': { disabled: true } }),
        },
      }),
      overlay: { version: 1, schemas: [], operations: [] },
    });
    assert.deepEqual(tools.map((tool) => tool.path).sort(), ['/a']);
  });

  it('rejects two operations that resolve to the same explicit name', () => {
    assert.throws(
      () =>
        loadOpenApi({
          source: spec({
            '/a': { get: op({ 'x-comp-mcp': { name: 'dup' } }) },
            '/b': { get: op({ 'x-comp-mcp': { name: 'dup' } }) },
          }),
          overlay: { version: 1, schemas: [], operations: [] },
        }),
      /Duplicate MCP name: dup/,
    );
  });

  it('applies the overlay before deriving names, so a disabled operation never claims one', () => {
    const { tools } = loadOpenApi({
      source: spec({ '/a': { get: op({ operationId: 'widgetsController_get_v1' }) } }),
      overlay: {
        version: 1,
        schemas: [],
        operations: [{ path: '/a', method: 'get', metadata: { disabled: true } }],
      },
    });
    assert.deepEqual(tools, []);
  });
});

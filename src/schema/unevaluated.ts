import { z } from 'zod';
import { JsonObject, objectSchema } from '../openapi/metadata.js';
import type { CompileSchema } from './compiler.js';
import { withImpliedType } from './value.js';

type Evaluated = Set<string | number>;
type Evaluator = (instance: unknown) => Evaluated;

const subschemaSource = z.union([z.boolean(), objectSchema]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `unevaluatedProperties` and `unevaluatedItems` apply to whatever the adjacent keywords did not
 * evaluate, so each schema is walked again to find the keys and indexes that its applicators
 * (properties, items, allOf, passing anyOf/oneOf members, if/then/else, ...) covered.
 */
export function createUnevaluated({
  resolve,
  compile,
}: {
  resolve: (input: { ref: string; location: string }) => JsonObject;
  compile: CompileSchema;
}) {
  const byRef = new Map<string, Evaluator>();

  const compileMember = (source: unknown, location: string): z.ZodType => {
    const member = subschemaSource.parse(source);
    if (typeof member === 'boolean') return member ? z.unknown() : z.never();
    return compile({ source: member, location });
  };

  // Lazy, so a recursive schema is walked only as deep as the instance goes.
  const evaluatorForRef = (ref: string, location: string): Evaluator => {
    let evaluator = byRef.get(ref);
    if (evaluator === undefined) {
      let built: Evaluator | undefined;
      evaluator = (instance) => (built ??= build(resolve({ ref, location }), ref, true))(instance);
      byRef.set(ref, evaluator);
    }
    return evaluator;
  };

  function build(schema: JsonObject, location: string, nested: boolean): Evaluator {
    const parts: Evaluator[] = [];
    const ref = schema['$ref'];
    if (typeof ref === 'string') parts.push(evaluatorForRef(ref, location));

    const members = (key: 'allOf' | 'anyOf' | 'oneOf') =>
      schema[key] === undefined
        ? []
        : z
            .array(objectSchema)
            .parse(schema[key])
            .map((member, index) => {
              const at = `${location}/${key}/${index}`;
              return { valid: compileMember(member, at), evaluate: build(member, at, true) };
            });
    for (const { evaluate } of members('allOf')) parts.push(evaluate);
    for (const key of ['anyOf', 'oneOf'] as const) {
      for (const { valid, evaluate } of members(key)) {
        parts.push((instance) =>
          valid.safeParse(instance).success ? evaluate(instance) : new Set(),
        );
      }
    }

    if (schema['if'] !== undefined) {
      const condition = compileMember(schema['if'], `${location}/if`);
      const evaluateBranch = (key: 'if' | 'then' | 'else'): Evaluator | undefined => {
        const branch = schema[key];
        return isObject(branch) ? build(branch, `${location}/${key}`, true) : undefined;
      };
      const [ifEvaluator, thenEvaluator, elseEvaluator] = [
        evaluateBranch('if'),
        evaluateBranch('then'),
        evaluateBranch('else'),
      ];
      parts.push((instance) => {
        const evaluated: Evaluated = new Set();
        const used = condition.safeParse(instance).success
          ? [ifEvaluator, thenEvaluator]
          : [elseEvaluator];
        for (const evaluator of used)
          for (const item of evaluator?.(instance) ?? []) evaluated.add(item);
        return evaluated;
      });
    }

    if (schema['dependentSchemas'] !== undefined) {
      const parsed = z.record(z.string(), subschemaSource).parse(schema['dependentSchemas']);
      for (const [key, source] of Object.entries(parsed)) {
        if (typeof source === 'boolean') continue;
        const at = `${location}/dependentSchemas/${key}`;
        const typed = withImpliedType(source, 'object');
        const valid = compileMember(typed, at);
        const evaluate = build(typed, at, true);
        parts.push((instance) =>
          isObject(instance) && Object.hasOwn(instance, key) && valid.safeParse(instance).success
            ? evaluate(instance)
            : new Set(),
        );
      }
    }

    const properties = isObject(schema['properties']) ? Object.keys(schema['properties']) : [];
    const coversAllKeys =
      schema['additionalProperties'] !== undefined ||
      (nested && schema['unevaluatedProperties'] !== undefined);
    const coversAllItems =
      schema['items'] !== undefined || (nested && schema['unevaluatedItems'] !== undefined);
    const prefixLength = Array.isArray(schema['prefixItems']) ? schema['prefixItems'].length : 0;
    const contains =
      schema['contains'] === undefined
        ? undefined
        : compileMember(schema['contains'], `${location}/contains`);

    return (instance) => {
      const evaluated: Evaluated = new Set();
      if (Array.isArray(instance)) {
        instance.forEach((item, index) => {
          if (
            coversAllItems ||
            index < prefixLength ||
            (contains !== undefined && contains.safeParse(item).success)
          )
            evaluated.add(index);
        });
      } else if (isObject(instance)) {
        for (const key of Object.keys(instance)) {
          if (coversAllKeys || properties.includes(key)) evaluated.add(key);
        }
      }
      for (const part of parts) for (const item of part(instance)) evaluated.add(item);
      return evaluated;
    };
  }

  return function applyUnevaluated({
    schema,
    location,
    result,
  }: {
    schema: JsonObject;
    location: string;
    result: z.ZodType;
  }): z.ZodType {
    const propertiesSource = schema['unevaluatedProperties'];
    const itemsSource = schema['unevaluatedItems'];
    if (propertiesSource === undefined && itemsSource === undefined) return result;
    const evaluate = build(schema, location, false);
    let checked = result;
    if (propertiesSource !== undefined) {
      const member = compileMember(propertiesSource, `${location}/unevaluatedProperties`);
      checked = checked.refine(
        (value) => {
          if (!isObject(value)) return true;
          const evaluated = evaluate(value);
          return Object.entries(value).every(
            ([key, item]) => evaluated.has(key) || member.safeParse(item).success,
          );
        },
        { message: 'Object has unevaluated properties that do not satisfy unevaluatedProperties' },
      );
    }
    if (itemsSource !== undefined) {
      const member = compileMember(itemsSource, `${location}/unevaluatedItems`);
      checked = checked.refine(
        (value) => {
          if (!Array.isArray(value)) return true;
          const evaluated = evaluate(value);
          return value.every(
            (item, index) => evaluated.has(index) || member.safeParse(item).success,
          );
        },
        { message: 'Array has unevaluated items that do not satisfy unevaluatedItems' },
      );
    }
    return checked;
  };
}

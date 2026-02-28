/**
 * TypeBox schema → Zod schema converter for the Mastra tool adapter.
 *
 * Handles the common subset of TypeBox schemas used by OpenClaw tools.
 * Unsupported types fall back to z.unknown() with a warning.
 *
 * Note: per AGENTS.md tool schema guardrails, avoid Type.Union in tool input
 * schemas (no anyOf/oneOf/allOf). This converter handles z.union for the rare
 * cases where it appears, but tool authors should prefer flat schemas.
 */

import { z } from "zod";

type TSchemaLike = {
  type?: string;
  properties?: Record<string, TSchemaLike>;
  required?: string[];
  items?: TSchemaLike;
  anyOf?: TSchemaLike[];
  oneOf?: TSchemaLike[];
  enum?: unknown[];
  description?: string;
  // TypeBox-specific markers
  [key: string]: unknown;
};

/**
 * Convert a TypeBox TSchema to a Zod schema.
 * Supports: object, string, number, integer, boolean, array, union (anyOf/oneOf), enum.
 */
export function typeboxToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") {
    return z.unknown();
  }

  const s = schema as TSchemaLike;

  // Handle anyOf / oneOf as z.union
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    return convertUnion(s.anyOf);
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    return convertUnion(s.oneOf);
  }

  // Handle enum
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const values = s.enum as [string, ...string[]];
    return z.enum(values as [string, ...string[]]);
  }

  switch (s.type) {
    case "object":
      return convertObject(s);
    case "string":
      return applyDescription(z.string(), s.description);
    case "number":
    case "integer":
      return applyDescription(z.number(), s.description);
    case "boolean":
      return applyDescription(z.boolean(), s.description);
    case "array":
      return convertArray(s);
    case "null":
      return z.null();
    default:
      // Unknown type — fall back to z.unknown() so the tool still registers
      return z.unknown();
  }
}

function applyDescription<T extends z.ZodTypeAny>(schema: T, description?: string): T {
  if (description) {
    return schema.describe(description) as T;
  }
  return schema;
}

function convertObject(s: TSchemaLike): z.ZodTypeAny {
  const properties = s.properties ?? {};
  const required = new Set<string>(Array.isArray(s.required) ? s.required : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    const converted = typeboxToZod(propSchema);
    // Mark optional if not in required list
    shape[key] = required.has(key) ? converted : converted.optional();
  }

  const obj = z.object(shape);
  return applyDescription(obj, s.description);
}

function convertArray(s: TSchemaLike): z.ZodTypeAny {
  const itemSchema = s.items ? typeboxToZod(s.items) : z.unknown();
  return applyDescription(z.array(itemSchema), s.description);
}

function convertUnion(schemas: TSchemaLike[]): z.ZodTypeAny {
  if (schemas.length === 1) {
    return typeboxToZod(schemas[0]);
  }
  if (schemas.length === 2) {
    return z.union([typeboxToZod(schemas[0]), typeboxToZod(schemas[1])]);
  }
  // z.union requires at least 2 elements; for 3+ use discriminatedUnion or union
  const [first, second, ...rest] = schemas.map(typeboxToZod);
  return z.union([first, second, ...rest] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

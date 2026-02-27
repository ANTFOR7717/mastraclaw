/**
 * Converts TypeBox TSchema objects to Zod schemas.
 *
 * OpenClaw tools use TypeBox schemas (@sinclair/typebox).
 * Mastra tools use Zod schemas.
 *
 * This converter handles the common subset used by OpenClaw tools.
 * Unsupported schema types fall back to z.unknown().
 */

import { z } from "zod";

type TSchema = {
  type?: string;
  properties?: Record<string, TSchema>;
  required?: string[];
  items?: TSchema;
  anyOf?: TSchema[];
  oneOf?: TSchema[];
  allOf?: TSchema[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  // TypeBox-specific
  [Symbol.iterator]?: never;
};

/**
 * Convert a TypeBox TSchema to a Zod schema.
 * Handles the common subset used by OpenClaw tools.
 */
export function typeboxToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") {
    return z.unknown();
  }

  const s = schema as TSchema;

  // Handle anyOf / oneOf (union types)
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const members = s.anyOf.map((m) => typeboxToZod(m));
    if (members.length === 1) {
      return members[0];
    }
    if (members.length === 2) {
      return z.union([members[0], members[1]]);
    }
    return z.union([members[0], members[1], ...members.slice(2)] as [
      z.ZodTypeAny,
      z.ZodTypeAny,
      ...z.ZodTypeAny[],
    ]);
  }

  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    const members = s.oneOf.map((m) => typeboxToZod(m));
    if (members.length === 1) {
      return members[0];
    }
    if (members.length === 2) {
      return z.union([members[0], members[1]]);
    }
    return z.union([members[0], members[1], ...members.slice(2)] as [
      z.ZodTypeAny,
      z.ZodTypeAny,
      ...z.ZodTypeAny[],
    ]);
  }

  // Handle enum
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const stringEnums = s.enum.filter((v): v is string => typeof v === "string");
    if (stringEnums.length === s.enum.length && stringEnums.length >= 1) {
      return z.enum(stringEnums as [string, ...string[]]);
    }
    return z.unknown();
  }

  // Handle const
  if ("const" in s) {
    return z.literal(s.const as string | number | boolean);
  }

  switch (s.type) {
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      const required = new Set(Array.isArray(s.required) ? s.required : []);

      if (s.properties && typeof s.properties === "object") {
        for (const [key, propSchema] of Object.entries(s.properties)) {
          const zodProp = typeboxToZod(propSchema);
          shape[key] = required.has(key) ? zodProp : zodProp.optional();
        }
      }

      let obj = z.object(shape);
      if (s.description) {
        return obj.describe(s.description);
      }
      return obj;
    }

    case "array": {
      const itemSchema = s.items ? typeboxToZod(s.items) : z.unknown();
      let arr = z.array(itemSchema);
      if (s.description) {
        return arr.describe(s.description);
      }
      return arr;
    }

    case "string": {
      let str = z.string();
      if (typeof s.minLength === "number") {
        str = str.min(s.minLength);
      }
      if (typeof s.maxLength === "number") {
        str = str.max(s.maxLength);
      }
      if (typeof s.pattern === "string") {
        str = str.regex(new RegExp(s.pattern));
      }
      if (s.description) {
        return str.describe(s.description);
      }
      return str;
    }

    case "number":
    case "integer": {
      let num = s.type === "integer" ? z.number().int() : z.number();
      if (typeof s.minimum === "number") {
        num = num.min(s.minimum);
      }
      if (typeof s.maximum === "number") {
        num = num.max(s.maximum);
      }
      if (s.description) {
        return num.describe(s.description);
      }
      return num;
    }

    case "boolean": {
      const bool = z.boolean();
      if (s.description) {
        return bool.describe(s.description);
      }
      return bool;
    }

    case "null": {
      return z.null();
    }

    default:
      return z.unknown();
  }
}

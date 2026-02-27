import { describe, expect, it } from "vitest";
import { z } from "zod";
import { typeboxToZod } from "./typebox-to-zod.js";

describe("typeboxToZod", () => {
  it("converts string schema", () => {
    const schema = typeboxToZod({ type: "string" });
    expect(schema).toBeInstanceOf(z.ZodString);
    expect(schema.parse("hello")).toBe("hello");
  });

  it("converts number schema", () => {
    const schema = typeboxToZod({ type: "number" });
    expect(schema).toBeInstanceOf(z.ZodNumber);
    expect(schema.parse(42)).toBe(42);
  });

  it("converts integer schema", () => {
    const schema = typeboxToZod({ type: "integer" });
    expect(schema.parse(5)).toBe(5);
    expect(() => schema.parse(5.5)).toThrow();
  });

  it("converts boolean schema", () => {
    const schema = typeboxToZod({ type: "boolean" });
    expect(schema.parse(true)).toBe(true);
  });

  it("converts null schema", () => {
    const schema = typeboxToZod({ type: "null" });
    expect(schema.parse(null)).toBeNull();
  });

  it("converts object schema with required fields", () => {
    const schema = typeboxToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    const result = schema.parse({ name: "Alice", age: 30 });
    expect(result).toEqual({ name: "Alice", age: 30 });
    // age is optional
    expect(schema.parse({ name: "Bob" })).toEqual({ name: "Bob" });
    // name is required
    expect(() => schema.parse({ age: 30 })).toThrow();
  });

  it("converts array schema", () => {
    const schema = typeboxToZod({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => schema.parse([1, 2])).toThrow();
  });

  it("converts enum schema", () => {
    const schema = typeboxToZod({ enum: ["read", "write", "admin"] });
    expect(schema.parse("read")).toBe("read");
    expect(() => schema.parse("delete")).toThrow();
  });

  it("converts anyOf schema", () => {
    const schema = typeboxToZod({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(schema.parse("hello")).toBe("hello");
    expect(schema.parse(42)).toBe(42);
  });

  it("returns z.unknown() for unsupported types", () => {
    const schema = typeboxToZod({ type: "unsupported-type" });
    expect(schema).toBeInstanceOf(z.ZodUnknown);
  });

  it("returns z.unknown() for null/undefined input", () => {
    expect(typeboxToZod(null)).toBeInstanceOf(z.ZodUnknown);
    expect(typeboxToZod(undefined)).toBeInstanceOf(z.ZodUnknown);
  });

  it("handles string with constraints", () => {
    const schema = typeboxToZod({ type: "string", minLength: 2, maxLength: 10 });
    expect(schema.parse("hello")).toBe("hello");
    expect(() => schema.parse("a")).toThrow();
    expect(() => schema.parse("toolongstring")).toThrow();
  });

  it("handles nested objects", () => {
    const schema = typeboxToZod({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
      required: ["user"],
    });
    expect(schema.parse({ user: { name: "Alice" } })).toEqual({ user: { name: "Alice" } });
  });
});

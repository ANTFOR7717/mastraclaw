import { describe, expect, it } from "vitest";
import { toMastraProviderOptions } from "./model-config.js";

describe("toMastraProviderOptions", () => {
  it("returns undefined when thinkLevel is off", () => {
    expect(toMastraProviderOptions("off", "anthropic", "anthropic-messages")).toBeUndefined();
  });

  it("returns undefined when thinkLevel is undefined", () => {
    expect(toMastraProviderOptions(undefined, "anthropic", "anthropic-messages")).toBeUndefined();
  });

  it("returns Anthropic thinking options for anthropic-messages api", () => {
    const opts = toMastraProviderOptions("medium", "anthropic", "anthropic-messages");
    expect(opts).toMatchObject({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
    });
  });

  it("returns Anthropic thinking options for anthropic provider", () => {
    const opts = toMastraProviderOptions("high", "anthropic", "openai-completions");
    // provider name takes precedence for anthropic
    expect(opts).toMatchObject({
      anthropic: { thinking: { type: "enabled" } },
    });
  });

  it("returns OpenAI reasoning effort for openai-completions", () => {
    const opts = toMastraProviderOptions("high", "openai", "openai-completions");
    expect(opts).toMatchObject({
      openai: { reasoningEffort: "high" },
    });
  });

  it("returns OpenAI low effort for minimal thinkLevel", () => {
    const opts = toMastraProviderOptions("minimal", "openai", "openai-responses");
    expect(opts).toMatchObject({
      openai: { reasoningEffort: "low" },
    });
  });

  it("returns Google thinking config for google-generative-ai", () => {
    const opts = toMastraProviderOptions("medium", "google", "google-generative-ai");
    expect(opts).toMatchObject({
      google: { thinkingConfig: { thinkingBudget: 4096 } },
    });
  });

  it("returns undefined for unknown provider with non-thinking api", () => {
    const opts = toMastraProviderOptions("medium", "unknown-provider", "ollama");
    expect(opts).toBeUndefined();
  });
});

/**
 * Model config adapter: OpenClaw ModelApi + provider config → Mastra MastraModelConfig.
 *
 * Uses OpenAICompatibleConfig for all OpenAI-compatible providers (Anthropic, OpenAI,
 * Ollama, GitHub Copilot, OpenRouter, etc.) to avoid needing separate @ai-sdk/* packages.
 *
 * For providers that require native SDK support (Google OAuth, Bedrock SigV4), the
 * caller should pass a LanguageModelV1 instance directly — this is a Phase 2 concern.
 */

/** Subset of ModelApi values from src/config/types.models.ts */
type ModelApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "google-generative-ai"
  | "bedrock-converse-stream"
  | "ollama"
  | "github-copilot"
  | string;

/**
 * OpenAI-compatible config shape accepted by Mastra's createOpenAICompatible.
 * Matches the OpenAICompatibleConfig interface from @mastra/core/llm.
 */
export type MastraOpenAICompatibleConfig = {
  id: string;
  url?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

/**
 * Convert OpenClaw provider + model info to a Mastra-compatible model config.
 *
 * Returns an OpenAICompatibleConfig object that Mastra's Agent constructor accepts
 * as the `model` parameter. This works for all OpenAI-compatible providers.
 */
export function toMastraModelConfig(params: {
  provider: string;
  modelId: string;
  modelApi?: ModelApi | null;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): MastraOpenAICompatibleConfig {
  return {
    id: `${params.provider}/${params.modelId}`,
    url: resolveProviderBaseUrl(params.modelApi, params.baseUrl),
    apiKey: params.apiKey,
    headers: params.headers,
  };
}

/**
 * Resolve the base URL for a provider's API endpoint.
 * Custom baseUrl from model config takes precedence over defaults.
 */
function resolveProviderBaseUrl(api?: ModelApi | null, customBaseUrl?: string): string | undefined {
  if (customBaseUrl && customBaseUrl.trim()) {
    return customBaseUrl.trim();
  }
  switch (api) {
    case "anthropic-messages":
      return "https://api.anthropic.com/v1";
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
      return "https://api.openai.com/v1";
    case "google-generative-ai":
      // Google requires native @ai-sdk/google for OAuth; OpenAI-compat works for API key auth
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "bedrock-converse-stream":
      // Bedrock requires AWS SigV4 — native @ai-sdk/amazon-bedrock needed for Phase 2
      return undefined;
    case "ollama":
      return "http://localhost:11434/v1";
    case "github-copilot":
      return "https://api.githubcopilot.com";
    default:
      return undefined;
  }
}

/**
 * Map OpenClaw ThinkLevel to Mastra providerOptions for reasoning-capable models.
 *
 * Returns the providerOptions object to pass to agent.stream(messages, { providerOptions }).
 */
export function toMastraProviderOptions(
  thinkLevel: string | undefined,
  provider: string,
): Record<string, unknown> | undefined {
  if (!thinkLevel || thinkLevel === "off") {
    return undefined;
  }

  // Anthropic extended thinking
  if (provider === "anthropic" || provider.startsWith("anthropic")) {
    const budgetMap: Record<string, number> = {
      minimal: 1_024,
      low: 2_048,
      medium: 8_000,
      high: 16_000,
      xhigh: 32_000,
    };
    const budgetTokens = budgetMap[thinkLevel] ?? 8_000;
    return {
      anthropic: {
        thinking: { type: "enabled", budgetTokens },
      },
    };
  }

  // OpenAI reasoning effort
  if (provider === "openai" || provider.startsWith("openai")) {
    const effortMap: Record<string, string> = {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    };
    return {
      openai: {
        reasoningEffort: effortMap[thinkLevel] ?? "medium",
      },
    };
  }

  return undefined;
}

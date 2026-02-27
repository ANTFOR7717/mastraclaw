/**
 * Maps OpenClaw's ModelProviderConfig + ModelApi to Mastra's MastraModelConfig.
 *
 * Mastra's MastraModelConfig accepts:
 *   - OpenAICompatibleConfig: { id: "provider/model", url, apiKey, headers }
 *   - LanguageModelV1 (from @ai-sdk/*) for providers needing native auth
 *
 * Strategy:
 *   - Most providers (Anthropic, OpenAI, Ollama, GitHub Copilot, OpenRouter, etc.)
 *     use OpenAICompatibleConfig — Mastra's createOpenAICompatible sets
 *     Authorization: Bearer <apiKey> automatically.
 *   - Google Generative AI uses @ai-sdk/google (native OAuth/API key auth).
 *   - AWS Bedrock uses @ai-sdk/amazon-bedrock (AWS SigV4 auth).
 */

import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ModelApi } from "../../config/types.models.js";

export type MastraModelConfig =
  | { id: `${string}/${string}`; url?: string; apiKey?: string; headers?: Record<string, string> }
  | object; // LanguageModelV1 for Google/Bedrock

/**
 * Resolve the base URL for a given ModelApi type.
 * Returns undefined for providers that use their own SDK (Google, Bedrock).
 */
function resolveDefaultBaseUrl(api: ModelApi): string | undefined {
  switch (api) {
    case "anthropic-messages":
      return "https://api.anthropic.com/v1";
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
      return "https://api.openai.com/v1";
    case "google-generative-ai":
      // Google uses native @ai-sdk/google — no base URL needed here
      return undefined;
    case "bedrock-converse-stream":
      // Bedrock uses native @ai-sdk/amazon-bedrock — no base URL needed here
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
 * Build a Mastra MastraModelConfig from OpenClaw provider parameters.
 *
 * For Google and Bedrock, returns a LanguageModelV1 instance from the
 * respective @ai-sdk/* package. For all other providers, returns an
 * OpenAICompatibleConfig.
 */
export async function toMastraModelConfig(params: {
  provider: string;
  modelId: string;
  modelApi: ModelApi;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<MastraModelConfig> {
  const { provider, modelId, modelApi, baseUrl, apiKey, headers } = params;

  // Google Generative AI — use native @ai-sdk/google
  if (modelApi === "google-generative-ai") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({
      apiKey: apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
      baseURL: baseUrl,
    });
    return google(modelId);
  }

  // AWS Bedrock — use native @ai-sdk/amazon-bedrock
  if (modelApi === "bedrock-converse-stream") {
    const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
    const bedrock = createAmazonBedrock({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
    return bedrock(modelId);
  }

  // All other providers: use OpenAICompatibleConfig
  // Mastra's createOpenAICompatible sets Authorization: Bearer <apiKey>
  const resolvedUrl = baseUrl ?? resolveDefaultBaseUrl(modelApi);
  const config: {
    id: `${string}/${string}`;
    url?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  } = {
    id: `${provider}/${modelId}`,
  };
  if (resolvedUrl) {
    config.url = resolvedUrl;
  }
  if (apiKey) {
    config.apiKey = apiKey;
  }
  if (headers && Object.keys(headers).length > 0) {
    config.headers = headers;
  }

  return config;
}

/**
 * Map OpenClaw's ThinkLevel to Mastra providerOptions for the given provider.
 * Returns undefined if no thinking options are needed.
 */
export function toMastraProviderOptions(
  thinkLevel: ThinkLevel | undefined,
  provider: string,
  modelApi: ModelApi,
): Record<string, unknown> | undefined {
  if (!thinkLevel || thinkLevel === "off") {
    return undefined;
  }

  const normalizedProvider = provider.toLowerCase();

  // Anthropic extended thinking
  if (modelApi === "anthropic-messages" || normalizedProvider === "anthropic") {
    const budgetTokens = thinkLevelToAnthropicBudget(thinkLevel);
    return {
      anthropic: {
        thinking: { type: "enabled", budgetTokens },
      },
    };
  }

  // OpenAI reasoning effort
  if (
    modelApi === "openai-completions" ||
    modelApi === "openai-responses" ||
    normalizedProvider === "openai"
  ) {
    return {
      openai: {
        reasoningEffort: thinkLevelToOpenAIEffort(thinkLevel),
      },
    };
  }

  // Google thinking budget
  if (modelApi === "google-generative-ai" || normalizedProvider.includes("google")) {
    const thinkingBudget = thinkLevelToGoogleBudget(thinkLevel);
    if (thinkingBudget !== undefined) {
      return {
        google: { thinkingConfig: { thinkingBudget } },
      };
    }
  }

  return undefined;
}

function thinkLevelToAnthropicBudget(level: ThinkLevel): number {
  switch (level) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8000;
    case "high":
      return 16000;
    case "xhigh":
      return 32000;
    default:
      return 8000;
  }
}

function thinkLevelToOpenAIEffort(level: ThinkLevel): "low" | "medium" | "high" {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
    default:
      return "medium";
  }
}

function thinkLevelToGoogleBudget(level: ThinkLevel): number | undefined {
  switch (level) {
    case "minimal":
      return 512;
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 8192;
    case "xhigh":
      return 16384;
    default:
      return undefined;
  }
}

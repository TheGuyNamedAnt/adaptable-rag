import type { ProviderRerankAdapter } from "./provider-rerank-adapter.js";
import {
  buildJsonRerankRequestBody,
  createJsonRerankAdapter,
  parseJsonRerankResponse,
  type JsonRerankPresetOptions
} from "./json-rerank-preset.js";

export type OpenAICompatibleRerankPresetOptions = JsonRerankPresetOptions;

export function createOpenAICompatibleRerankAdapter(
  options: OpenAICompatibleRerankPresetOptions
): ProviderRerankAdapter {
  return createJsonRerankAdapter(options);
}

export const buildOpenAICompatibleRerankRequestBody = buildJsonRerankRequestBody;

export const parseOpenAICompatibleRerankResponse = parseJsonRerankResponse;

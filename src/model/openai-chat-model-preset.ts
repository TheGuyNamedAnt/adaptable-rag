import type { ProviderModelAdapter } from "./provider-model-adapter.js";
import {
  buildJsonChatModelRequestBody,
  createJsonChatModelAdapter,
  parseJsonChatModelResponse,
  type JsonChatModelPresetOptions
} from "./json-chat-model-preset.js";

export type OpenAICompatibleChatModelPresetOptions = JsonChatModelPresetOptions;

export function createOpenAICompatibleChatModelAdapter(
  options: OpenAICompatibleChatModelPresetOptions
): ProviderModelAdapter {
  return createJsonChatModelAdapter(options);
}

export const buildOpenAICompatibleChatModelRequestBody = buildJsonChatModelRequestBody;

export const parseOpenAICompatibleChatModelResponse = parseJsonChatModelResponse;

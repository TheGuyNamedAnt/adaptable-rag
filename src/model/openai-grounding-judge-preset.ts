import type { ProviderGroundingJudgeAdapter } from "./provider-grounding-judge-adapter.js";
import {
  buildJsonGroundingJudgeRequestBody,
  createJsonGroundingJudgeAdapter,
  parseJsonGroundingJudgeResponse,
  type JsonGroundingJudgePresetOptions
} from "./json-grounding-judge-preset.js";

export type OpenAICompatibleGroundingJudgePresetOptions = JsonGroundingJudgePresetOptions;

export function createOpenAICompatibleGroundingJudgeAdapter(
  options: OpenAICompatibleGroundingJudgePresetOptions
): ProviderGroundingJudgeAdapter {
  return createJsonGroundingJudgeAdapter(options);
}

export const buildOpenAICompatibleGroundingJudgeRequestBody = buildJsonGroundingJudgeRequestBody;

export const parseOpenAICompatibleGroundingJudgeResponse = parseJsonGroundingJudgeResponse;

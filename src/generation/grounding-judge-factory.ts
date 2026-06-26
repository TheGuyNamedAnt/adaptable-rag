import {
  ModelBackedGroundingJudge,
  type GroundingJudge,
  type GroundingJudgeModelAdapter
} from "../answer/grounding-judge.js";

export interface ModelBackedGroundingJudgeFromAdapterOptions {
  readonly adapter: GroundingJudgeModelAdapter;
  readonly now?: () => string;
}

export function createModelBackedGroundingJudgeFromAdapter(
  options: ModelBackedGroundingJudgeFromAdapterOptions
): GroundingJudge {
  return new ModelBackedGroundingJudge({
    adapter: options.adapter,
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

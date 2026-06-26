import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type { EmbeddingRequest } from "./embedding-types.js";
import { ProviderEmbeddingAdapter } from "./provider-embedding-adapter.js";
import {
  parseIndexedEmbeddingResponse,
  type IndexedEmbeddingPresetOptions
} from "./indexed-embedding-preset.js";
import type { ProviderEmbeddingParsedResponse } from "./provider-embedding-adapter.js";

export interface OpenAICompatibleEmbeddingPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly dimensions: number;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly user?: string;
  readonly includeDimensionsInRequest?: boolean;
}

export function createOpenAICompatibleEmbeddingAdapter(
  options: OpenAICompatibleEmbeddingPresetOptions
): ProviderEmbeddingAdapter {
  return new ProviderEmbeddingAdapter({
    config: options.config,
    dimensions: options.dimensions,
    secrets: options.secrets,
    transport: options.transport,
    buildRequestBody: (request) =>
      buildOpenAICompatibleEmbeddingRequestBody(request, {
        modelName: options.config.modelName,
        ...(options.includeDimensionsInRequest === false ? {} : { dimensions: options.dimensions }),
        ...(options.user === undefined ? {} : { user: options.user })
      }),
    parseResponse: parseOpenAICompatibleEmbeddingResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function createOpenAICompatibleEmbeddingAdapterFromIndexedOptions(
  options: IndexedEmbeddingPresetOptions
): ProviderEmbeddingAdapter {
  return createOpenAICompatibleEmbeddingAdapter(options);
}

export function buildOpenAICompatibleEmbeddingRequestBody(
  request: EmbeddingRequest,
  options: {
    readonly modelName: string;
    readonly dimensions?: number;
    readonly user?: string;
  }
): Record<string, unknown> {
  return {
    model: options.modelName,
    input: request.inputs.map((input) => input.text),
    encoding_format: "float",
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
    ...(options.user === undefined ? {} : { user: options.user })
  };
}

export function parseOpenAICompatibleEmbeddingResponse(
  response: ProviderHttpResponse,
  request: EmbeddingRequest
): ProviderEmbeddingParsedResponse {
  return parseIndexedEmbeddingResponse(response, request);
}

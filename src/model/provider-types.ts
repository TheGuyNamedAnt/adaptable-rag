import type { ModelGenerateRequest, ModelTokenUsage } from "./model-types.js";
import type { SourcedAnswerDraft } from "../answer/answer-types.js";
import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderRequestHeadersBuilder,
  ProviderTransport
} from "../shared/provider-boundary.js";

export type {
  ProviderAdapterSecrets,
  ProviderAttemptTrace,
  ProviderBoundaryConfig,
  ProviderCallBoundaryTrace,
  ProviderErrorCode,
  ProviderHttpMethod,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderRequestHeadersBuilder,
  ProviderRequestHeadersInput,
  ProviderMappedError,
  ProviderPricing,
  ProviderRetryPolicy,
  ProviderTransport
} from "../shared/provider-boundary.js";

export interface ProviderParsedResponse {
  readonly draft: SourcedAnswerDraft;
  readonly usage?: ModelTokenUsage;
  readonly warnings?: readonly string[];
}

export interface ProviderModelAdapterOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly buildHeaders?: ProviderRequestHeadersBuilder;
  readonly buildRequestBody: (request: ModelGenerateRequest) => unknown;
  readonly parseResponse: (
    response: ProviderHttpResponse,
    request: ModelGenerateRequest
  ) => ProviderParsedResponse;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

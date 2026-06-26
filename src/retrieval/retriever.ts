import type { RetrievalRequest, RetrievalResult } from "./retrieval-types.js";
import type { ImplementedRetrievalMode } from "../shared/engine-capabilities.js";

export interface RetrieverCapabilities {
  readonly modes: readonly ImplementedRetrievalMode[];
  readonly supportsVectorSearch: boolean;
  readonly supportsHybridSearch: boolean;
  readonly supportsVisualSearch?: boolean;
  readonly supportsGraphSearch?: boolean;
}

export interface Retriever {
  readonly capabilities: RetrieverCapabilities;
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

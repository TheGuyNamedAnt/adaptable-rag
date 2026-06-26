import type { PostgresRagIndex } from "../indexing/postgres-index.js";
import { FtsKeywordRetriever } from "./fts-keyword-retriever.js";
import type { RetrievalRequest, RetrievalResult } from "./retrieval-types.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";

export interface PostgresFtsKeywordRetrieverOptions {
  readonly index: PostgresRagIndex;
  readonly now?: () => string;
}

export class PostgresFtsKeywordRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  private readonly delegate: FtsKeywordRetriever;

  constructor(options: PostgresFtsKeywordRetrieverOptions) {
    this.delegate = new FtsKeywordRetriever({
      index: options.index,
      fusionStrategy: "postgres_fts",
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    return this.delegate.retrieve(request);
  }
}

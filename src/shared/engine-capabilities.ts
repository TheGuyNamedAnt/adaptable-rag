export const RAG_ENGINE_CAPABILITIES = {
  retrievalModes: ["keyword", "vector", "hybrid", "visual"],
  rerankModes: ["none", "lightweight", "model"],
  indexStorageKinds: ["memory", "json_file"],
  supportsVectorRetrieval: true,
  supportsHybridRetrieval: true,
  supportsVisualRetrieval: true,
  supportsModelReranking: true,
  supportsModelGroundingJudge: true,
  supportsQueryPlanning: true,
  hybridFusionStrategies: ["reciprocal_rank_fusion", "score_normalization"]
} as const;

export type ImplementedRetrievalMode = (typeof RAG_ENGINE_CAPABILITIES.retrievalModes)[number];
export type ImplementedRerankMode = (typeof RAG_ENGINE_CAPABILITIES.rerankModes)[number];

export function isImplementedRetrievalMode(mode: string): mode is ImplementedRetrievalMode {
  return RAG_ENGINE_CAPABILITIES.retrievalModes.includes(mode as ImplementedRetrievalMode);
}

export function isImplementedRerankMode(mode: string): mode is ImplementedRerankMode {
  return RAG_ENGINE_CAPABILITIES.rerankModes.includes(mode as ImplementedRerankMode);
}

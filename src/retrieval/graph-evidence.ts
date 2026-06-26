export interface RetrievalGraphEntityReference {
  readonly id: string;
  readonly name: string;
}

export interface RetrievalGraphPathEdgeEvidence {
  readonly relationId: string;
  readonly relationType: string;
  readonly from: RetrievalGraphEntityReference;
  readonly to: RetrievalGraphEntityReference;
  readonly depth: number;
  readonly evidenceChunkIds: readonly string[];
}

export interface RetrievalGraphPathEvidence {
  readonly seed: RetrievalGraphEntityReference;
  readonly target: RetrievalGraphEntityReference;
  readonly depth: number;
  readonly edges: readonly RetrievalGraphPathEdgeEvidence[];
}

export function selectPreferredGraphEvidence(
  first: RetrievalGraphPathEvidence | undefined,
  second: RetrievalGraphPathEvidence | undefined
): RetrievalGraphPathEvidence | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  const depthDelta = second.depth - first.depth;
  if (depthDelta !== 0) {
    return depthDelta > 0 ? second : first;
  }

  const evidenceDelta = evidenceChunkCount(second) - evidenceChunkCount(first);
  if (evidenceDelta !== 0) {
    return evidenceDelta > 0 ? second : first;
  }

  const edgeDelta = second.edges.length - first.edges.length;
  if (edgeDelta !== 0) {
    return edgeDelta > 0 ? second : first;
  }

  return graphEvidenceKey(second).localeCompare(graphEvidenceKey(first)) < 0 ? second : first;
}

function evidenceChunkCount(evidence: RetrievalGraphPathEvidence): number {
  return new Set(evidence.edges.flatMap((edge) => edge.evidenceChunkIds)).size;
}

function graphEvidenceKey(evidence: RetrievalGraphPathEvidence): string {
  return evidence.edges
    .map((edge) => `${edge.depth}:${edge.relationId}:${edge.from.id}:${edge.to.id}`)
    .join("|");
}

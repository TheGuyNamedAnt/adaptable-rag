import type { ContextBlock } from "../context/context-types.js";
import type { RetrievalGraphPathEdgeEvidence } from "../retrieval/graph-evidence.js";
import type { RagEvalRelationshipPathExpectation } from "./eval-types.js";

export interface RelationshipClaimGroundingRequest {
  readonly contextBlocks: readonly Pick<ContextBlock, "chunkId" | "graphEvidence">[];
  readonly citedChunkIds: readonly string[];
  readonly expectedPaths: readonly RagEvalRelationshipPathExpectation[];
}

export interface RelationshipClaimGroundingResult {
  readonly passed: boolean;
  readonly matchedPathCount: number;
  readonly failures: readonly string[];
}

export function checkRelationshipClaimGrounding(
  request: RelationshipClaimGroundingRequest
): RelationshipClaimGroundingResult {
  const failures: string[] = [];

  if (request.expectedPaths.length === 0) {
    failures.push("relationship_claim_grounding requires expected relationship paths.");
  }

  const citedChunkIds = new Set(request.citedChunkIds);
  const citedPaths = request.contextBlocks.flatMap((block) =>
    citedChunkIds.has(block.chunkId) && block.graphEvidence ? [block.graphEvidence] : []
  );
  let matchedPathCount = 0;

  for (const [index, expectedPath] of request.expectedPaths.entries()) {
    if (expectedPath.edges.length === 0) {
      failures.push(`relationship_claim_grounding path ${index + 1} must declare edges.`);
      continue;
    }

    if (citedPaths.some((path) => pathMatchesExpectation(path, expectedPath))) {
      matchedPathCount += 1;
    } else {
      failures.push(
        `relationship_claim_grounding expected path ${index + 1} was not present in cited relationship evidence.`
      );
    }
  }

  return {
    passed: failures.length === 0,
    matchedPathCount,
    failures
  };
}

function pathMatchesExpectation(
  path: NonNullable<ContextBlock["graphEvidence"]>,
  expectedPath: RagEvalRelationshipPathExpectation
): boolean {
  if (expectedPath.depth !== undefined && path.depth !== expectedPath.depth) {
    return false;
  }

  if (expectedPath.ordered === true) {
    if (expectedPath.edges.length > path.edges.length) {
      return false;
    }

    return expectedPath.edges.every((expectedEdge, index) => {
      const actualEdge = path.edges[index];
      return (
        actualEdge !== undefined &&
        edgeMatchesExpectation(actualEdge, expectedEdge, expectedPath.requireEdgeEvidence === true)
      );
    });
  }

  const usedEdgeIndexes = new Set<number>();
  for (const expectedEdge of expectedPath.edges) {
    const edgeIndex = path.edges.findIndex(
      (actualEdge, index) =>
        !usedEdgeIndexes.has(index) &&
        edgeMatchesExpectation(actualEdge, expectedEdge, expectedPath.requireEdgeEvidence === true)
    );
    if (edgeIndex < 0) {
      return false;
    }
    usedEdgeIndexes.add(edgeIndex);
  }

  return true;
}

function edgeMatchesExpectation(
  actualEdge: RetrievalGraphPathEdgeEvidence,
  expectedEdge: RagEvalRelationshipPathExpectation["edges"][number],
  requireEdgeEvidence: boolean
): boolean {
  if (
    expectedEdge.relationType !== undefined &&
    normalize(actualEdge.relationType) !== normalize(expectedEdge.relationType)
  ) {
    return false;
  }

  if (expectedEdge.fromEntityId !== undefined && actualEdge.from.id !== expectedEdge.fromEntityId) {
    return false;
  }

  if (expectedEdge.toEntityId !== undefined && actualEdge.to.id !== expectedEdge.toEntityId) {
    return false;
  }

  if (
    expectedEdge.fromName !== undefined &&
    normalize(actualEdge.from.name) !== normalize(expectedEdge.fromName)
  ) {
    return false;
  }

  if (
    expectedEdge.toName !== undefined &&
    normalize(actualEdge.to.name) !== normalize(expectedEdge.toName)
  ) {
    return false;
  }

  return (
    !requireEdgeEvidence || actualEdge.evidenceChunkIds.some((chunkId) => chunkId.trim().length > 0)
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

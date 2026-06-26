import type { RagChunk } from "../documents/chunk.js";
import type { RagProfile } from "../profiles/profile.js";
import type { RetrievalCandidate } from "../retrieval/retrieval-types.js";
import type { ContextOptimizerTrace, ContextRejection } from "./context-types.js";

export interface ContextOptimizerResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly rejected: readonly ContextRejection[];
  readonly trace: ContextOptimizerTrace;
}

interface RankedCandidate {
  readonly candidate: RetrievalCandidate;
  readonly originalIndex: number;
  readonly optimizerScore: number;
}

const PRIMARY_SOURCE_KINDS = new Set(["local_file", "database_record", "saas_record"]);
const SECONDARY_SOURCE_KINDS = new Set([
  "api_response",
  "support_ticket",
  "chat_transcript",
  "web_page"
]);
const CONTRADICTION_TERMS = ["not", "never", "except", "unless", "deprecated", "superseded"];

export class ContextOptimizer {
  optimize(candidates: readonly RetrievalCandidate[], profile: RagProfile): ContextOptimizerResult {
    const rejected: ContextRejection[] = [];
    const citationDedupe = new CitationDedupe();
    const lexicalDedupe = new SemanticLexicalDedupe();
    const contradictionDetector = new ContradictionDetector();
    const ranked = candidates.map<RankedCandidate>((candidate, originalIndex) => ({
      candidate,
      originalIndex,
      optimizerScore: optimizerScore(candidate, profile)
    }));
    const ordered = ranked.sort(compareRankedCandidates);
    const kept: RetrievalCandidate[] = [];
    let citationDuplicateCount = 0;
    let lexicalDuplicateCount = 0;
    let secondarySourceDuplicateCount = 0;

    for (const entry of ordered) {
      const citationDuplicate = citationDedupe.rejectDuplicate(entry.candidate, kept);
      if (citationDuplicate) {
        citationDuplicateCount += 1;
        rejected.push(rejection(entry.candidate, "citation_duplicate", citationDuplicate));
        continue;
      }

      const lexicalDuplicate = lexicalDedupe.rejectDuplicate(entry.candidate, kept);
      if (lexicalDuplicate) {
        lexicalDuplicateCount += 1;
        rejected.push(rejection(entry.candidate, "lexical_duplicate", lexicalDuplicate));
        continue;
      }

      const secondaryDuplicate = rejectSecondaryDuplicate(entry.candidate, kept);
      if (secondaryDuplicate) {
        secondarySourceDuplicateCount += 1;
        rejected.push(rejection(entry.candidate, "secondary_source_duplicate", secondaryDuplicate));
        continue;
      }

      kept.push(entry.candidate);
    }

    const diverse = diversifyBySource(kept);
    const contradictionClusters = contradictionDetector.cluster(diverse);

    return {
      candidates: diverse,
      rejected,
      trace: {
        inputCandidateCount: candidates.length,
        outputCandidateCount: diverse.length,
        citationDuplicateCount,
        lexicalDuplicateCount,
        secondarySourceDuplicateCount,
        tableAwareCandidateCount: diverse.filter((candidate) => isTableAware(candidate.chunk))
          .length,
        contradictionClusterCount: contradictionClusters.length,
        sourceDiversityCount: new Set(
          diverse.map((candidate) => candidate.chunk.provenance.sourceId)
        ).size
      }
    };
  }
}

export class CitationDedupe {
  rejectDuplicate(
    candidate: RetrievalCandidate,
    kept: readonly RetrievalCandidate[]
  ): string | undefined {
    const key = citationKey(candidate);
    return kept.some(
      (existing) => existing.chunk.id !== candidate.chunk.id && citationKey(existing) === key
    )
      ? "Citation already appears in context candidate set."
      : undefined;
  }
}

export class SemanticLexicalDedupe {
  rejectDuplicate(
    candidate: RetrievalCandidate,
    kept: readonly RetrievalCandidate[]
  ): string | undefined {
    const signature = lexicalSignature(candidate.chunk.text);
    return kept.some(
      (existing) =>
        existing.chunk.id !== candidate.chunk.id &&
        jaccard(signature, lexicalSignature(existing.chunk.text)) >= 0.9
    )
      ? "Candidate text is lexically duplicative with stronger evidence."
      : undefined;
  }
}

export class EvidenceClusterer {
  clusterBySource(
    candidates: readonly RetrievalCandidate[]
  ): ReadonlyMap<string, readonly RetrievalCandidate[]> {
    const clusters = new Map<string, RetrievalCandidate[]>();
    for (const candidate of candidates) {
      const existing = clusters.get(candidate.chunk.provenance.sourceId) ?? [];
      existing.push(candidate);
      clusters.set(candidate.chunk.provenance.sourceId, existing);
    }
    return clusters;
  }
}

export class ContradictionDetector {
  cluster(candidates: readonly RetrievalCandidate[]): readonly (readonly RetrievalCandidate[])[] {
    const byDocument = new Map<string, RetrievalCandidate[]>();
    for (const candidate of candidates) {
      if (!looksContradictory(candidate.chunk.text)) {
        continue;
      }
      const existing = byDocument.get(candidate.chunk.documentId) ?? [];
      existing.push(candidate);
      byDocument.set(candidate.chunk.documentId, existing);
    }
    return [...byDocument.values()].filter((cluster) => cluster.length > 0);
  }
}

function optimizerScore(candidate: RetrievalCandidate, profile: RagProfile): number {
  return (
    candidate.score +
    (profile.contextBudget.preferTrustedSources ? trustScore(candidate.chunk) : 0) +
    (isPrimarySource(candidate.chunk) ? 0.2 : 0) +
    (isTableAware(candidate.chunk) ? 0.15 : 0) +
    (looksContradictory(candidate.chunk.text) ? 0.05 : 0)
  );
}

function compareRankedCandidates(first: RankedCandidate, second: RankedCandidate): number {
  const scoreDelta = second.optimizerScore - first.optimizerScore;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return first.originalIndex - second.originalIndex;
}

function rejectSecondaryDuplicate(
  candidate: RetrievalCandidate,
  kept: readonly RetrievalCandidate[]
): string | undefined {
  if (!isSecondarySource(candidate.chunk)) {
    return undefined;
  }
  const candidateSignature = lexicalSignature(candidate.chunk.text);
  const primaryDuplicate = kept.some(
    (existing) =>
      isPrimarySource(existing.chunk) &&
      jaccard(candidateSignature, lexicalSignature(existing.chunk.text)) >= 0.58
  );
  return primaryDuplicate
    ? "Secondary source duplicates stronger primary-source evidence."
    : undefined;
}

function diversifyBySource(
  candidates: readonly RetrievalCandidate[]
): readonly RetrievalCandidate[] {
  const bySource = new Map<string, RetrievalCandidate[]>();
  for (const candidate of candidates) {
    const sourceId = candidate.chunk.provenance.sourceId;
    const existing = bySource.get(sourceId) ?? [];
    existing.push(candidate);
    bySource.set(sourceId, existing);
  }

  const output: RetrievalCandidate[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const sourceCandidates of bySource.values()) {
      const next = sourceCandidates.shift();
      if (next) {
        output.push(next);
        added = true;
      }
    }
  }
  return output;
}

function citationKey(candidate: RetrievalCandidate): string {
  const citation = candidate.citation;
  return [
    citation.sourceId,
    citation.chunkId,
    citation.locator ?? "",
    citation.visualAssetId ?? ""
  ].join("|");
}

function lexicalSignature(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 3)
  );
}

function jaccard(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
  if (first.size === 0 && second.size === 0) {
    return 1;
  }
  const intersection = [...first].filter((item) => second.has(item)).length;
  const union = new Set([...first, ...second]).size;
  return union === 0 ? 0 : intersection / union;
}

function isPrimarySource(chunk: RagChunk): boolean {
  return PRIMARY_SOURCE_KINDS.has(chunk.provenance.sourceKind);
}

function isSecondarySource(chunk: RagChunk): boolean {
  return SECONDARY_SOURCE_KINDS.has(chunk.provenance.sourceKind);
}

function isTableAware(chunk: RagChunk): boolean {
  return (
    chunk.layoutRegionIds?.some((id) => id.toLowerCase().includes("table")) === true ||
    chunk.citation.visualAsset?.kind === "table_crop" ||
    chunk.metadata?.["layoutKind"] === "table" ||
    /\|.+\|/.test(chunk.text)
  );
}

function looksContradictory(text: string): boolean {
  const normalized = text.toLowerCase();
  return CONTRADICTION_TERMS.some((term) => normalized.includes(` ${term} `));
}

function trustScore(chunk: RagChunk): number {
  switch (chunk.provenance.trustTier) {
    case "trusted_internal":
      return 0.3;
    case "verified_partner":
      return 0.2;
    case "user_provided":
      return 0.05;
    default:
      return 0;
  }
}

function rejection(
  candidate: RetrievalCandidate,
  code: ContextRejection["code"],
  reason: string
): ContextRejection {
  return {
    code,
    reason,
    chunkId: candidate.chunk.id,
    documentId: candidate.chunk.documentId
  };
}

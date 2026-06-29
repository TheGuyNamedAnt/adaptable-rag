import type {
  AdminRejectedEvidenceItem,
  AdminRejectedEvidenceStage,
  AdminRejectedEvidenceSummary
} from "@/lib/answer-history-types";
import type { AdminAnswerResponse, TraceEvent } from "@/lib/rag-answer-types";

export function buildRejectedEvidenceFromAnswer(
  response: AdminAnswerResponse
): AdminRejectedEvidenceSummary {
  const items = rejectedEventItems(response.trace.events);
  const knownChunkIds = new Set(items.flatMap((item) => (item.chunkId ? [item.chunkId] : [])));
  const fallbackItems: readonly AdminRejectedEvidenceItem[] = response.trace.rejectedChunkIds
    .filter((chunkId) => !knownChunkIds.has(chunkId))
    .map((chunkId) => ({
      id: stableItemId("unknown", chunkId),
      stage: "unknown" as const,
      chunkId,
      message: "Chunk rejected; exact rejection stage was not present in the safe trace.",
      dataKeys: ["chunkId"]
    }));
  const allItems = [...items, ...fallbackItems];
  const rejectionCodes = uniqueStrings([
    ...allItems.flatMap((item) => (item.code === undefined ? [] : [item.code])),
    ...(response.context?.trace?.rejectionCodes ?? [])
  ]);

  return {
    totalRejectedChunkIds: response.trace.rejectedChunkIds.length,
    retrievalRejectedCount:
      response.retrieval?.trace?.rejectedCount ?? countStage(allItems, "retrieval"),
    contextRejectedCount: response.context?.trace?.rejectedCount ?? countStage(allItems, "context"),
    rejectionCodes,
    items: allItems
  };
}

function rejectedEventItems(events: readonly TraceEvent[]): readonly AdminRejectedEvidenceItem[] {
  return events
    .filter((event) => event.kind === "chunk_rejected")
    .map((event, index) => {
      const data = event.data ?? {};
      const stage = rejectedStage(data);
      const chunkId = stringValue(data.chunkId);
      const documentId = stringValue(data.documentId);
      const code = stringValue(data.code);
      return {
        id: stableItemId(stage, `${event.at}:${chunkId ?? "no_chunk"}:${code ?? index}`),
        stage,
        at: event.at,
        ...(chunkId === undefined ? {} : { chunkId }),
        ...(documentId === undefined ? {} : { documentId }),
        ...(code === undefined ? {} : { code }),
        message: event.message,
        dataKeys: Object.keys(data).sort()
      };
    });
}

function rejectedStage(data: Readonly<Record<string, unknown>>): AdminRejectedEvidenceStage {
  if (data.stage === "context" || typeof data.contextId === "string") return "context";
  if (data.stage === "retrieval" || typeof data.retrievalId === "string") return "retrieval";
  return "unknown";
}

function countStage(
  items: readonly AdminRejectedEvidenceItem[],
  stage: AdminRejectedEvidenceStage
): number {
  return items.filter((item) => item.stage === stage).length;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function stableItemId(stage: AdminRejectedEvidenceStage, value: string): string {
  let hash = 0x811c9dc5;
  const input = `${stage}:${value}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${stage}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

"use client";

import { EmptyState, MetricCard, SectionCard, StatusPill } from "@/components/ui";
import type {
  AdminRejectedEvidenceItem,
  AdminRejectedEvidenceSummary
} from "@/lib/answer-history-types";
import { formatNumber, formatTime, truncateMiddle } from "@/lib/format";

export function RejectedEvidencePanel({
  rejected,
  title = "Rejected Evidence",
  description = "Safe rejected chunk ids, rejection codes, and exact rejection stage when present in trace events."
}: {
  rejected: AdminRejectedEvidenceSummary;
  title?: string;
  description?: string;
}) {
  return (
    <div className="space-y-4">
      <SectionCard title={title} description={description}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard
            label="Trace rejected IDs"
            value={formatNumber(rejected.totalRejectedChunkIds)}
          />
          <MetricCard
            label="Retrieval rejected"
            value={formatNumber(rejected.retrievalRejectedCount)}
          />
          <MetricCard
            label="Context rejected"
            value={formatNumber(rejected.contextRejectedCount)}
          />
          <MetricCard label="Codes" value={formatNumber(rejected.rejectionCodes.length)} />
          <MetricCard label="Items" value={formatNumber(rejected.items.length)} />
        </div>
        {rejected.rejectionCodes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {rejected.rejectionCodes.map((code) => (
              <StatusPill key={code} label={code} tone="warning" />
            ))}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Rejected Items"
        description="No raw chunk text is stored here; operators get ids, stage, code, and safe event metadata."
      >
        {rejected.items.length === 0 ? (
          <EmptyState
            title="No rejected evidence recorded"
            detail="This run did not return rejected chunk ids or chunk_rejected trace events."
          />
        ) : (
          <div className="space-y-2">
            {rejected.items.map((item) => (
              <RejectedEvidenceRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function RejectedEvidenceRow({ item }: { item: AdminRejectedEvidenceItem }) {
  return (
    <div className="rounded-lg border border-card bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={item.stage} tone={item.stage === "unknown" ? "warning" : "primary"} />
          {item.code ? <StatusPill label={item.code} tone="warning" /> : null}
        </div>
        <span className="text-xs text-text-muted">{formatTime(item.at)}</span>
      </div>
      <div className="mt-2 text-sm text-text-secondary">{item.message}</div>
      <div className="mt-2 grid gap-1 text-xs text-text-muted sm:grid-cols-2">
        <div>Chunk: {item.chunkId ? truncateMiddle(item.chunkId, 56) : "n/a"}</div>
        <div>Document: {item.documentId ? truncateMiddle(item.documentId, 56) : "n/a"}</div>
      </div>
      <div className="mt-1 truncate text-xs text-text-muted">
        Data keys: {item.dataKeys.length === 0 ? "none" : item.dataKeys.join(", ")}
      </div>
    </div>
  );
}

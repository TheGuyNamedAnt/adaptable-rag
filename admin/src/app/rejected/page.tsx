import { Suspense } from "react";
import { FileSearch, SearchCheck } from "lucide-react";
import { TraceHistoryClient } from "@/components/TraceHistoryClient";
import { IconLink, PageGuide, PageHeader } from "@/components/ui";

export default function RejectedEvidencePage() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Inspect"
        title="Rejected Evidence"
        description="Inspect safe rejected chunk ids, rejection codes, and rejection stages from durable answer history."
        actions={
          <>
            <IconLink href="/traces" icon={SearchCheck} label="Trace" />
            <IconLink href="/citations" icon={FileSearch} label="Citations" />
          </>
        }
      />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        <PageGuide
          title="Use this when the answer missed or refused useful-looking evidence"
          description="Rejected Evidence shows why chunks were kept out of context. It helps separate real absence of knowledge from policy, trust, freshness, namespace, or citation filtering."
          steps={[
            "Select the failed or surprising answer run.",
            "Compare rejection codes and stages.",
            "Fix source policy or ingestion only after the rejection reason is clear."
          ]}
          tone="warning"
        />
        <Suspense fallback={<EvidenceFallback />}>
          <TraceHistoryClient mode="rejected" />
        </Suspense>
      </main>
    </div>
  );
}

function EvidenceFallback() {
  return (
    <div className="rounded-lg border border-card bg-card/40 p-4 text-sm text-text-muted">
      Loading evidence history
    </div>
  );
}

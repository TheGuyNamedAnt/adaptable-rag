import { Suspense } from "react";
import { FileSearch, SearchX } from "lucide-react";
import { TraceHistoryClient } from "@/components/TraceHistoryClient";
import { IconLink, PageGuide, PageHeader } from "@/components/ui";

export default function TracesPage() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Inspect"
        title="Evidence Explorer"
        description="Inspect durable answer traces, retrieval strategy, citations, and rejected evidence."
        actions={
          <>
            <IconLink href="/citations" icon={FileSearch} label="Citations" />
            <IconLink href="/rejected" icon={SearchX} label="Rejected" />
          </>
        }
      />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        <PageGuide
          title="Use this to debug an answer end to end"
          description="Start here after running Test Answer. Pick a stored run, then read the retrieval strategy, context counts, citations, and rejected evidence in one place."
          steps={[
            "Choose the newest relevant run.",
            "Check returned versus rejected evidence.",
            "Open citations or rejected evidence when you need a narrower view."
          ]}
        />
        <Suspense fallback={<EvidenceFallback />}>
          <TraceHistoryClient mode="trace" />
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

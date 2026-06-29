import { Suspense } from "react";
import { SearchCheck, SearchX } from "lucide-react";
import { TraceHistoryClient } from "@/components/TraceHistoryClient";
import { IconLink, PageGuide, PageHeader } from "@/components/ui";

export default function CitationsPage() {
  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Inspect"
        title="Citation Inspector"
        description="Inspect final citation pointers, source ids, chunk ids, and locators from durable answer history."
        actions={
          <>
            <IconLink href="/traces" icon={SearchCheck} label="Trace" />
            <IconLink href="/rejected" icon={SearchX} label="Rejected" />
          </>
        }
      />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        <PageGuide
          title="Use this to verify what supported the final answer"
          description="Citation Inspector narrows the answer history down to source ids, chunk ids, locators, and citation pointers. It is for checking provenance, not reading raw document bodies."
          steps={[
            "Select the answer run you care about.",
            "Confirm citations point to expected sources.",
            "Open the trace when citation count does not explain the result."
          ]}
        />
        <Suspense fallback={<EvidenceFallback />}>
          <TraceHistoryClient mode="citations" />
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

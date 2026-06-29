import { ArrowRight, ClipboardList } from "lucide-react";
import { AnswerLabClient, type AnswerLabReadiness } from "@/components/AnswerLabClient";
import { IconLink, PageGuide, PageHeader, PrerequisiteChecklist } from "@/components/ui";
import { getOverview, type OverviewResult } from "@/lib/rag-admin-api";

export default async function AnswerLabPage() {
  const overview = await getOverview();
  const readiness = answerReadinessFromOverview(overview);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Run"
        title="Test Answer"
        description="Ask a scoped question, inspect the answer, and follow the evidence trail."
        actions={
          <>
            <IconLink href="/ingestion" icon={ClipboardList} label="Add Knowledge" />
            <IconLink href="/traces" icon={ArrowRight} label="Evidence" />
          </>
        }
      />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">
        <PageGuide
          title={
            readiness.serviceReady && readiness.hasKnowledge
              ? "Use this to test one answer path at a time"
              : "Use this after knowledge exists"
          }
          description={
            readiness.serviceReady && readiness.hasKnowledge
              ? "Test Answer sends a scoped request through the same guarded answer path used by production. Keep the default scope for a quick smoke, then open advanced controls only when testing access or retrieval behavior."
              : "Question controls stay locked until the RAG service has indexed documents and chunks. Otherwise the page would invite a test that cannot retrieve evidence."
          }
          steps={
            readiness.serviceReady && readiness.hasKnowledge
              ? [
                  "Ask the question in user language.",
                  "Run with the default scope first.",
                  "Inspect evidence when the result surprises you."
                ]
              : [
                  "Load files or sync a connector.",
                  "Confirm documents and chunks exist.",
                  "Return here to run a scoped question."
                ]
          }
          tone={
            readiness.serviceReady && readiness.hasKnowledge
              ? "primary"
              : readiness.serviceReady
                ? "warning"
                : "error"
          }
        />
        <PrerequisiteChecklist
          title="Answer Flow Gate"
          description="Do not test answer quality until the live service and indexed knowledge both exist."
          items={[
            {
              label: "RAG service",
              status: readiness.serviceReady ? "ready" : "blocked",
              detail: readiness.serviceReady
                ? "The live answer endpoint is responding."
                : (readiness.error ??
                  "The answer endpoint is offline or not returning readiness data."),
              actionHref: readiness.serviceReady ? undefined : "/storage",
              actionLabel: readiness.serviceReady ? undefined : "Open Storage"
            },
            {
              label: "Indexed knowledge",
              status: readiness.hasKnowledge ? "ready" : "blocked",
              detail: readiness.hasKnowledge
                ? `${readiness.documentCount?.toLocaleString() ?? "n/a"} document(s) and ${readiness.chunkCount?.toLocaleString() ?? "n/a"} chunk(s) are available.`
                : "No documents or chunks are available for retrieval yet.",
              actionHref: readiness.hasKnowledge ? undefined : "/ingestion",
              actionLabel: readiness.hasKnowledge ? undefined : "Add Knowledge"
            },
            {
              label: "Profile scope",
              status: readiness.profileId && readiness.namespaceId ? "ready" : "warning",
              detail:
                readiness.profileId && readiness.namespaceId
                  ? `${readiness.profileId} / ${readiness.namespaceId}`
                  : "The answer form will fall back to local defaults until runtime profile health is available.",
              actionHref: readiness.profileId && readiness.namespaceId ? undefined : "/profiles",
              actionLabel: readiness.profileId && readiness.namespaceId ? undefined : "Open Profile"
            }
          ]}
        />
        <AnswerLabClient initialReadiness={readiness} />
      </main>
    </div>
  );
}

function answerReadinessFromOverview(overview: OverviewResult): AnswerLabReadiness {
  const serviceReady = overview.ready?.ready === true || overview.health?.status === "ready";
  const documentCount = overview.health?.index?.documentCount ?? 0;
  const chunkCount = overview.health?.index?.chunkCount ?? 0;
  return {
    serviceReady,
    hasKnowledge: serviceReady && documentCount > 0 && chunkCount > 0,
    profileId: overview.health?.profileId,
    namespaceId: overview.health?.namespaceId,
    documentCount,
    chunkCount,
    error: overview.errors.find((entry) => entry.trim())
  };
}

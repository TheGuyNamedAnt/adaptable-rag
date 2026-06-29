"use client";

import { useMemo, useState } from "react";
import { FileSearch, ListX, MessageSquareText, Route } from "lucide-react";
import { AnswerResultPanels } from "@/components/AnswerResultPanels";
import { RejectedEvidencePanel } from "@/components/RejectedEvidencePanel";
import { StatusPill } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import { buildRejectedEvidenceFromAnswer } from "@/lib/rejected-evidence";
import type { AdminAnswerResponse } from "@/lib/rag-answer-types";

type AnswerLabTab = "answer" | "trace" | "citations" | "rejected";

const tabs = [
  { id: "answer", label: "Answer", icon: MessageSquareText },
  { id: "trace", label: "Retrieval Trace", icon: Route },
  { id: "citations", label: "Citations", icon: FileSearch },
  { id: "rejected", label: "Rejected Evidence", icon: ListX }
] as const satisfies readonly {
  readonly id: AnswerLabTab;
  readonly label: string;
  readonly icon: typeof MessageSquareText;
}[];

export function AnswerLabResultTabs({ result }: { result: AdminAnswerResponse }) {
  const [activeTab, setActiveTab] = useState<AnswerLabTab>("answer");
  const rejected = useMemo(() => buildRejectedEvidenceFromAnswer(result), [result]);
  const counts: Record<AnswerLabTab, string> = {
    answer: result.status,
    trace: formatNumber(result.trace.events.length),
    citations: formatNumber(result.trace.finalCitations.length || result.citationChunkIds?.length),
    rejected: formatNumber(rejected.items.length)
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-card bg-surface p-2">
        <div className="grid gap-2 md:grid-cols-4">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                  selected
                    ? "border-primary/40 bg-primary/10 text-text-primary"
                    : "border-transparent text-text-secondary hover:border-primary/30 hover:bg-card"
                }`}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{tab.label}</span>
                </span>
                <StatusPill
                  label={counts[tab.id]}
                  tone={selected ? "primary" : tab.id === "rejected" ? "warning" : "default"}
                />
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === "answer" ? <AnswerResultPanels result={result} mode="answer" /> : null}
      {activeTab === "trace" ? <AnswerResultPanels result={result} mode="trace" /> : null}
      {activeTab === "citations" ? <AnswerResultPanels result={result} mode="citations" /> : null}
      {activeTab === "rejected" ? (
        <RejectedEvidencePanel
          rejected={rejected}
          description="Safe rejected chunk ids, rejection codes, and rejection stage for this current Test Answer run."
        />
      ) : null}
    </div>
  );
}

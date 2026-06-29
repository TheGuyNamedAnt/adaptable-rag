"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { ReviewWorkflowState } from "@/lib/review-workflow-types";

export function ReviewWorkflowHistoryActions({ state }: { readonly state: ReviewWorkflowState }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (state.status === "open") {
    return <span className="text-xs text-text-muted">Open</span>;
  }

  async function reopen() {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/rag/review/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: state.itemId,
          status: "open",
          owner: state.owner ?? "",
          note: state.note ?? "",
          updatedBy: "admin_ui"
        })
      });
      const result = (await response.json().catch(() => ({}))) as { readonly error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "Review workflow action failed.");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review workflow action failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={saving}
        onClick={() => void reopen()}
        className="inline-flex min-h-8 items-center gap-2 rounded-lg border border-card bg-background px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:border-primary/30 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        {saving ? "Saving" : "Reopen"}
      </button>
      {error ? <span className="max-w-40 text-xs leading-4 text-error">{error}</span> : null}
    </div>
  );
}

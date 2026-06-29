"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, CircleDot, Eye, XCircle, type LucideIcon } from "lucide-react";
import type { ReviewWorkflowState, ReviewWorkflowStatus } from "@/lib/review-workflow-types";

const ACTIONS: readonly {
  readonly status: ReviewWorkflowStatus;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tone: string;
}[] = [
  {
    status: "acknowledged",
    label: "Acknowledge",
    icon: CircleDot,
    tone: "border-primary/25 bg-primary/10 text-primary hover:border-primary/50"
  },
  {
    status: "in_review",
    label: "In review",
    icon: Eye,
    tone: "border-warning/30 bg-warning/10 text-warning hover:border-warning/60"
  },
  {
    status: "resolved",
    label: "Resolve",
    icon: CheckCircle2,
    tone: "border-success/30 bg-success/10 text-success hover:border-success/60"
  },
  {
    status: "dismissed",
    label: "Dismiss",
    icon: XCircle,
    tone: "border-card bg-card/40 text-text-secondary hover:border-error/30 hover:text-error"
  }
];

export function ReviewQueueActions({
  itemId,
  reviewStatus,
  workflow
}: {
  readonly itemId: string;
  readonly reviewStatus: ReviewWorkflowStatus;
  readonly workflow?: ReviewWorkflowState;
}) {
  const router = useRouter();
  const [owner, setOwner] = useState(workflow?.owner ?? "");
  const [note, setNote] = useState(workflow?.note ?? "");
  const [saving, setSaving] = useState<ReviewWorkflowStatus | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function save(status: ReviewWorkflowStatus) {
    setSaving(status);
    setMessage(undefined);
    setError(undefined);
    try {
      const response = await fetch("/api/rag/review/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId,
          status,
          owner,
          note,
          updatedBy: "admin_ui"
        })
      });
      const result = (await response.json().catch(() => ({}))) as { readonly error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "Review workflow action failed.");
      }
      setMessage(
        status === "resolved" || status === "dismissed" ? "Saved; hidden from open work." : "Saved."
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review workflow action failed.");
    } finally {
      setSaving(undefined);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-card bg-card/40 p-3">
      <div className="grid gap-2 md:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
        <label className="min-w-0">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
            Owner
          </span>
          <input
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            maxLength={120}
            className="h-9 w-full rounded-md border border-card bg-background px-2 text-sm text-text-primary outline-none focus:border-primary/50"
            placeholder="admin"
          />
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
            Operator note
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            rows={2}
            className="min-h-9 w-full resize-y rounded-md border border-card bg-background px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary/50"
            placeholder="Decision, ticket, or follow-up"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          const active = reviewStatus === action.status;
          return (
            <button
              key={action.status}
              type="button"
              disabled={saving !== undefined}
              onClick={() => void save(action.status)}
              className={`inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${action.tone} ${
                active ? "ring-1 ring-current/30" : ""
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {saving === action.status ? "Saving" : action.label}
            </button>
          );
        })}
        {message ? <span className="text-xs text-success">{message}</span> : null}
        {error ? <span className="text-xs text-error">{error}</span> : null}
      </div>
    </div>
  );
}

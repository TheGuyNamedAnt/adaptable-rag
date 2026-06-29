"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlayCircle } from "lucide-react";

export function ReviewSyncRunButton() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function runDryRunSync() {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/rag/review/sync", {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const result = (await response.json().catch(() => ({}))) as { readonly error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "Review sync failed.");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review sync failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={saving}
        onClick={() => void runDryRunSync()}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-text-primary bg-text-primary px-3 py-2 text-sm font-medium text-white hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <PlayCircle className="h-4 w-4" aria-hidden="true" />
        {saving ? "Running" : "Run dry-run sync"}
      </button>
      {error ? (
        <span className="max-w-72 text-right text-xs leading-4 text-error">{error}</span>
      ) : null}
    </div>
  );
}

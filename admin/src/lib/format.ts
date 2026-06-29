import type { Tone } from "@/components/ui";

export function statusTone(status: string | undefined): Tone {
  switch (status) {
    case "ready":
    case "completed":
    case "healthy":
    case "succeeded":
    case "passed":
    case "accepted":
      return "success";
    case "completed_with_warnings":
    case "warning":
    case "partial":
    case "skipped":
    case "draining":
    case "disabled":
    case "rejected":
      return "warning";
    case "failed":
    case "unavailable":
    case "not_ready":
    case "error":
      return "error";
    case "running":
    case "loading_source":
    case "normalizing":
    case "parsing":
    case "chunking":
    case "embedding":
    case "indexing":
    case "graph_extracting":
      return "primary";
    default:
      return "default";
  }
}

export function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "n/a";
}

export function formatDurationMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "n/a";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value / 60_000)} min`;
}

export function formatTime(value: string | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function truncateMiddle(value: string, maxLength = 42): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(6, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

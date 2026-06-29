export const REVIEW_WORKFLOW_STATUSES = [
  "open",
  "acknowledged",
  "in_review",
  "resolved",
  "dismissed"
] as const;

export type ReviewWorkflowStatus = (typeof REVIEW_WORKFLOW_STATUSES)[number];

export interface ReviewWorkflowState {
  readonly itemId: string;
  readonly status: ReviewWorkflowStatus;
  readonly owner?: string;
  readonly note?: string;
  readonly acknowledgedAt?: string;
  readonly acknowledgedBy?: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export function isReviewWorkflowStatus(value: unknown): value is ReviewWorkflowStatus {
  return (
    typeof value === "string" && REVIEW_WORKFLOW_STATUSES.includes(value as ReviewWorkflowStatus)
  );
}

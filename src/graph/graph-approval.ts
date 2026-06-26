import type { IndexFilter } from "../indexing/index-types.js";
import type {
  GraphEntityProposal,
  GraphProposalStatus,
  GraphRelationKind,
  GraphRelationProposal
} from "./graph-types.js";
import type { GraphApprovalDecisionLedger } from "./graph-approval-ledger.js";
import type { GraphStore } from "./in-memory-graph-store.js";

export type GraphApprovalDecisionStatus = "approved" | "rejected" | "needs_review";
export type GraphApprovalDecisionTarget = "entity" | "relation";

export interface GraphApprovalDecision {
  readonly id: string;
  readonly target: GraphApprovalDecisionTarget;
  readonly status: GraphApprovalDecisionStatus;
  readonly reason: string;
  readonly decidedAt: string;
  readonly confidence: number;
}

export interface GraphApprovalPolicy {
  decideEntity(entity: GraphEntityProposal): GraphApprovalDecisionStatus;
  decideRelation(relation: GraphRelationProposal): GraphApprovalDecisionStatus;
  explainEntity(entity: GraphEntityProposal, status: GraphApprovalDecisionStatus): string;
  explainRelation(relation: GraphRelationProposal, status: GraphApprovalDecisionStatus): string;
}

export interface ThresholdGraphApprovalPolicyOptions {
  readonly entityConfidenceThreshold?: number;
  readonly relationConfidenceThreshold?: number;
  readonly autoApproveRelationKinds?: readonly GraphRelationKind[];
  readonly rejectUnsupportedRelations?: boolean;
}

export interface GraphApprovalRunRequest {
  readonly filter: IndexFilter;
  readonly runId?: string;
  readonly requestedAt?: string;
}

export interface GraphApprovalRunResult {
  readonly runId: string;
  readonly decidedAt: string;
  readonly decisions: readonly GraphApprovalDecision[];
  readonly approvedCount: number;
  readonly rejectedCount: number;
  readonly needsReviewCount: number;
}

const DEFAULT_ENTITY_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_RELATION_CONFIDENCE_THRESHOLD = 0.85;
const DEFAULT_AUTO_APPROVE_RELATION_KINDS: readonly GraphRelationKind[] = [
  "registered_in",
  "formed_on",
  "member_of",
  "owns",
  "controls",
  "manages",
  "beneficiary_of",
  "trustee_of",
  "director_of",
  "signatory_of"
];

export class ThresholdGraphApprovalPolicy implements GraphApprovalPolicy {
  private readonly entityConfidenceThreshold: number;
  private readonly relationConfidenceThreshold: number;
  private readonly autoApproveRelationKinds: readonly GraphRelationKind[];
  private readonly rejectUnsupportedRelations: boolean;

  constructor(options: ThresholdGraphApprovalPolicyOptions = {}) {
    this.entityConfidenceThreshold =
      options.entityConfidenceThreshold ?? DEFAULT_ENTITY_CONFIDENCE_THRESHOLD;
    this.relationConfidenceThreshold =
      options.relationConfidenceThreshold ?? DEFAULT_RELATION_CONFIDENCE_THRESHOLD;
    this.autoApproveRelationKinds =
      options.autoApproveRelationKinds ?? DEFAULT_AUTO_APPROVE_RELATION_KINDS;
    this.rejectUnsupportedRelations = options.rejectUnsupportedRelations ?? true;
  }

  decideEntity(entity: GraphEntityProposal): GraphApprovalDecisionStatus {
    if (entity.status !== "proposed") {
      return toDecisionStatus(entity.status);
    }
    if (entity.evidence.length === 0) {
      return "rejected";
    }
    if (entity.confidence >= this.entityConfidenceThreshold) {
      return "approved";
    }
    return "needs_review";
  }

  decideRelation(relation: GraphRelationProposal): GraphApprovalDecisionStatus {
    if (relation.status !== "proposed") {
      return toDecisionStatus(relation.status);
    }
    if (relation.evidence.length === 0) {
      return "rejected";
    }
    if (
      this.rejectUnsupportedRelations &&
      (relation.verificationStatus === "unsupported" ||
        relation.verificationStatus === "contradicted")
    ) {
      return "rejected";
    }
    if (relation.verificationStatus === "ambiguous") {
      return "needs_review";
    }
    if (relation.factStrength !== "explicit_fact") {
      return "needs_review";
    }
    if (!this.autoApproveRelationKinds.includes(relation.relationKind)) {
      return "needs_review";
    }
    if (relation.confidence >= this.relationConfidenceThreshold) {
      return "approved";
    }
    return "needs_review";
  }

  explainEntity(entity: GraphEntityProposal, status: GraphApprovalDecisionStatus): string {
    if (status === "approved") {
      return `Entity confidence ${entity.confidence} met threshold ${this.entityConfidenceThreshold} with ${entity.evidence.length} evidence anchor(s).`;
    }
    if (status === "rejected") {
      return entity.evidence.length === 0
        ? "Entity was rejected because it has no evidence anchors."
        : `Entity retained existing rejected status with confidence ${entity.confidence}.`;
    }
    return `Entity confidence ${entity.confidence} did not meet threshold ${this.entityConfidenceThreshold}.`;
  }

  explainRelation(relation: GraphRelationProposal, status: GraphApprovalDecisionStatus): string {
    if (status === "approved") {
      return `Relation ${relation.relationKind} is explicit, confidence ${relation.confidence} met threshold ${this.relationConfidenceThreshold}, and has ${relation.evidence.length} evidence anchor(s).`;
    }
    if (status === "rejected") {
      if (relation.evidence.length === 0) {
        return "Relation was rejected because it has no evidence anchors.";
      }
      return `Relation verification status ${relation.verificationStatus} is not acceptable for auto-approval.`;
    }
    if (relation.factStrength !== "explicit_fact") {
      return `Relation fact strength ${relation.factStrength} requires review.`;
    }
    if (!this.autoApproveRelationKinds.includes(relation.relationKind)) {
      return `Relation kind ${relation.relationKind} is not in the auto-approval allowlist.`;
    }
    return `Relation confidence ${relation.confidence} did not meet threshold ${this.relationConfidenceThreshold}.`;
  }
}

export class GraphApprovalRunner {
  private readonly graphStore: GraphStore;
  private readonly policy: GraphApprovalPolicy;
  private readonly ledger: GraphApprovalDecisionLedger | undefined;
  private readonly now: () => string;

  constructor(options: {
    readonly graphStore: GraphStore;
    readonly policy?: GraphApprovalPolicy;
    readonly ledger?: GraphApprovalDecisionLedger;
    readonly now?: () => string;
  }) {
    this.graphStore = options.graphStore;
    this.policy = options.policy ?? new ThresholdGraphApprovalPolicy();
    this.ledger = options.ledger;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  approve(request: GraphApprovalRunRequest): GraphApprovalRunResult {
    const decidedAt = request.requestedAt ?? this.now();
    const runId = request.runId ?? `graph_approval_${decidedAt.replace(/[^0-9a-z]/gi, "")}`;
    const decisions: GraphApprovalDecision[] = [];
    const entities = this.graphStore.findEntities(request.filter);
    const relations = this.graphStore.findRelations({
      filter: request.filter,
      includeUnapproved: true,
      limit: request.filter.limit ?? 1000
    });

    for (const entity of entities) {
      if (entity.status !== "proposed") {
        continue;
      }
      const status = this.policy.decideEntity(entity);
      this.graphStore.updateEntityStatus(entity.id, status);
      decisions.push({
        id: entity.id,
        target: "entity",
        status,
        reason: this.policy.explainEntity(entity, status),
        decidedAt,
        confidence: entity.confidence
      });
    }

    for (const relation of relations) {
      if (relation.status !== "proposed") {
        continue;
      }
      const status = this.policy.decideRelation(relation);
      this.graphStore.updateRelationStatus(relation.id, status);
      decisions.push({
        id: relation.id,
        target: "relation",
        status,
        reason: this.policy.explainRelation(relation, status),
        decidedAt,
        confidence: relation.confidence
      });
    }

    const result = {
      runId,
      decidedAt,
      decisions,
      approvedCount: decisions.filter((decision) => decision.status === "approved").length,
      rejectedCount: decisions.filter((decision) => decision.status === "rejected").length,
      needsReviewCount: decisions.filter((decision) => decision.status === "needs_review").length
    };
    this.ledger?.record(result);
    return result;
  }
}

function toDecisionStatus(status: GraphProposalStatus): GraphApprovalDecisionStatus {
  if (status === "approved" || status === "verified") {
    return "approved";
  }
  if (status === "rejected" || status === "superseded") {
    return "rejected";
  }
  return "needs_review";
}

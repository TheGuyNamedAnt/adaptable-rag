import type { CitationPointer } from "../documents/provenance.js";
import type { TrustTier } from "../documents/trust-tier.js";
import type { AccessScope } from "../security/access-scope.js";

export type BuiltInGraphEntityKind =
  | "organization"
  | "legal_entity"
  | "person"
  | "asset"
  | "contract"
  | "account"
  | "document"
  | "location"
  | "metric"
  | "event"
  | "unknown";

export type GraphEntityKind = BuiltInGraphEntityKind | (string & {});

export const GRAPH_ENTITY_KINDS = [
  "organization",
  "legal_entity",
  "person",
  "asset",
  "contract",
  "account",
  "document",
  "location",
  "metric",
  "event",
  "unknown"
] as const satisfies readonly BuiltInGraphEntityKind[];

export type BuiltInGraphRelationKind =
  | "owns"
  | "controls"
  | "manages"
  | "beneficiary_of"
  | "trustee_of"
  | "director_of"
  | "signatory_of"
  | "guarantees"
  | "owes"
  | "member_of"
  | "registered_in"
  | "formed_on"
  | "expires_on"
  | "reports_metric"
  | "supplies"
  | "customer_of"
  | "partner_of"
  | "related_to";

export type GraphRelationKind = BuiltInGraphRelationKind | (string & {});

export const GRAPH_RELATION_KINDS = [
  "owns",
  "controls",
  "manages",
  "beneficiary_of",
  "trustee_of",
  "director_of",
  "signatory_of",
  "guarantees",
  "owes",
  "member_of",
  "registered_in",
  "formed_on",
  "expires_on",
  "reports_metric",
  "supplies",
  "customer_of",
  "partner_of",
  "related_to"
] as const satisfies readonly BuiltInGraphRelationKind[];

export type GraphFactStrength =
  | "explicit_fact"
  | "inferred_fact"
  | "co_mention"
  | "semantic_association";

export type GraphProposalStatus =
  | "proposed"
  | "verified"
  | "needs_review"
  | "rejected"
  | "approved"
  | "superseded";

export type GraphVerificationStatus =
  | "not_checked"
  | "supported"
  | "unsupported"
  | "ambiguous"
  | "contradicted";

export interface GraphOntology {
  readonly id: string;
  readonly entityKinds: readonly GraphEntityKind[];
  readonly relationKinds: readonly GraphRelationKind[];
  readonly requiredEvidenceForRelations: boolean;
  readonly allowInferredRelations: boolean;
}

export interface GraphEvidenceAnchor {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly citation: CitationPointer;
  readonly quoteHash?: string;
  readonly characterStart?: number;
  readonly characterEnd?: number;
}

export interface GraphTemporalValidity {
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly observedAt: string;
  readonly supersedesRelationIds?: readonly string[];
}

export interface GraphEntityProposal {
  readonly id: string;
  readonly namespaceId: string;
  readonly kind: GraphEntityKind;
  readonly name: string;
  readonly normalizedName: string;
  readonly aliases?: readonly string[];
  readonly confidence: number;
  readonly trustTier: TrustTier;
  readonly accessScope: AccessScope;
  readonly evidence: readonly GraphEvidenceAnchor[];
  readonly status: GraphProposalStatus;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface GraphRelationProposal {
  readonly id: string;
  readonly namespaceId: string;
  readonly relationKind: GraphRelationKind;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly factStrength: GraphFactStrength;
  readonly confidence: number;
  readonly trustTier: TrustTier;
  readonly accessScope: AccessScope;
  readonly evidence: readonly GraphEvidenceAnchor[];
  readonly temporal: GraphTemporalValidity;
  readonly verificationStatus: GraphVerificationStatus;
  readonly status: GraphProposalStatus;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface GraphExtractionBatch {
  readonly id: string;
  readonly namespaceId: string;
  readonly ontology: GraphOntology;
  readonly entities: readonly GraphEntityProposal[];
  readonly relations: readonly GraphRelationProposal[];
  readonly createdAt: string;
}

export function isGraphEntityKind(value: string): value is GraphEntityKind {
  return isCustomGraphKind(value);
}

export function isGraphRelationKind(value: string): value is GraphRelationKind {
  return isCustomGraphKind(value);
}

export function isBuiltInGraphEntityKind(value: string): value is BuiltInGraphEntityKind {
  return GRAPH_ENTITY_KINDS.some((kind) => kind === value);
}

export function isBuiltInGraphRelationKind(value: string): value is BuiltInGraphRelationKind {
  return GRAPH_RELATION_KINDS.some((kind) => kind === value);
}

function isCustomGraphKind(value: string): boolean {
  return /^[a-z][a-z0-9_:-]{0,63}$/u.test(value.trim());
}

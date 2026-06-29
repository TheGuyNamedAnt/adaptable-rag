import type { RagProfile } from "../profiles/profile.js";

export type PlannedQueryKind = "original" | "low_level" | "high_level" | "graph" | "hyde";

export type QueryPlannerStrategy = "default_heuristic" | "model_assisted" | "hyde_augmented";

export type QueryIntentKind =
  | "general"
  | "definition"
  | "troubleshooting"
  | "comparison"
  | "policy"
  | "relationship"
  | "freshness"
  | "table"
  | "visual"
  | "procedural";

export type QuerySourceHint =
  | "docs"
  | "support"
  | "tickets"
  | "incidents"
  | "tables"
  | "visuals"
  | "graph"
  | "recent";

export type GraphQueryRoute = "none" | "graph_optional" | "graph_required";
export type GraphQueryDirection = "any" | "outgoing" | "incoming";
export type GraphQueryExecutionMode = "expand" | "graph_first";
export type GraphQueryRelationKind =
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
  | "formed_on";

export interface GraphQueryIntent {
  readonly route: GraphQueryRoute;
  readonly relationKinds: readonly GraphQueryRelationKind[];
  readonly entityHints: readonly string[];
  readonly direction?: GraphQueryDirection;
  readonly executionMode?: GraphQueryExecutionMode;
  readonly reason: string;
}

export interface QueryIntent {
  readonly primary: QueryIntentKind;
  readonly secondary: readonly QueryIntentKind[];
  readonly sourceHints: readonly QuerySourceHint[];
  readonly confidence: number;
  readonly reason: string;
}

export interface PlannedQuery {
  readonly id: string;
  readonly query: string;
  readonly kind: PlannedQueryKind;
  readonly weight: number;
}

export interface QueryPlanTrace {
  readonly queryPlanId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly strategy: QueryPlannerStrategy;
  readonly originalQuestionHash: string;
  readonly plannedQueryHashes: readonly string[];
  readonly lowLevelKeywordHashes: readonly string[];
  readonly highLevelKeywordHashes: readonly string[];
  readonly primaryIntent: QueryIntentKind;
  readonly secondaryIntentHashes: readonly string[];
  readonly sourceHintHashes: readonly string[];
  readonly intentConfidence: number;
  readonly graphRoute: GraphQueryRoute;
  readonly graphDirection?: GraphQueryDirection;
  readonly graphExecutionMode?: GraphQueryExecutionMode;
  readonly graphRelationKindHashes: readonly string[];
  readonly graphEntityHintHashes: readonly string[];
  readonly queryCount: number;
  readonly rewriteEnabled: boolean;
  readonly parallelQueriesEnabled: boolean;
}

export interface QueryPlan {
  readonly originalQuestion: string;
  readonly intent: QueryIntent;
  readonly lowLevelKeywords: readonly string[];
  readonly highLevelKeywords: readonly string[];
  readonly graphIntent: GraphQueryIntent;
  readonly queries: readonly PlannedQuery[];
  readonly trace: QueryPlanTrace;
}

export interface QueryPlanRequest {
  readonly profile: RagProfile;
  readonly question: string;
  readonly queryPlanId?: string;
  readonly requestedAt?: string;
  readonly maxQueries?: number;
}

export interface QueryPlanner {
  plan(request: QueryPlanRequest): QueryPlan | Promise<QueryPlan>;
}

export interface QueryPlanningModelRequest {
  readonly requestId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly question: string;
  readonly maxQueries: number;
  readonly requestedAt?: string;
}

export interface QueryPlanningModelResult {
  readonly lowLevelKeywords?: readonly string[];
  readonly highLevelKeywords?: readonly string[];
  readonly plannedQueries?: readonly {
    readonly id?: string;
    readonly query: string;
    readonly kind: PlannedQueryKind;
    readonly weight?: number;
  }[];
  readonly warnings?: readonly string[];
}

export interface QueryPlanningModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  plan(request: QueryPlanningModelRequest): Promise<QueryPlanningModelResult>;
}

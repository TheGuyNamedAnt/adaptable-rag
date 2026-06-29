import type { DocumentLayout } from "../documents/layout.js";
import type { SourceKind } from "../documents/provenance.js";
import type { SourceSensitivity, TrustTier } from "../documents/trust-tier.js";
import type { AccessScope } from "../security/access-scope.js";

export type CorpusRecordMetadata = Readonly<Record<string, string | number | boolean>>;
export type CorpusRecordRejectionStage = "normalizing" | "chunking" | "indexing";

export interface CorpusRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly title: string;
  readonly body: string;
  readonly trustTier: TrustTier;
  readonly sensitivity: SourceSensitivity;
  readonly accessScope: AccessScope;
  readonly originUri?: string;
  readonly path?: string;
  readonly owner?: string;
  readonly capturedAt?: string;
  readonly checksum?: string;
  readonly layout?: DocumentLayout;
  readonly metadata?: CorpusRecordMetadata;
}

export interface RejectedCorpusRecord {
  readonly recordId: string;
  readonly sourceId: string;
  readonly rejectedStage: CorpusRecordRejectionStage;
  readonly reason: string;
}

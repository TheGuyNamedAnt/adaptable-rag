import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RequestPrincipal } from "../security/access-scope.js";

export type SourceSyncMode = "full" | "delta";

export interface SourceConnectorSyncRequest {
  readonly profile: ValidatedRagProfile;
  readonly source: CorpusSourceConfig;
  readonly requestedBy: RequestPrincipal;
  readonly runId: string;
  readonly requestedAt: string;
  readonly mode: SourceSyncMode;
  readonly previousCursor?: string;
}

export type SourceConnectorItem =
  | SourceConnectorUpsertItem
  | SourceConnectorDeleteItem
  | SourceConnectorErrorItem;

export interface SourceConnectorBaseItem {
  readonly sourceItemId: string;
  readonly version?: string;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface SourceConnectorUpsertItem extends SourceConnectorBaseItem {
  readonly operation: "upsert";
  readonly record: CorpusRecord;
  readonly contentHash?: string;
  readonly sourceAcl?: unknown;
}

export interface SourceConnectorDeleteItem extends SourceConnectorBaseItem {
  readonly operation: "delete";
  readonly recordId?: string;
  readonly deletedAt?: string;
}

export interface SourceConnectorErrorItem extends SourceConnectorBaseItem {
  readonly operation: "error";
  readonly recordId?: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface SourceConnectorWarning {
  readonly sourceId: string;
  readonly code: string;
  readonly message: string;
  readonly sourceItemId?: string;
}

export interface SourceConnectorSyncResult {
  readonly sourceId: string;
  readonly items: readonly SourceConnectorItem[];
  readonly warnings?: readonly SourceConnectorWarning[];
  readonly nextCursor?: string;
  readonly complete?: boolean;
}

export interface SourceConnector {
  readonly id: string;
  readonly description: string;
  sync(request: SourceConnectorSyncRequest): Promise<SourceConnectorSyncResult>;
}

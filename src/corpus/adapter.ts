import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type { CorpusRecord } from "./corpus-record.js";

export interface CorpusLoadRequest {
  readonly profile: ValidatedRagProfile;
  readonly source: CorpusSourceConfig;
  readonly requestedBy: RequestPrincipal;
  readonly runId: string;
  readonly requestedAt: string;
}

export interface CorpusAdapterWarning {
  readonly sourceId: string;
  readonly code: string;
  readonly message: string;
}

export interface CorpusLoadResult {
  readonly sourceId: string;
  readonly records: readonly (CorpusRecord | null | undefined)[];
  readonly warnings: readonly CorpusAdapterWarning[];
}

export interface CorpusAdapter {
  readonly id: string;
  readonly description: string;
  load(request: CorpusLoadRequest): Promise<CorpusLoadResult>;
}

import type { AccessScope } from "../security/access-scope.js";
import type { DocumentLayout } from "./layout.js";
import type { SourceProvenance } from "./provenance.js";

export interface RagDocument {
  readonly id: string;
  readonly namespaceId: string;
  readonly title: string;
  readonly body: string;
  readonly provenance: SourceProvenance;
  readonly accessScope: AccessScope;
  readonly layout?: DocumentLayout;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

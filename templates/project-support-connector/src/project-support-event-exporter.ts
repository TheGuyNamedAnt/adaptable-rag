import {
  createRagProjectSupportEventExporter,
  type RagProjectSupportConnectorSource,
  type RagSupportEventExporter
} from "adaptable-rag";

export interface ProjectSupportRecord {
  readonly ticketId: string;
  readonly updatedAt: string;
  readonly state: string;
  readonly artifactPath: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly knownIssueSignal?: boolean;
  readonly knownIssueStatus?: "candidate" | "confirmed" | "in_progress" | "fixed" | "verified";
  readonly safeSummary: string;
}

export interface ProjectSupportRecordPage {
  readonly records: readonly ProjectSupportRecord[];
  readonly cursor?: string;
}

export interface ProjectSupportRecordClient {
  listChangedSupportRecords(input: {
    readonly cursor?: string;
    readonly maxRecords?: number;
    readonly profileId?: string;
    readonly namespaceId?: string;
  }): Promise<ProjectSupportRecordPage>;
}

export interface ProjectSupportEventExporterOptions {
  readonly client: ProjectSupportRecordClient;
  readonly exporterId?: string;
  readonly defaultProfileId?: string;
  readonly defaultNamespaceId?: string;
}

export function createProjectSupportEventExporter(
  options: ProjectSupportEventExporterOptions
): RagSupportEventExporter {
  const source: RagProjectSupportConnectorSource<ProjectSupportRecord> = {
    id: "project_support_records",
    description: "Project-owned safe support record projection.",
    async loadRecords(request) {
      const page = await options.client.listChangedSupportRecords({
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.maxRecords === undefined ? {} : { maxRecords: request.maxRecords }),
        ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
        ...(request.namespaceId === undefined ? {} : { namespaceId: request.namespaceId })
      });

      return {
        records: page.records,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        metadata: {
          connector: "project-support-connector-template"
        }
      };
    }
  };

  return createRagProjectSupportEventExporter({
    exporterId: options.exporterId ?? "project_support_event_exporter",
    description: "Exports safe project support records into generic RAG support events.",
    source,
    metadata: {
      connector: "project-support-connector-template"
    },
    mapRecord: ({ record, request }) => {
      const profileId = request.profileId ?? record.profileId ?? options.defaultProfileId;
      const namespaceId = request.namespaceId ?? record.namespaceId ?? options.defaultNamespaceId;
      const knownIssueStatus = record.knownIssueStatus ?? "candidate";
      const isKnownIssueSignal =
        record.knownIssueSignal === true || knownIssueStatus !== "candidate";

      return {
        events: [
          {
            sourceSystem: "admin_support",
            sourceEventId: `${record.ticketId}:${record.state}:${record.updatedAt}`,
            sourceTicketId: record.ticketId,
            ...(profileId === undefined ? {} : { profileId }),
            ...(namespaceId === undefined ? {} : { namespaceId }),
            eventType:
              knownIssueStatus === "candidate"
                ? "known_issue_candidate_created"
                : "known_issue_status_changed",
            occurredAt: record.updatedAt,
            summary: record.safeSummary,
            evidenceRefs: [
              {
                refId: `ticket_${record.ticketId}`,
                kind: "ticket",
                sourceSystem: "admin_support",
                artifactPath: record.artifactPath,
                ticketId: record.ticketId,
                sensitivity: "internal_only",
                customerSafe: false
              }
            ],
            proposedKnowledgeAction: isKnownIssueSignal
              ? {
                  kind:
                    knownIssueStatus === "candidate"
                      ? "known_issue_candidate"
                      : "known_issue_status_update",
                  targetId: `known_issue_${record.ticketId}`,
                  knownIssueStatus,
                  title: "Project known issue update",
                  summary: "Review this support signal before promoting it to RAG knowledge.",
                  proposedWording:
                    "We know this problem exists and are working on the confirmed next step.",
                  requiresApproval: true,
                  approverDestination: "support_lead"
                }
              : {
                  kind: "none",
                  requiresApproval: false
                },
            metadata: {
              ticket_state: record.state,
              known_issue_signal: isKnownIssueSignal
            }
          }
        ]
      };
    }
  });
}

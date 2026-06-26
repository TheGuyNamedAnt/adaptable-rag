import type { GraphOntology } from "./graph-types.js";

export const ownershipGraphOntology: GraphOntology = {
  id: "ownership-v1",
  entityKinds: ["legal_entity", "organization", "person", "account", "contract", "document"],
  relationKinds: [
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
    "formed_on"
  ],
  requiredEvidenceForRelations: true,
  allowInferredRelations: false
};

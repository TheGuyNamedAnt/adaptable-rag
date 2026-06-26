import assert from "node:assert/strict";
import test from "node:test";

import type { ContextBuildRequest } from "../context/context-types.js";
import { breakawaySupportProfile } from "./examples/breakaway-support.profile.js";
import { genericDocsProfile } from "./examples/generic-docs.profile.js";
import { ultimateDefaultProfile } from "./presets/ultimate-default.profile.js";
import type { RagProfile } from "./profile.js";
import { PROFILE_FIELD_ENFORCEMENT, declarativeProfileFields } from "./profile-enforcement.js";
import { ProfileRegistry } from "./profile-registry.js";
import {
  assertValidProfile,
  validateProfile,
  type ProfileValidationCode,
  type ValidatedRagProfile
} from "./profile-validation.js";

// @ts-expect-error Runtime requests must receive a branded profile from assertValidProfile.
const _rawProfileMustNotSatisfyRuntimeProfile: ContextBuildRequest["profile"] = {} as RagProfile;
const _validatedProfileSatisfiesRuntimeProfile: ContextBuildRequest["profile"] =
  {} as ValidatedRagProfile;

function makeProfile(overrides: Partial<RagProfile> = {}): RagProfile {
  return {
    ...genericDocsProfile,
    id: "test-profile",
    namespaceId: "test-namespace",
    ...overrides,
    modelPolicy: {
      ...genericDocsProfile.modelPolicy,
      ...(overrides.modelPolicy ?? {})
    },
    retrieval: {
      ...genericDocsProfile.retrieval,
      ...(overrides.retrieval ?? {})
    },
    contextBudget: {
      ...genericDocsProfile.contextBudget,
      ...(overrides.contextBudget ?? {})
    },
    freshnessPolicy: {
      ...genericDocsProfile.freshnessPolicy,
      ...(overrides.freshnessPolicy ?? {})
    },
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      ...(overrides.trustPolicy ?? {})
    },
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      ...(overrides.citationPolicy ?? {})
    },
    refusalPolicy: {
      ...genericDocsProfile.refusalPolicy,
      ...(overrides.refusalPolicy ?? {})
    },
    redactionPolicy: {
      ...genericDocsProfile.redactionPolicy,
      ...(overrides.redactionPolicy ?? {})
    },
    outputContract: {
      ...genericDocsProfile.outputContract,
      ...(overrides.outputContract ?? {})
    },
    actionPolicy: {
      ...genericDocsProfile.actionPolicy,
      ...(overrides.actionPolicy ?? {})
    },
    costLatencyBudget: {
      ...genericDocsProfile.costLatencyBudget,
      ...(overrides.costLatencyBudget ?? {})
    },
    securityPolicy: {
      ...genericDocsProfile.securityPolicy,
      ...(overrides.securityPolicy ?? {})
    },
    observabilityPolicy: {
      ...genericDocsProfile.observabilityPolicy,
      ...(overrides.observabilityPolicy ?? {})
    },
    memoryPolicy: {
      ...genericDocsProfile.memoryPolicy,
      ...(overrides.memoryPolicy ?? {})
    },
    evals: {
      ...genericDocsProfile.evals,
      ...(overrides.evals ?? {})
    }
  };
}

function codes(profile: RagProfile): readonly ProfileValidationCode[] {
  return validateProfile(profile).issues.map((issue) => issue.code);
}

test("assertValidProfile returns a branded profile accepted by the registry", () => {
  const validated: ValidatedRagProfile = assertValidProfile(makeProfile());
  const registry = new ProfileRegistry([validated]);

  assert.equal(registry.getRequired(validated.id).id, validated.id);
});

test("breakaway support profile admits approved support knowledge artifacts", () => {
  const validated = assertValidProfile(breakawaySupportProfile);
  const source = validated.corpusSources.find(
    (entry) => entry.id === "approved_knowledge_breakaway-support"
  );

  assert.ok(source);
  assert.equal(source.adapter, "approved_knowledge_artifact");
  assert.equal(source.trustTierFloor, "generated_or_derived");
  assert.equal(validated.trustPolicy.allowedTrustTiers.includes("generated_or_derived"), true);
  assert.equal(
    validated.citationPolicy.allowedSourceKindsForCitations.includes("derived_summary"),
    true
  );
});

test("rejects unsupported retrieval capabilities", () => {
  assert.equal(
    validateProfile(makeProfile({ retrieval: { ...genericDocsProfile.retrieval, mode: "vector" } }))
      .valid,
    true
  );
  assert.equal(
    validateProfile(makeProfile({ retrieval: { ...genericDocsProfile.retrieval, mode: "hybrid" } }))
      .valid,
    true
  );
  assert.equal(
    validateProfile(makeProfile({ retrieval: { ...genericDocsProfile.retrieval, mode: "visual" } }))
      .valid,
    true
  );
  assert.equal(
    codes(
      makeProfile({
        retrieval: {
          ...genericDocsProfile.retrieval,
          mode: "semantic" as RagProfile["retrieval"]["mode"]
        }
      })
    ).includes("unsupported_retrieval_mode"),
    true
  );
});

test("rejects missing or duplicate corpus sources", () => {
  const source = genericDocsProfile.corpusSources[0];
  assert.ok(source);

  assert.equal(
    codes(makeProfile({ corpusSources: [{ ...source, enabled: false }] })).includes(
      "missing_enabled_corpus"
    ),
    true
  );
  assert.equal(
    codes(makeProfile({ corpusSources: [source, source] })).includes("duplicate_corpus_source"),
    true
  );
});

test("rejects unsafe model policy", () => {
  assert.equal(
    codes(
      makeProfile({
        modelPolicy: {
          ...genericDocsProfile.modelPolicy,
          requireEvidenceForGeneration: false
        }
      })
    ).includes("unsafe_model_policy"),
    true
  );
});

test("rejects unsafe context and freshness policies", () => {
  assert.equal(
    codes(
      makeProfile({
        contextBudget: {
          ...genericDocsProfile.contextBudget,
          isolateSourceDocuments: false
        }
      })
    ).includes("invalid_context_budget"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        freshnessPolicy: {
          ...genericDocsProfile.freshnessPolicy,
          mode: "versioned",
          requireCapturedAt: false
        }
      })
    ).includes("unsafe_freshness_policy"),
    true
  );
});

test("rejects unsafe citation and refusal policies", () => {
  assert.equal(
    codes(
      makeProfile({
        citationPolicy: {
          ...genericDocsProfile.citationPolicy,
          allowUncitedSummary: true
        }
      })
    ).includes("unsafe_citation_policy"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        refusalPolicy: {
          ...genericDocsProfile.refusalPolicy,
          refuseWhenNoEvidence: false
        }
      })
    ).includes("unsafe_refusal_policy"),
    true
  );
});

test("rejects unsafe trust and redaction policies", () => {
  assert.equal(
    codes(
      makeProfile({
        trustPolicy: {
          ...genericDocsProfile.trustPolicy,
          allowedTrustTiers: ["external_untrusted"],
          minimumAnswerTrustTier: "external_untrusted"
        }
      })
    ).includes("unsafe_trust_policy"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        redactionPolicy: {
          ...genericDocsProfile.redactionPolicy,
          piiClasses: ["email"]
        }
      })
    ).includes("unsafe_redaction_policy"),
    true
  );
});

test("rejects unsafe output and action policies", () => {
  assert.equal(
    codes(
      makeProfile({
        outputContract: {
          ...genericDocsProfile.outputContract,
          mode: "support_triage"
        }
      })
    ).includes("unsafe_output_contract"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        actionPolicy: {
          mode: "answer_only",
          allowedActions: ["create_ticket"],
          requireApprovalFor: []
        }
      })
    ).includes("unsafe_action_policy"),
    true
  );
});

test("rejects unsafe budgets, security, observability, memory, and evals", () => {
  assert.equal(
    codes(
      makeProfile({
        costLatencyBudget: {
          ...genericDocsProfile.costLatencyBudget,
          maxModelCalls: 0
        }
      })
    ).includes("invalid_cost_latency_budget"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        securityPolicy: {
          ...genericDocsProfile.securityPolicy,
          blockRawVectorAccess: false
        }
      })
    ).includes("unsafe_security_policy"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        observabilityPolicy: {
          ...genericDocsProfile.observabilityPolicy,
          redactTracePayloads: false
        }
      })
    ).includes("unsafe_observability_policy"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        memoryPolicy: {
          mode: "long_term",
          persistRetrievedFacts: false,
          requireHumanReviewForLongTermWrites: false
        }
      })
    ).includes("unsafe_memory_policy"),
    true
  );
  assert.equal(
    codes(
      makeProfile({
        evals: {
          ...genericDocsProfile.evals,
          requiredChecks: ["retrieval_recall"]
        }
      })
    ).includes("missing_eval_check"),
    true
  );
});

test("assertValidProfile throws with concrete paths for invalid profiles", () => {
  assert.throws(
    () =>
      assertValidProfile(
        makeProfile({
          citationPolicy: {
            ...genericDocsProfile.citationPolicy,
            requireCitations: false
          }
        })
      ),
    /citationPolicy\.requireCitations/
  );
});

test("profile enforcement matrix covers every concrete profile field", () => {
  const enforcementPaths = new Set(PROFILE_FIELD_ENFORCEMENT.map((entry) => entry.path));

  for (const profile of [genericDocsProfile, breakawaySupportProfile, ultimateDefaultProfile]) {
    for (const path of leafPaths(profile)) {
      assert.equal(
        enforcementPaths.has(path),
        true,
        `${profile.id} field "${path}" is missing from PROFILE_FIELD_ENFORCEMENT`
      );
    }
  }
});

test("declarative profile fields have explicit owners and reasons", () => {
  const declarative = declarativeProfileFields();

  assert.equal(declarative.length > 0, true);
  for (const entry of declarative) {
    assert.equal(entry.owner.trim().length > 0, true);
    assert.equal(entry.reason.trim().length > 0, true);
  }
});

function leafPaths(value: unknown, prefix = ""): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      isRecord(entry) ? leafPaths(entry, `${prefix}[]`) : [`${prefix}[]`]
    );
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry, prefix ? `${prefix}.${key}` : key)
    );
  }

  return [prefix];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

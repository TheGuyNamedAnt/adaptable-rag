import type { RagProfile } from "./profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "./profile-validation.js";

export class ProfileRegistry {
  private readonly profiles = new Map<string, ValidatedRagProfile>();

  constructor(profiles: readonly RagProfile[] = []) {
    for (const profile of profiles) {
      this.register(profile);
    }
  }

  register(profile: RagProfile): void {
    const validatedProfile = assertValidProfile(profile);

    if (this.profiles.has(validatedProfile.id)) {
      throw new Error(`Duplicate RAG profile id "${validatedProfile.id}".`);
    }

    this.profiles.set(validatedProfile.id, validatedProfile);
  }

  get(profileId: string): ValidatedRagProfile | undefined {
    return this.profiles.get(profileId);
  }

  getRequired(profileId: string): ValidatedRagProfile {
    const profile = this.get(profileId);
    if (!profile) {
      throw new Error(`RAG profile "${profileId}" is not registered.`);
    }
    return profile;
  }

  list(): readonly ValidatedRagProfile[] {
    return [...this.profiles.values()];
  }
}

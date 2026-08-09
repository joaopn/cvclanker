import { describe, expect, it } from "vitest";
import {
  buildSectionResetPayload,
  RESET_EXCLUDED_SECRETS,
  SECTION_FIELD_MAP,
} from "./SettingsPage";

describe("buildSectionResetPayload", () => {
  it("pipeline reset clears only pipeline fields", () => {
    const payload = buildSectionResetPayload("pipeline");
    expect(payload.scoringInstructions).toBeNull();
    expect(payload.enableJobScoring).toBeNull();
    expect(payload.tailoringConcurrency).toBeNull();
    expect("model" in payload).toBe(false);
    expect("llmApiKey" in payload).toBe(false);
    expect("chatStyleTone" in payload).toBe(false);
  });

  it("model reset never clears stored credentials", () => {
    const payload = buildSectionResetPayload("model");
    expect(payload.llmProvider).toBeNull();
    expect(payload.model).toBeNull();
    expect(payload.llmBaseUrl).toBeNull();
    expect("llmApiKey" in payload).toBe(false);
    expect("claudeCodeOauthToken" in payload).toBe(false);
  });

  it("environment reset keeps basic-auth credentials and the auth toggle", () => {
    const payload = buildSectionResetPayload("environment");
    expect(payload.jwtExpirySeconds).toBeNull();
    expect("basicAuthUser" in payload).toBe(false);
    expect("basicAuthPassword" in payload).toBe(false);
    expect("enableBasicAuth" in payload).toBe(false);
  });

  it("no section reset can touch onboarding-completion or profile-identity keys", () => {
    const sections = [
      "model",
      "chat",
      "context-limits",
      "environment",
      "user-profiles",
      "display",
      "pipeline",
      "prompts",
      "danger-zone",
    ] as const;
    for (const section of sections) {
      const payload = buildSectionResetPayload(section);
      expect("onboardingBasicAuthDecision" in payload).toBe(false);
      expect("cvSourceFormat" in payload).toBe(false);
      expect("defaultProfileId" in payload).toBe(false);
      expect("userProfileName" in payload).toBe(false);
    }
  });

  it("sections without settings fields produce an empty payload (button hidden)", () => {
    expect(buildSectionResetPayload("prompts")).toEqual({});
    expect(buildSectionResetPayload("user-profiles")).toEqual({});
    expect(buildSectionResetPayload("danger-zone")).toEqual({});
  });

  it("every mapped non-secret field is resettable (no silent exclusions)", () => {
    // Guards the NULL_SETTINGS_PAYLOAD membership check inside the builder:
    // a field added to a section map but forgotten there would silently drop
    // out of reset. enableBasicAuth is the one deliberate exception.
    for (const [section, fields] of Object.entries(SECTION_FIELD_MAP)) {
      const payload = buildSectionResetPayload(
        section as keyof typeof SECTION_FIELD_MAP,
      );
      for (const field of fields) {
        if (RESET_EXCLUDED_SECRETS.has(field)) continue;
        if (field === "enableBasicAuth") continue;
        expect(payload[field], `${section}.${field}`).toBeNull();
      }
    }
  });
});

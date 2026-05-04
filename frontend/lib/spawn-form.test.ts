import { describe, expect, it } from "vitest";
import {
  WIZARD_STEPS,
  initialWizardState,
  toSpawnPayload,
  validateBudget,
  validateCreds,
  validatePersona,
  validateStep,
  validateWantList,
  type WizardState,
} from "./spawn-form";

function freshKeypairBytes(): number[] {
  return Array.from({ length: 64 }, (_, i) => i);
}

describe("WIZARD_STEPS", () => {
  it("declares the canonical step ordering", () => {
    expect(WIZARD_STEPS).toEqual(["persona", "want_list", "budget", "creds", "review"]);
  });
});

describe("validatePersona", () => {
  it("requires a non-empty name", () => {
    const s = initialWizardState();
    expect(validatePersona(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "persona.name" }),
      ])
    );
    s.persona.name = "Alpha";
    expect(validatePersona(s)).toEqual([]);
  });

  it("rejects names longer than 64 chars", () => {
    const s = initialWizardState();
    s.persona.name = "x".repeat(65);
    expect(validatePersona(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "persona.name" }),
      ])
    );
  });

  it("rejects unknown risk profile", () => {
    const s = initialWizardState();
    s.persona.name = "Alpha";
    (s.persona.risk_appetite as any) = "yolo";
    expect(validatePersona(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "persona.risk_appetite" }),
      ])
    );
  });
});

describe("validateWantList", () => {
  it("requires at least one entry", () => {
    const s = initialWizardState();
    s.want_list = [];
    expect(validateWantList(s)[0]?.field).toBe("want_list");
  });

  it("flags rows with missing categories", () => {
    const s = initialWizardState();
    s.want_list = [{ category: "", min_grade: 9, max_value_usdc: 100 }];
    expect(validateWantList(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "want_list[0].category" }),
      ])
    );
  });

  it("flags out-of-range min_grade", () => {
    const s = initialWizardState();
    s.want_list = [
      { category: "X", min_grade: -1, max_value_usdc: 100 },
      { category: "Y", min_grade: 101, max_value_usdc: 100 },
    ];
    const errs = validateWantList(s);
    expect(errs.length).toBeGreaterThanOrEqual(2);
    expect(errs.find((e) => e.field === "want_list[0].min_grade")).toBeDefined();
    expect(errs.find((e) => e.field === "want_list[1].min_grade")).toBeDefined();
  });

  it("flags non-positive max_value_usdc", () => {
    const s = initialWizardState();
    s.want_list = [{ category: "X", min_grade: 9, max_value_usdc: 0 }];
    expect(validateWantList(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "want_list[0].max_value_usdc" }),
      ])
    );
  });

  it("caps the want-list at 32 entries", () => {
    const s = initialWizardState();
    s.want_list = Array.from({ length: 33 }, () => ({
      category: "X",
      min_grade: 9,
      max_value_usdc: 100,
    }));
    expect(validateWantList(s)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "want_list" })])
    );
  });

  it("accepts valid input", () => {
    const s = initialWizardState();
    s.want_list = [{ category: "Vintage Holo", min_grade: 9, max_value_usdc: 5000 }];
    expect(validateWantList(s)).toEqual([]);
  });
});

describe("validateBudget", () => {
  it("requires positive total budget", () => {
    const s = initialWizardState();
    s.budget.total_budget_usdc = 0;
    expect(validateBudget(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "budget.total_budget_usdc" }),
      ])
    );
  });

  it("flags total_budget below highest max_value_usdc", () => {
    const s = initialWizardState();
    s.want_list = [
      { category: "Vintage Holo", min_grade: 9, max_value_usdc: 5000 },
    ];
    s.budget.total_budget_usdc = 1000; // less than 5000
    const errs = validateBudget(s);
    expect(errs.find((e) => e.field === "budget.total_budget_usdc")).toBeDefined();
  });

  it("rejects implausible base58 publisher pubkey", () => {
    const s = initialWizardState();
    s.budget.total_budget_usdc = 5000;
    s.budget.trusted_publisher_pubkey = "shorty"; // too short
    expect(validateBudget(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "budget.trusted_publisher_pubkey",
        }),
      ])
    );
  });

  it("accepts a plausible base58 publisher pubkey", () => {
    const s = initialWizardState();
    s.budget.total_budget_usdc = 5000;
    // 44-char base58, real-looking.
    s.budget.trusted_publisher_pubkey =
      "EkUzw4yg4VFkm59NQfdsS2AKHJfKDHQcgR5x1nHeDKeF";
    expect(validateBudget(s).filter((e) => e.field.startsWith("budget.trusted"))).toEqual([]);
  });

  it("accepts an empty publisher pubkey (opt-out)", () => {
    const s = initialWizardState();
    s.budget.total_budget_usdc = 5000;
    s.budget.trusted_publisher_pubkey = "";
    expect(validateBudget(s).filter((e) => e.field.startsWith("budget.trusted"))).toEqual([]);
  });
});

describe("validateCreds", () => {
  it("requires non-empty LLM key", () => {
    const s = initialWizardState();
    expect(validateCreds(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "creds.llmApiKey" }),
      ])
    );
  });

  it("flags suspiciously short keys", () => {
    const s = initialWizardState();
    s.creds.llmApiKey = "short";
    expect(validateCreds(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "creds.llmApiKey" }),
      ])
    );
  });

  it("requires a 64-byte keypair", () => {
    const s = initialWizardState();
    s.creds.llmApiKey = "sk-fake-but-long-enough-key-1234567890";
    expect(validateCreds(s)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "creds.keypairBytes" }),
      ])
    );
    s.creds.keypairBytes = freshKeypairBytes();
    expect(validateCreds(s)).toEqual([]);
  });
});

describe("validateStep dispatch", () => {
  it("dispatches by current step value", () => {
    const s = initialWizardState();
    s.step = "persona";
    expect(validateStep(s).map((e) => e.field)).toContain("persona.name");

    s.step = "want_list";
    s.want_list = [];
    expect(validateStep(s).map((e) => e.field)).toContain("want_list");
  });

  it("review step runs all validators", () => {
    const s = initialWizardState();
    s.step = "review";
    const errs = validateStep(s);
    // Should include errors from persona AND creds at minimum.
    expect(errs.find((e) => e.field === "persona.name")).toBeDefined();
    expect(errs.find((e) => e.field === "creds.llmApiKey")).toBeDefined();
  });
});

describe("toSpawnPayload", () => {
  it("produces the wire payload the API expects", () => {
    const s = initialWizardState();
    s.persona.name = "  Alpha  ";
    s.persona.risk_appetite = "aggressive";
    s.want_list = [{ category: "  Vintage Holo  ", min_grade: 9, max_value_usdc: 5000 }];
    s.budget.total_budget_usdc = 8000;
    s.creds.llmApiKey = "sk-fake-key-very-long-yes-very-long";
    s.creds.keypairBytes = freshKeypairBytes();
    const payload = toSpawnPayload(s);
    expect(payload.config.name).toBe("Alpha");
    expect(payload.config.risk_appetite).toBe("aggressive");
    expect(payload.config.want_list[0].category).toBe("Vintage Holo");
    expect(payload.config.total_budget_usdc).toBe(8000);
    expect(payload.config).not.toHaveProperty("trusted_publisher_pubkey");
    expect(payload.secrets.llmApiKey).toBe("sk-fake-key-very-long-yes-very-long");
    expect(payload.secrets.keypairBytes).toEqual(freshKeypairBytes());
  });

  it("includes trusted_publisher_pubkey when set", () => {
    const s = initialWizardState();
    s.persona.name = "Alpha";
    s.budget.total_budget_usdc = 5000;
    s.budget.trusted_publisher_pubkey = "EkUzw4yg4VFkm59NQfdsS2AKHJfKDHQcgR5x1nHeDKeF";
    s.creds.llmApiKey = "sk-fake-key-very-long-yes-very-long";
    s.creds.keypairBytes = freshKeypairBytes();
    const payload = toSpawnPayload(s);
    expect(payload.config.trusted_publisher_pubkey).toBe(
      "EkUzw4yg4VFkm59NQfdsS2AKHJfKDHQcgR5x1nHeDKeF"
    );
  });
});

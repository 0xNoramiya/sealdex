// Pure form-state helpers for the /spawn wizard. Lives outside the
// page so the validators can be unit-tested without booting React.
//
// Mirrors the SpawnCreatePayload shape on the server side, with a
// few client-only fields (step index, generated/uploaded keypair
// metadata) that don't go over the wire.

export type RiskAppetite = "conservative" | "balanced" | "aggressive";

export interface WantListEntry {
  category: string;
  min_grade: number;
  max_value_usdc: number;
}

export type WizardStep = "persona" | "want_list" | "budget" | "creds" | "review";

export const WIZARD_STEPS: WizardStep[] = [
  "persona",
  "want_list",
  "budget",
  "creds",
  "review",
];

export interface WizardState {
  step: WizardStep;
  persona: { name: string; risk_appetite: RiskAppetite };
  want_list: WantListEntry[];
  budget: {
    total_budget_usdc: number;
    trusted_publisher_pubkey: string;
  };
  creds: {
    llmApiKey: string;
    /** "generate" | "upload" — drives UX, not the server payload. */
    keypairMode: "generate" | "upload";
    /** Generated/uploaded keypair as a 64-byte number array. */
    keypairBytes: number[] | null;
    /** base58 pubkey derived from the keypair (display only). */
    keypairPubkey: string;
    /** Used by the upload flow to surface parse errors. */
    keypairUploadError: string | null;
  };
}

export function initialWizardState(): WizardState {
  return {
    step: "persona",
    persona: { name: "", risk_appetite: "balanced" },
    want_list: [{ category: "", min_grade: 9, max_value_usdc: 1000 }],
    budget: { total_budget_usdc: 5000, trusted_publisher_pubkey: "" },
    creds: {
      llmApiKey: "",
      keypairMode: "generate",
      keypairBytes: null,
      keypairPubkey: "",
      keypairUploadError: null,
    },
  };
}

export type ValidationError = { field: string; message: string };

/** Returns an array of validation errors for the current step.
 *  Empty array = step is OK to advance. */
export function validateStep(state: WizardState): ValidationError[] {
  switch (state.step) {
    case "persona":
      return validatePersona(state);
    case "want_list":
      return validateWantList(state);
    case "budget":
      return validateBudget(state);
    case "creds":
      return validateCreds(state);
    case "review":
      return validateAll(state);
  }
}

export function validatePersona(state: WizardState): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!state.persona.name || state.persona.name.trim().length === 0) {
    errors.push({ field: "persona.name", message: "Name is required" });
  } else if (state.persona.name.length > 64) {
    errors.push({ field: "persona.name", message: "Name must be ≤ 64 chars" });
  }
  if (!["conservative", "balanced", "aggressive"].includes(state.persona.risk_appetite)) {
    errors.push({
      field: "persona.risk_appetite",
      message: "Pick a risk profile",
    });
  }
  return errors;
}

export function validateWantList(state: WizardState): ValidationError[] {
  const errors: ValidationError[] = [];
  if (state.want_list.length === 0) {
    errors.push({ field: "want_list", message: "At least one want-list entry is required" });
    return errors;
  }
  if (state.want_list.length > 32) {
    errors.push({
      field: "want_list",
      message: "Capped at 32 want-list entries",
    });
  }
  state.want_list.forEach((w, i) => {
    if (!w.category || w.category.trim().length === 0) {
      errors.push({
        field: `want_list[${i}].category`,
        message: `Row ${i + 1}: category required`,
      });
    }
    if (
      typeof w.min_grade !== "number" ||
      !Number.isFinite(w.min_grade) ||
      w.min_grade < 0 ||
      w.min_grade > 100
    ) {
      errors.push({
        field: `want_list[${i}].min_grade`,
        message: `Row ${i + 1}: min_grade must be 0-100`,
      });
    }
    if (
      typeof w.max_value_usdc !== "number" ||
      !Number.isFinite(w.max_value_usdc) ||
      w.max_value_usdc <= 0
    ) {
      errors.push({
        field: `want_list[${i}].max_value_usdc`,
        message: `Row ${i + 1}: max_value_usdc must be > 0`,
      });
    }
  });
  return errors;
}

export function validateBudget(state: WizardState): ValidationError[] {
  const errors: ValidationError[] = [];
  if (
    typeof state.budget.total_budget_usdc !== "number" ||
    !Number.isFinite(state.budget.total_budget_usdc) ||
    state.budget.total_budget_usdc <= 0
  ) {
    errors.push({
      field: "budget.total_budget_usdc",
      message: "Total budget must be > 0",
    });
  }
  // total_budget should cover at least one entry's max
  const maxOfMax = Math.max(
    0,
    ...state.want_list.map((w) => w.max_value_usdc || 0)
  );
  if (
    state.budget.total_budget_usdc > 0 &&
    state.budget.total_budget_usdc < maxOfMax
  ) {
    errors.push({
      field: "budget.total_budget_usdc",
      message: `Total budget below highest want-list max ($${maxOfMax})`,
    });
  }
  if (
    state.budget.trusted_publisher_pubkey &&
    state.budget.trusted_publisher_pubkey.trim() !== "" &&
    !isPlausibleBase58Pubkey(state.budget.trusted_publisher_pubkey)
  ) {
    errors.push({
      field: "budget.trusted_publisher_pubkey",
      message: "Pubkey doesn't look like a base58 32-byte address",
    });
  }
  return errors;
}

export function validateCreds(state: WizardState): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!state.creds.llmApiKey || state.creds.llmApiKey.trim().length === 0) {
    errors.push({ field: "creds.llmApiKey", message: "LLM API key is required" });
  } else if (state.creds.llmApiKey.length < 10) {
    errors.push({
      field: "creds.llmApiKey",
      message: "API key looks too short — sure you pasted the whole thing?",
    });
  }
  if (!Array.isArray(state.creds.keypairBytes) || state.creds.keypairBytes.length !== 64) {
    errors.push({
      field: "creds.keypairBytes",
      message: "Generate or upload a Solana keypair",
    });
  }
  return errors;
}

export function validateAll(state: WizardState): ValidationError[] {
  return [
    ...validatePersona(state),
    ...validateWantList(state),
    ...validateBudget(state),
    ...validateCreds(state),
  ];
}

/** Cheap heuristic for "this could be a base58 32-byte pubkey." Doesn't
 *  decode — that requires bs58 in the browser, and the wizard already
 *  loads enough deps. We just rule out obvious garbage. */
function isPlausibleBase58Pubkey(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 32 || trimmed.length > 48) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

/** Given the wizard state, build the JSON body /api/agents/spawn expects. */
export function toSpawnPayload(state: WizardState) {
  const cfg: any = {
    name: state.persona.name.trim(),
    want_list: state.want_list.map((w) => ({
      category: w.category.trim(),
      min_grade: w.min_grade,
      max_value_usdc: w.max_value_usdc,
    })),
    total_budget_usdc: state.budget.total_budget_usdc,
    risk_appetite: state.persona.risk_appetite,
  };
  const tp = state.budget.trusted_publisher_pubkey?.trim();
  if (tp) cfg.trusted_publisher_pubkey = tp;
  return {
    config: cfg,
    secrets: {
      llmApiKey: state.creds.llmApiKey,
      keypairBytes: state.creds.keypairBytes ?? [],
    },
  };
}

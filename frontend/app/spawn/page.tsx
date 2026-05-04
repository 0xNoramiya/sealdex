"use client";

// /spawn — multi-step BYOK wizard. Auth-gated entry; signed-out
// users see the connect prompt instead of the form. Posts to
// /api/agents/spawn on submit. The form-state shape + validators
// live in lib/spawn-form.ts so the unit tests don't have to boot
// the React tree.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Footer, TopBar } from "@/components/Chrome";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import { Keypair } from "@solana/web3.js";
import {
  LLM_PRESETS,
  WIZARD_STEPS,
  applyLLMPreset,
  initialWizardState,
  toSpawnPayload,
  validateAll,
  validateStep,
  type WizardState,
  type WizardStep,
} from "@/lib/spawn-form";

const STEP_TITLES: Record<WizardStep, string> = {
  persona: "Persona",
  want_list: "Want list",
  budget: "Budget",
  creds: "Creds",
  review: "Review",
};

const STEP_BLURBS: Record<WizardStep, string> = {
  persona: "Name your agent and pick how aggressive its bidding gets.",
  want_list: "Categories + minimum grades + ceilings the agent will hunt.",
  budget: "Total spend across all open bids. Optional trusted publisher key.",
  creds: "Pick an LLM provider, paste a key, and pair a Solana wallet. Both secrets encrypted at rest.",
  review: "Final check before the worker forks your bidder.",
};

interface AuthState {
  pubkey: string | null;
}

export default function SpawnPage() {
  const [state, setState] = useState<WizardState>(initialWizardState());
  const [auth, setAuth] = useState<AuthState>({ pubkey: null });
  const [authLoaded, setAuthLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{
    spawnId: string;
    slug: string;
    name: string;
  } | null>(null);

  // Probe auth on mount so the form gates correctly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) return;
        if (!r.ok) {
          setAuth({ pubkey: null });
        } else {
          const data = (await r.json()) as AuthState;
          setAuth(data);
        }
      } catch {
        if (!cancelled) setAuth({ pubkey: null });
      } finally {
        if (!cancelled) setAuthLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stepIdx = useMemo(() => WIZARD_STEPS.indexOf(state.step), [state.step]);
  const stepErrors = useMemo(() => validateStep(state), [state]);
  const allErrors = useMemo(() => validateAll(state), [state]);
  const canAdvance = stepErrors.length === 0;
  const canSubmit = allErrors.length === 0 && !submitting;

  const next = useCallback(() => {
    setState((s) => {
      const i = WIZARD_STEPS.indexOf(s.step);
      if (i >= WIZARD_STEPS.length - 1) return s;
      return { ...s, step: WIZARD_STEPS[i + 1] };
    });
  }, []);
  const prev = useCallback(() => {
    setState((s) => {
      const i = WIZARD_STEPS.indexOf(s.step);
      if (i <= 0) return s;
      return { ...s, step: WIZARD_STEPS[i - 1] };
    });
  }, []);

  const onSubmit = useCallback(async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/agents/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toSpawnPayload(state)),
      });
      const body = await r.json();
      if (!r.ok) {
        setSubmitError(
          (body as any)?.message ?? (body as any)?.error ?? `request failed: ${r.status}`
        );
        return;
      }
      setSubmitted({
        spawnId: (body as any).spawnId,
        slug: (body as any).slug,
        name: (body as any).name,
      });
    } catch (err) {
      setSubmitError((err as Error).message ?? "submit failed");
    } finally {
      setSubmitting(false);
    }
  }, [state]);

  return (
    <div className="min-h-screen flex flex-col paper-bg">
      <TopBar active="agents" />

      <main className="flex-1 max-w-[860px] mx-auto px-6 py-12 w-full">
        <header className="mb-8">
          <div className="text-[11px] uppercase tracking-[0.2em] text-dim ff-mono">
            Bring your own key
          </div>
          <h1 className="text-[32px] font-medium mt-1 text-ink">Spawn an agent</h1>
          <p className="text-[14px] text-dim mt-2 max-w-prose">
            Run a Sealdex bidder with your own Anthropic / OpenAI-compatible
            key, your own Solana wallet, and your own want-list. Your
            secrets are AES-GCM-encrypted at rest under a key derived from
            the server's session secret.
          </p>
        </header>

        {!authLoaded ? (
          <div className="text-[13px] text-dim">Loading…</div>
        ) : !auth.pubkey ? (
          <SignedOutGate />
        ) : submitted ? (
          <SubmittedView submitted={submitted} />
        ) : (
          <>
            <Stepper currentIdx={stepIdx} />

            <section
              data-testid="spawn-step"
              data-step={state.step}
              className="mt-8 p-6 border border-rule rounded-lg bg-paper"
            >
              <div className="text-[11px] uppercase tracking-[0.18em] text-dim ff-mono">
                Step {stepIdx + 1} of {WIZARD_STEPS.length} · {STEP_TITLES[state.step]}
              </div>
              <p className="text-[13px] text-dim mt-1">{STEP_BLURBS[state.step]}</p>
              <div className="mt-6">
                {state.step === "persona" && <PersonaStep state={state} setState={setState} />}
                {state.step === "want_list" && <WantListStep state={state} setState={setState} />}
                {state.step === "budget" && <BudgetStep state={state} setState={setState} />}
                {state.step === "creds" && <CredsStep state={state} setState={setState} />}
                {state.step === "review" && <ReviewStep state={state} />}
              </div>
              {stepErrors.length > 0 && (
                <ul
                  data-testid="step-errors"
                  className="mt-4 text-[12px] text-red-700 list-disc pl-4"
                >
                  {stepErrors.map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
              )}
              <div className="mt-6 flex items-center justify-between">
                <button
                  onClick={prev}
                  disabled={stepIdx === 0 || submitting}
                  className="text-[13px] px-4 py-2 border border-rule rounded hover:bg-rule2 disabled:opacity-30"
                >
                  Back
                </button>
                {state.step === "review" ? (
                  <button
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    data-testid="spawn-submit"
                    className="text-[13px] px-4 py-2 bg-ink text-paper rounded disabled:opacity-30"
                  >
                    {submitting ? "Spawning…" : "Spawn"}
                  </button>
                ) : (
                  <button
                    onClick={next}
                    disabled={!canAdvance || submitting}
                    className="text-[13px] px-4 py-2 bg-ink text-paper rounded disabled:opacity-30"
                  >
                    Next
                  </button>
                )}
              </div>
              {submitError && (
                <div
                  role="alert"
                  data-testid="submit-error"
                  className="mt-4 text-[12px] text-red-700"
                >
                  {submitError}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}

function Stepper({ currentIdx }: { currentIdx: number }) {
  return (
    <ol className="flex items-center gap-2 text-[12px] ff-mono">
      {WIZARD_STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={
              i < currentIdx
                ? "w-6 h-6 rounded-full bg-accent text-paper flex items-center justify-center"
                : i === currentIdx
                ? "w-6 h-6 rounded-full bg-ink text-paper flex items-center justify-center"
                : "w-6 h-6 rounded-full border border-rule text-dim flex items-center justify-center"
            }
          >
            {i + 1}
          </span>
          <span className={i === currentIdx ? "text-ink" : "text-dim"}>
            {STEP_TITLES[s]}
          </span>
          {i < WIZARD_STEPS.length - 1 && <span className="text-dim mx-1">→</span>}
        </li>
      ))}
    </ol>
  );
}

function SignedOutGate() {
  return (
    <section className="p-6 border border-rule rounded-lg bg-paper">
      <h2 className="text-[18px] font-medium text-ink">Connect your wallet</h2>
      <p className="text-[13px] text-dim mt-2">
        Spawning an agent ties it to your wallet pubkey. The list of agents
        you've spawned is owner-scoped — only the wallet that signed in
        can see / stop them.
      </p>
      <div className="mt-4">
        <WalletConnectButton />
      </div>
    </section>
  );
}

function SubmittedView({
  submitted,
}: {
  submitted: { spawnId: string; slug: string; name: string };
}) {
  return (
    <section
      data-testid="spawn-submitted"
      className="p-6 border border-accent bg-accentBg rounded-lg"
    >
      <div className="text-[11px] uppercase tracking-[0.18em] ff-mono text-accent2">
        Spawn registered
      </div>
      <h2 className="text-[20px] font-medium text-ink mt-1">{submitted.name}</h2>
      <dl className="mt-4 grid grid-cols-[8rem,1fr] gap-y-2 text-[13px]">
        <dt className="text-dim">Slug</dt>
        <dd className="text-ink ff-mono">{submitted.slug}</dd>
        <dt className="text-dim">Spawn id</dt>
        <dd className="text-ink ff-mono break-all">{submitted.spawnId}</dd>
      </dl>
      <p className="text-[12px] text-dim mt-4">
        The worker will fork your bidder within a few seconds. Manage your
        agents at{" "}
        <Link href="/spawn/me" className="underline text-ink">
          /spawn/me
        </Link>
        .
      </p>
    </section>
  );
}

/* -------- Step bodies -------- */

interface StepProps {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}

function PersonaStep({ state, setState }: StepProps) {
  return (
    <div className="grid gap-4">
      <Field label="Agent name">
        <input
          data-testid="field-name"
          value={state.persona.name}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              persona: { ...s.persona, name: e.target.value },
            }))
          }
          placeholder="My Vintage Holo Hunter"
          maxLength={64}
          className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper"
        />
      </Field>
      <Field label="Risk appetite">
        <div className="flex gap-2">
          {(["conservative", "balanced", "aggressive"] as const).map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`risk-${r}`}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  persona: { ...s.persona, risk_appetite: r },
                }))
              }
              className={
                state.persona.risk_appetite === r
                  ? "px-3 py-2 text-[12px] rounded bg-ink text-paper"
                  : "px-3 py-2 text-[12px] rounded border border-rule hover:bg-rule2"
              }
            >
              {r}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
}

function WantListStep({ state, setState }: StepProps) {
  const update = (
    i: number,
    patch: Partial<WizardState["want_list"][number]>
  ) =>
    setState((s) => ({
      ...s,
      want_list: s.want_list.map((w, j) => (i === j ? { ...w, ...patch } : w)),
    }));
  const add = () =>
    setState((s) => ({
      ...s,
      want_list: [
        ...s.want_list,
        { category: "", min_grade: 9, max_value_usdc: 1000 },
      ],
    }));
  const remove = (i: number) =>
    setState((s) => ({
      ...s,
      want_list: s.want_list.filter((_, j) => j !== i),
    }));

  return (
    <div className="grid gap-3">
      {state.want_list.map((w, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr,6rem,8rem,2rem] gap-2 items-end"
        >
          <Field label={i === 0 ? "Category" : ""}>
            <input
              data-testid={`wl-${i}-category`}
              value={w.category}
              onChange={(e) => update(i, { category: e.target.value })}
              placeholder="Vintage Holo"
              className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper"
            />
          </Field>
          <Field label={i === 0 ? "Min grade" : ""}>
            <input
              data-testid={`wl-${i}-grade`}
              type="number"
              min={0}
              max={100}
              value={w.min_grade}
              onChange={(e) => update(i, { min_grade: Number(e.target.value) })}
              className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
            />
          </Field>
          <Field label={i === 0 ? "Max ($USDC)" : ""}>
            <input
              data-testid={`wl-${i}-max`}
              type="number"
              min={0}
              value={w.max_value_usdc}
              onChange={(e) =>
                update(i, { max_value_usdc: Number(e.target.value) })
              }
              className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
            />
          </Field>
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={state.want_list.length === 1}
            aria-label={`Remove row ${i + 1}`}
            className="px-2 py-2 text-[14px] border border-rule rounded hover:bg-rule2 disabled:opacity-30"
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={add}
          data-testid="wl-add"
          className="text-[12px] px-3 py-1.5 border border-rule rounded hover:bg-rule2"
        >
          + Add another
        </button>
      </div>
    </div>
  );
}

function BudgetStep({ state, setState }: StepProps) {
  return (
    <div className="grid gap-4">
      <Field label="Total budget (USDC across all open bids)">
        <input
          data-testid="field-budget"
          type="number"
          min={0}
          value={state.budget.total_budget_usdc}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              budget: { ...s.budget, total_budget_usdc: Number(e.target.value) },
            }))
          }
          className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
        />
      </Field>
      <Field
        label="Trusted publisher pubkey (optional)"
        help="If set, the bidder rejects any registry entry whose feed_signature isn't from this publisher. Recommended for production. Leave empty to opt out."
      >
        <input
          data-testid="field-publisher"
          value={state.budget.trusted_publisher_pubkey}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              budget: {
                ...s.budget,
                trusted_publisher_pubkey: e.target.value,
              },
            }))
          }
          placeholder="EkUz…1nHe (base58 32-byte pubkey)"
          className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
        />
      </Field>
    </div>
  );
}

function CredsStep({ state, setState }: StepProps) {
  const onGenerate = () => {
    const kp = Keypair.generate();
    setState((s) => ({
      ...s,
      creds: {
        ...s.creds,
        keypairMode: "generate",
        keypairBytes: Array.from(kp.secretKey),
        keypairPubkey: kp.publicKey.toBase58(),
        keypairUploadError: null,
      },
    }));
  };

  const onUpload = async (file: File) => {
    setState((s) => ({
      ...s,
      creds: { ...s.creds, keypairUploadError: null },
    }));
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 64 ||
        parsed.some(
          (n) => typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255
        )
      ) {
        throw new Error("File is not a 64-byte solana-keygen JSON array");
      }
      const kp = Keypair.fromSecretKey(Uint8Array.from(parsed));
      setState((s) => ({
        ...s,
        creds: {
          ...s.creds,
          keypairMode: "upload",
          keypairBytes: parsed,
          keypairPubkey: kp.publicKey.toBase58(),
          keypairUploadError: null,
        },
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        creds: {
          ...s.creds,
          keypairUploadError: (err as Error).message,
          keypairBytes: null,
          keypairPubkey: "",
        },
      }));
    }
  };

  const isOpenAICompatible = state.creds.llmProvider === "openai-compatible";
  return (
    <div className="grid gap-5">
      <Field
        label="LLM provider"
        help="Anthropic uses the official SDK + prompt caching. Any OpenAI-compatible /v1/chat/completions host works (OpenRouter, Groq, Together, vLLM, …)."
      >
        <select
          data-testid="field-provider"
          value={state.creds.llmPresetId}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              creds: applyLLMPreset(s.creds, e.target.value),
            }))
          }
          className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
        >
          {LLM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {isOpenAICompatible && (
        <>
          <Field
            label="Endpoint URL"
            help="Base URL of the /v1/chat/completions API. The bidder appends /chat/completions automatically."
          >
            <input
              data-testid="field-endpoint"
              type="url"
              autoComplete="off"
              value={state.creds.llmEndpoint}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  creds: { ...s.creds, llmEndpoint: e.target.value },
                }))
              }
              placeholder="https://openrouter.ai/api/v1"
              className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
            />
          </Field>
          <Field
            label="Model id"
            help="Provider-specific model id. e.g. gpt-4o-mini, anthropic/claude-3.5-sonnet, llama-3.3-70b-versatile."
          >
            <input
              data-testid="field-model"
              type="text"
              autoComplete="off"
              value={state.creds.llmModel}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  creds: { ...s.creds, llmModel: e.target.value },
                }))
              }
              placeholder="gpt-4o-mini"
              className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
            />
          </Field>
        </>
      )}
      <Field
        label="LLM API key"
        help={
          isOpenAICompatible
            ? "Bearer token sent in the Authorization header to your endpoint."
            : "Anthropic key (sk-ant-…). Used to call claude.ai with the official SDK + prompt caching."
        }
      >
        <input
          data-testid="field-apikey"
          type="password"
          autoComplete="off"
          value={state.creds.llmApiKey}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              creds: { ...s.creds, llmApiKey: e.target.value },
            }))
          }
          placeholder={isOpenAICompatible ? "sk-…" : "sk-ant-…"}
          className="w-full text-[14px] px-3 py-2 border border-rule rounded bg-paper ff-mono"
        />
      </Field>
      <Field
        label="Solana keypair"
        help="Encrypted at rest (AES-GCM under a server-side key). The keypair signs your bids; fund it on devnet before bids land."
      >
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onGenerate}
              data-testid="kp-generate"
              className="px-3 py-1.5 text-[12px] border border-rule rounded hover:bg-rule2"
            >
              Generate new
            </button>
            <label className="px-3 py-1.5 text-[12px] border border-rule rounded hover:bg-rule2 cursor-pointer">
              Upload .json
              <input
                data-testid="kp-upload"
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onUpload(f);
                }}
              />
            </label>
          </div>
          {state.creds.keypairPubkey && (
            <div
              data-testid="kp-pubkey"
              className="text-[12px] ff-mono text-ink p-3 bg-rule2 border border-rule rounded break-all"
            >
              {state.creds.keypairPubkey}
              <span className="block mt-1 text-[10px] text-dim">
                {state.creds.keypairMode === "generate"
                  ? "Generated in your browser. Fund this address on devnet for bids to land."
                  : "Uploaded from solana-keygen JSON."}
              </span>
            </div>
          )}
          {state.creds.keypairUploadError && (
            <div
              role="alert"
              data-testid="kp-error"
              className="text-[12px] text-red-700"
            >
              {state.creds.keypairUploadError}
            </div>
          )}
        </div>
      </Field>
    </div>
  );
}

function ReviewStep({ state }: { state: WizardState }) {
  const display = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-dim text-[12px] uppercase tracking-[0.14em] ff-mono">
        {label}
      </dt>
      <dd className="text-ink text-[14px]">{value}</dd>
    </>
  );
  return (
    <dl className="grid grid-cols-[10rem,1fr] gap-y-3 gap-x-6 text-[13px]">
      {display("Name", state.persona.name || "—")}
      {display("Risk", state.persona.risk_appetite)}
      {display(
        "Want list",
        <ul className="space-y-1">
          {state.want_list.map((w, i) => (
            <li key={i} className="ff-mono">
              {w.category || "(blank)"} · ≥{w.min_grade} · ≤${w.max_value_usdc}
            </li>
          ))}
        </ul>
      )}
      {display("Budget", `$${state.budget.total_budget_usdc} USDC`)}
      {display(
        "Trusted publisher",
        state.budget.trusted_publisher_pubkey ? (
          <span className="ff-mono break-all">
            {state.budget.trusted_publisher_pubkey}
          </span>
        ) : (
          <span className="text-dim">—</span>
        )
      )}
      {display(
        "Bidder pubkey",
        state.creds.keypairPubkey ? (
          <span className="ff-mono break-all">{state.creds.keypairPubkey}</span>
        ) : (
          <span className="text-red-700">missing</span>
        )
      )}
      {display(
        "LLM provider",
        <span className="ff-mono">
          {state.creds.llmProvider}
          {state.creds.llmProvider === "openai-compatible" &&
            state.creds.llmEndpoint && (
              <>
                {" "}
                <span className="text-dim">@</span>{" "}
                <span className="break-all">{state.creds.llmEndpoint}</span>
              </>
            )}
          {state.creds.llmModel && (
            <>
              {" "}
              <span className="text-dim">·</span> {state.creds.llmModel}
            </>
          )}
        </span>
      )}
      {display(
        "LLM key",
        state.creds.llmApiKey ? (
          <span className="ff-mono">
            {state.creds.llmApiKey.slice(0, 6)}…{state.creds.llmApiKey.slice(-3)}
          </span>
        ) : (
          <span className="text-red-700">missing</span>
        )
      )}
    </dl>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      {label && (
        <span className="block text-[12px] text-ink2 mb-1.5 ff-mono uppercase tracking-[0.12em]">
          {label}
        </span>
      )}
      {children}
      {help && (
        <span className="block text-[11px] text-dim mt-1.5">{help}</span>
      )}
    </label>
  );
}

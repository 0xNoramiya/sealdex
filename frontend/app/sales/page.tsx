"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Footer, TopBar } from "@/components/Chrome";
import {
  explorerAddress,
  explorerTx,
  shortPubkey,
  shortSig,
} from "@/lib/explorer";
import type { LotResponse } from "../api/lot/route";

/* ─── Mock bids (used only when no live data is available) ─── */
type Bid = {
  id: string;
  name: string;
  pubkey: string;
  amount: number;
  kind: string;
  tag: string;
};

const BIDS: Bid[] = [
  {
    id: "a",
    name: "Bidder Alpha",
    pubkey: "0x4f…a72c",
    amount: 2890,
    kind: "Autonomous Agent",
    tag: "A",
  },
  {
    id: "b",
    name: "Bidder Beta",
    pubkey: "0x91…c13e",
    amount: 3150,
    kind: "Autonomous Agent",
    tag: "B",
  },
  {
    id: "g",
    name: "Bidder Gamma",
    pubkey: "0xb2…08fd",
    amount: 2640,
    kind: "Autonomous Agent",
    tag: "Γ",
  },
];
const WINNER_ID = "b";

const REASONING = [
  {
    id: "a",
    text: "alpha — vintage holo · grade 9 meets minimum · bidding within budget",
  },
  {
    id: "b",
    text: "beta — comp range $2.8k–3.4k · reserving capacity · placing competitive bid",
  },
  {
    id: "g",
    text: "gamma — aggressive want-list match · max valuation $4k · headroom maintained",
  },
];

const fmtCountdown = (totalMs: number) => {
  const total = Math.max(0, Math.ceil(totalMs / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
};

type LotMeta = {
  title: string;
  subtitle: string;
  category: string;
  year: number | null;
  grade: number;
  serial: string;
  certNumber: string;
  estimateLow: number;
  estimateHigh: number;
  lotIdLabel: string;
};

const DEMO_META: LotMeta = {
  title: "Vintage Holo — Lot 001",
  subtitle: "Trading card · Holographic foil · 1999",
  category: "Vintage Holo",
  year: 1999,
  grade: 9,
  serial: "001 / 250",
  certNumber: "12847291",
  estimateLow: 2400,
  estimateHigh: 3400,
  lotIdLabel: "001",
};

function metaFromLot(lot: LotResponse | null): LotMeta {
  if (!lot?.lot) return DEMO_META;
  const m: any = (lot.lot as any).lot_metadata ?? {};
  const lotId: number | undefined = (lot.lot as any).lot_id;
  const title: string = m.title ?? `Lot ${lotId ?? "—"}`;
  const category: string = m.category ?? "Lot";
  const year: number | null =
    typeof m.year === "number" ? m.year : null;
  const grade: number = typeof m.grade === "number" ? m.grade : 9;
  const rawSerial: string = m.serial ?? "—";
  const serial = rawSerial.includes("/")
    ? rawSerial.replace("/", " / ")
    : rawSerial;
  const subtitleParts = ["Trading card"];
  if (m.foil ?? /\bholo\b/i.test(category)) subtitleParts.push("Holographic foil");
  if (year) subtitleParts.push(String(year));
  return {
    title,
    subtitle: subtitleParts.join(" · "),
    category,
    year,
    grade,
    serial,
    certNumber: m.cert_number ?? "—",
    estimateLow: typeof m.estimate_low_usdc === "number" ? m.estimate_low_usdc : 0,
    estimateHigh:
      typeof m.estimate_high_usdc === "number" ? m.estimate_high_usdc : 0,
    lotIdLabel: lotId ? String(lotId).padStart(3, "0") : "—",
  };
}

/* ─── Lot illustration: tasteful holo card silhouette inside the slab ─── */
function SlabArtwork({ meta }: { meta: LotMeta }) {
  const ribbonText = meta.year
    ? `${meta.category.toUpperCase()} · ${meta.year}`
    : meta.category.toUpperCase();
  const condition = `MINT ${meta.grade.toFixed(1)}`;
  return (
    <svg viewBox="0 0 240 220" className="absolute inset-0 w-full h-full">
      <defs>
        <linearGradient id="cardG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#F1E9D6" />
        </linearGradient>
        <linearGradient id="cardEdge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#D8C9A6" />
          <stop offset="1" stopColor="#A48A53" />
        </linearGradient>
        <radialGradient id="holoSheen" cx="0.3" cy="0.25" r="0.9">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.9" />
          <stop offset="0.4" stopColor="#FFFFFF" stopOpacity="0.0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.0" />
        </radialGradient>
        <linearGradient id="holoBars" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#F2D9A0" />
          <stop offset="0.25" stopColor="#E5C8E2" />
          <stop offset="0.5" stopColor="#BFE0E8" />
          <stop offset="0.75" stopColor="#D7E6C6" />
          <stop offset="1" stopColor="#F0CDB7" />
        </linearGradient>
      </defs>

      {/* Inner trading card */}
      <g transform="translate(60 28)">
        <rect
          x="0"
          y="0"
          width="120"
          height="164"
          rx="6"
          fill="url(#cardG)"
          stroke="url(#cardEdge)"
          strokeWidth="1.5"
        />
        {/* top label */}
        <rect
          x="8"
          y="8"
          width="104"
          height="14"
          rx="2"
          fill="#1E8B66"
          opacity="0.85"
        />
        <text
          x="60"
          y="18"
          textAnchor="middle"
          fontFamily="Inter, sans-serif"
          fontSize="7"
          fontWeight="700"
          letterSpacing="1.3"
          fill="#FFFFFF"
        >
          {ribbonText}
        </text>

        {/* artwork window */}
        <rect
          x="8"
          y="28"
          width="104"
          height="98"
          rx="3"
          fill="url(#holoBars)"
        />
        {/* monogram glyph instead of any IP character */}
        <g transform="translate(60 78)">
          <circle r="28" fill="#FFFFFF" opacity="0.6" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            y="2"
            fontFamily="Fraunces, serif"
            fontWeight="500"
            fontSize="40"
            fill="#1E8B66"
          >
            S
          </text>
        </g>
        {/* sheen overlay */}
        <rect
          x="8"
          y="28"
          width="104"
          height="98"
          rx="3"
          fill="url(#holoSheen)"
        />

        {/* card stats */}
        <line
          x1="8"
          y1="134"
          x2="112"
          y2="134"
          stroke="#D8C9A6"
          strokeWidth="0.8"
        />
        <text
          x="8"
          y="146"
          fontFamily="Inter"
          fontSize="6"
          fontWeight="600"
          fill="#5A6070"
          letterSpacing="0.8"
        >
          SERIAL
        </text>
        <text
          x="8"
          y="156"
          fontFamily="JetBrains Mono"
          fontSize="7"
          fontWeight="600"
          fill="#14171C"
        >
          {meta.serial}
        </text>
        <text
          x="64"
          y="146"
          fontFamily="Inter"
          fontSize="6"
          fontWeight="600"
          fill="#5A6070"
          letterSpacing="0.8"
        >
          CONDITION
        </text>
        <text
          x="64"
          y="156"
          fontFamily="JetBrains Mono"
          fontSize="7"
          fontWeight="600"
          fill="#14171C"
        >
          {condition}
        </text>
      </g>
    </svg>
  );
}

function Slab({ meta }: { meta: LotMeta }) {
  return (
    <div className="relative mx-auto" style={{ width: 300 }}>
      <div className="slab-case rounded-[10px] border border-rule p-2">
        {/* Cert label */}
        <div
          className="h-[26px] rounded-[4px] flex items-center justify-center px-3"
          style={{
            background: "linear-gradient(180deg, #B0464A 0%, #8E3034 100%)",
            boxShadow:
              "inset 0 -1px 0 rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.18)",
          }}
        >
          <span className="ff-mono text-[9px] tracking-[0.16em] text-white font-semibold whitespace-nowrap">
            SEALDEX&nbsp;·&nbsp;CERT&nbsp;#{meta.certNumber}&nbsp;·&nbsp;GRADE&nbsp;{meta.grade}
          </span>
        </div>

        {/* Window */}
        <div
          className="mt-2 rounded-[4px] overflow-hidden relative border border-black/5 slab-window"
          style={{ aspectRatio: "0.82 / 1" }}
        >
          <SlabArtwork meta={meta} />
        </div>

        {/* Bottom plate */}
        <div
          className="mt-2 h-[16px] rounded-[3px] flex items-center justify-between px-2"
          style={{ background: "#F4F2EC", border: "1px solid #E5E3DD" }}
        >
          <span className="ff-mono text-[8px] tracking-[0.12em] text-dim">
            PSA-EQ
          </span>
          <span className="ff-mono text-[8px] tracking-[0.12em] text-dim">
            SEALED · TEE
          </span>
        </div>
      </div>
    </div>
  );
}

function BidderMark({
  tag,
  isWinner,
  revealed,
}: {
  tag: string;
  isWinner: boolean;
  revealed: boolean;
}) {
  return (
    <div
      className="shrink-0 w-9 h-9 flex items-center justify-center"
      style={{
        background: isWinner && revealed ? "#14171C" : "#FFFFFF",
        color: isWinner && revealed ? "#FFFFFF" : "#14171C",
        border:
          isWinner && revealed ? "1px solid #14171C" : "1px solid #E5E3DD",
        borderRadius: 2,
        fontFamily: "var(--font-fraunces), serif",
        fontWeight: 500,
        fontSize: 16,
        letterSpacing: "0.02em",
      }}
    >
      {tag}
    </div>
  );
}

function BidRow({
  bid,
  revealed,
  flipped,
  isWinner,
}: {
  bid: Bid;
  revealed: boolean;
  flipped: boolean;
  isWinner: boolean;
}) {
  return (
    <div
      className={`bid-row flex items-center gap-4 px-5 py-4 ${
        isWinner && revealed ? "winner" : ""
      }`}
    >
      <BidderMark tag={bid.tag} isWinner={isWinner} revealed={revealed} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className="ff-serif text-[16px] font-medium text-ink leading-none">
            {bid.name}
          </span>
          {isWinner && revealed && (
            <span className="ff-mono text-[9.5px] tracking-[0.18em] uppercase text-accent font-semibold">
              Winning bid
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="ff-mono text-[11px] text-muted">{bid.pubkey}</span>
          <span className="text-muted">·</span>
          <span className="text-[11px] text-dim">{bid.kind}</span>
          <span className="text-muted">·</span>
          <span className="ff-mono text-[10px] tracking-[0.06em] text-dim">
            sealed&nbsp;via&nbsp;Private&nbsp;Ephemeral&nbsp;Rollup
          </span>
        </div>
      </div>
      <div className="flip-wrap">
        <div className={`flip ${flipped ? "flipped" : ""}`}>
          <div className="front">
            <span className="ff-mono text-[14px] text-muted tab-nums tracking-wider">
              $ ••• ,•••
            </span>
          </div>
          <div className="back">
            <span
              className={`ff-serif text-[20px] tab-nums leading-none ${
                isWinner ? "text-accent2 font-medium" : "text-ink"
              }`}
            >
              ${bid.amount.toLocaleString("en-US")}
              <span className="ff-mono text-[10px] ml-1.5 tracking-[0.14em] text-dim font-normal">
                USDC
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TickerRow({ lines }: { lines: { id: string; text: string }[] }) {
  const safeLines = lines.length > 0 ? lines : REASONING;
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, safeLines.length - 1)));
    const t = setInterval(
      () => setIdx((i) => (i + 1) % safeLines.length),
      2200,
    );
    return () => clearInterval(t);
  }, [safeLines.length]);
  const line = safeLines[Math.min(idx, safeLines.length - 1)];
  return (
    <div className="flex items-center gap-4 px-5 h-10 border-t border-rule2 bg-paper/60">
      <span className="eyebrow eyebrow-ink shrink-0">Agent reasoning</span>
      <span className="text-muted">·</span>
      <div className="flex-1 min-w-0 h-5 flex items-center overflow-hidden">
        <span
          key={(line?.id ?? "x") + idx}
          className="ticker-line ff-mono text-[11px] text-dim truncate"
        >
          {line?.text ?? ""}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {safeLines.slice(0, 6).map((r, i) => (
          <span
            key={r.id}
            className="w-1 h-1 rounded-full transition-colors"
            style={{
              background:
                i === idx % Math.min(safeLines.length, 6)
                  ? "#1E8B66"
                  : "#CFCEC7",
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function Page() {
  const startMs = 8000;
  const [lot, setLot] = useState<LotResponse | null>(null);
  const [anchor, setAnchor] = useState<{
    cluster: number;
    local: number;
  } | null>(null);
  const [, forceTick] = useState(0);
  const [remaining, setRemaining] = useState(startMs);
  const [revealed, setRevealed] = useState(false);
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const [revealing, setRevealing] = useState(false);
  const [showSettlement, setShowSettlement] = useState(false);
  const startedAt = useRef<number | null>(null);

  /* Poll /api/lot for live program data. Cluster-time anchor is captured
   * on every successful response so the countdown is independent of WSL clock skew. */
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/lot", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const data: LotResponse = await r.json();
        if (cancelled) return;
        setLot(data);
        setAnchor({ cluster: data.clusterUnix, local: Date.now() });
      } catch {
        /* ignore — keep last good state */
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /* Local 200ms tick advances the cluster-anchored countdown smoothly between fetches. */
  useEffect(() => {
    const t = setInterval(() => forceTick((x) => x + 1), 200);
    return () => clearInterval(t);
  }, []);

  const hasLive = !!lot?.hasLiveData;

  /* Mock countdown only runs when no live data is available. */
  useEffect(() => {
    if (hasLive) return;
    startedAt.current = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - (startedAt.current ?? Date.now());
      const rem = Math.max(0, startMs - elapsed);
      setRemaining(rem);
      if (rem <= 0) clearInterval(tick);
    }, 50);
    return () => clearInterval(tick);
  }, [hasLive]);

  const liveRemainingMs = (() => {
    if (!hasLive || !lot?.endTimeUnix || !anchor) return null;
    const nowCluster =
      anchor.cluster + (Date.now() - anchor.local) / 1000;
    return Math.max(0, (lot.endTimeUnix - nowCluster) * 1000);
  })();

  const effectiveRemaining = liveRemainingMs ?? remaining;

  const displayBids: Bid[] =
    hasLive && lot && lot.bidders.length > 0
      ? lot.bidders.map((b) => ({
          id: b.agentSlug,
          name: b.name,
          pubkey: b.pubkey,
          amount: b.amountUsdc ?? 0,
          kind: "Autonomous Agent",
          tag: b.tag,
        }))
      : BIDS;

  const winnerId = hasLive
    ? lot?.bidders.find((b) => b.isWinner)?.agentSlug ?? null
    : WINNER_ID;

  const displayReasoning =
    hasLive && lot && lot.reasoning.length > 0
      ? lot.reasoning
          .slice(-12)
          .map((e, i) => ({
            id: `${e.agentSlug}-${e.ts}-${i}`,
            text: (
              (e as any).reasoning ??
              (e as any).text ??
              ""
            )
              .toString()
              .replace(/\s+/g, " ")
              .trim(),
          }))
          .filter((e) => e.text.length > 0)
      : REASONING;

  const settledLive = hasLive && lot?.status === "Settled";
  const canReveal =
    !revealing && !revealed && (effectiveRemaining <= 0 || settledLive);
  const last3 = effectiveRemaining > 0 && effectiveRemaining <= 3000;

  const onReveal = () => {
    if (revealing || revealed) return;
    setRevealing(true);
    displayBids.forEach((b, i) => {
      setTimeout(
        () => setFlipped((p) => ({ ...p, [b.id]: true })),
        i * 220,
      );
    });
    const lastFlipDone =
      Math.max(0, (displayBids.length - 1) * 220) + 360;
    setTimeout(() => setRevealed(true), lastFlipDone);
    setTimeout(() => setShowSettlement(true), lastFlipDone + 600);
  };

  /* Auto-trigger the reveal sequence the moment the live auction
   * transitions to Settled. */
  useEffect(() => {
    if (settledLive && !revealing && !revealed) {
      onReveal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledLive]);

  const winner =
    displayBids.find((b) => b.id === winnerId) ?? displayBids[0];

  const meta: LotMeta = metaFromLot(lot);

  return (
    <div className="min-h-screen flex flex-col relative paper-bg">
      <TopBar active="sales" />

      {/* ─── Sale breadcrumb / sale band ─── */}
      <div className="border-b border-rule bg-paper">
        <div className="max-w-[1200px] mx-auto px-8 h-10 flex items-center justify-between text-[12px]">
          <div className="flex items-center gap-3 text-dim">
            <span>Sales</span>
            <span className="text-muted">/</span>
            <span>Trading Cards · {meta.category} Series</span>
            <span className="text-muted">/</span>
            <span className="text-ink">Lot {meta.lotIdLabel}</span>
          </div>
          <div className="flex items-center gap-5 text-dim">
            <span className="ff-mono text-[11px]">
              {hasLive && lot?.auctionId
                ? `Sale #A-${lot.auctionId}`
                : "Sale #A-2026-0418"}
            </span>
            <span className="text-muted">·</span>
            <span>Sealed-bid · Single-shot</span>
            <span className="text-muted">·</span>
            <span className="text-ink">{displayBids.length} bidders</span>
          </div>
        </div>
      </div>

      {/* ─── Main ─── */}
      <main className="flex-1">
        <div className="max-w-[1200px] mx-auto px-8 py-12 grid grid-cols-12 gap-12">
          {/* ── Left: Slab + caption ── */}
          <section className="col-span-5 flex flex-col items-center">
            <div className="eyebrow mb-5 self-start">
              Lot {meta.lotIdLabel} · Sealed
            </div>
            <Slab meta={meta} />
            <div className="mt-7 w-full text-center">
              <div className="ff-serif text-[28px] leading-tight text-ink">
                {meta.title}
              </div>
              <div className="mt-2 text-[13px] text-dim">
                {meta.subtitle}
                <br />
                Authenticated &amp; encapsulated by Sealdex Cert.
              </div>
            </div>

            {/* Provenance strip */}
            <div className="mt-6 w-full grid grid-cols-3 border-t border-b border-rule">
              <div className="px-3 py-3 border-r border-rule">
                <div className="eyebrow mb-1">Estimate</div>
                <div className="ff-serif text-[15px] text-ink tab-nums">
                  {meta.estimateLow > 0 && meta.estimateHigh > 0
                    ? `$${meta.estimateLow.toLocaleString()} — $${meta.estimateHigh.toLocaleString()}`
                    : "—"}
                </div>
              </div>
              <div className="px-3 py-3 border-r border-rule">
                <div className="eyebrow mb-1">Reserve</div>
                <div className="ff-serif text-[15px] text-ink tab-nums">Met</div>
              </div>
              <div className="px-3 py-3">
                <div className="eyebrow mb-1">Settlement</div>
                <div className="ff-serif text-[15px] text-ink">USDC · TEE</div>
              </div>
            </div>
          </section>

          {/* ── Right: Reveal panel ── */}
          <section className="col-span-7 flex flex-col">
            {/* Status header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="eyebrow">Sealed-bid auction</span>
                <span className="text-muted">·</span>
                <span className="text-[12px] text-dim">
                  Settles in TEE on reveal
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
                <span className="ff-mono text-[10.5px] tracking-[0.16em] uppercase text-accent2 font-semibold">
                  {revealed
                    ? "Revealed"
                    : revealing
                      ? "Revealing"
                      : settledLive
                        ? "Awaiting reveal"
                        : effectiveRemaining <= 0
                          ? "Awaiting settlement"
                          : "Sealed"}
                </span>
              </div>
            </div>

            {/* Countdown plinth */}
            <div className="plinth mt-4 mb-6 py-5 flex items-center justify-between">
              <div>
                <div className="eyebrow mb-1">Reveal in</div>
                <div
                  className={`ff-serif tab-nums text-[44px] leading-none transition-colors ${
                    last3 || effectiveRemaining === 0
                      ? "text-accent2"
                      : "text-ink"
                  }`}
                >
                  {fmtCountdown(effectiveRemaining)}
                </div>
              </div>
              <button
                onClick={onReveal}
                disabled={!canReveal}
                className={`group inline-flex items-center gap-2.5 ff-mono text-[11px] tracking-[0.18em] uppercase font-semibold px-5 h-10 transition-colors ${
                  revealed ? "bg-accentBg text-accent2 cursor-default" : ""
                } ${
                  revealing && !revealed
                    ? "bg-accentBg text-accent2 cursor-wait"
                    : ""
                } ${canReveal ? "bg-ink text-white hover:bg-ink2" : ""} ${
                  !canReveal && !revealing && !revealed
                    ? "bg-paper text-muted border border-rule cursor-not-allowed"
                    : ""
                }`}
              >
                {(revealed || revealing) && (
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2.5 6.3L5 8.5L9.5 3.5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {revealed ? "Revealed" : revealing ? "Revealing" : "Reveal Bids"}
                {!revealed && !revealing && (
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M3 6h6M7 3l3 3-3 3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </div>

            {/* Sealed bids — table */}
            <div className="bg-card border border-rule">
              <div className="flex items-center justify-between px-5 h-10 border-b border-rule bg-paper">
                <span className="eyebrow eyebrow-ink">Sealed bids</span>
                <div className="flex items-center gap-4 text-[10.5px] tracking-[0.14em] uppercase text-muted font-semibold">
                  <span>Bidder</span>
                  <span className="w-[150px] text-right">Amount</span>
                </div>
              </div>

              {displayBids.map((b) => (
                <BidRow
                  key={b.id}
                  bid={b}
                  revealed={revealed}
                  flipped={!!flipped[b.id]}
                  isWinner={!!winnerId && b.id === winnerId}
                />
              ))}

              <TickerRow lines={displayReasoning} />
            </div>

            {/* Settlement footer */}
            <div className="mt-6 min-h-[58px]">
              {showSettlement ? (
                <div className="settle-in border-l-2 border-accent pl-4 py-1">
                  <div className="ff-serif text-[16px] text-ink2">
                    Settled privately to{" "}
                    <span className="text-accent2 font-medium">
                      {winner.name}
                    </span>{" "}
                    at{" "}
                    <span className="tab-nums">
                      ${winner.amount.toLocaleString()}
                    </span>{" "}
                    USDC.
                  </div>
                  <div className="mt-1 text-[12px] text-dim flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>Paid via Private Payments API</span>
                    <span className="text-muted">·</span>
                    <span>Loser bids never disclosed</span>
                    {hasLive && lot?.auctionPda && (
                      <>
                        <span className="text-muted">·</span>
                        <span>Auction</span>
                        <a
                          href={explorerAddress(lot.auctionPda)}
                          target="_blank"
                          rel="noreferrer"
                          className="ff-mono text-[11px] text-ink2 underline decoration-rule underline-offset-2 hover:text-accent2"
                        >
                          {shortPubkey(lot.auctionPda)}
                        </a>
                      </>
                    )}
                    {hasLive && lot?.signature && (
                      <>
                        <span className="text-muted">·</span>
                        <span>Tx</span>
                        <a
                          href={explorerTx(lot.signature)}
                          target="_blank"
                          rel="noreferrer"
                          className="ff-mono text-[11px] text-ink2 underline decoration-rule underline-offset-2 hover:text-accent2"
                        >
                          {shortSig(lot.signature)}
                        </a>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-[12px] text-muted">
                  Bids remain encrypted in the TEE until the seller calls{" "}
                  <span className="ff-mono text-dim">reveal()</span>. Losing
                  bids are discarded without disclosure.
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}

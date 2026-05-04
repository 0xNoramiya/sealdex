"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { WalletConnectButton } from "./WalletConnectButton";

type ActivePage =
  | "home"
  | "sales"
  | "lots"
  | "agents"
  | "settlement"
  | "docs";

const NAV: { key: ActivePage; label: string; href: string }[] = [
  { key: "sales", label: "Sales", href: "/sales" },
  { key: "lots", label: "Lots", href: "/lots" },
  { key: "agents", label: "Agents", href: "/agents" },
  { key: "settlement", label: "Settlement", href: "/settlement" },
  { key: "docs", label: "Docs", href: "/docs" },
];

export function TopBar({ active }: { active: ActivePage }) {
  const [open, setOpen] = useState(false);

  // Close the mobile menu on Escape, and lock scroll while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className="border-b border-rule bg-paper relative">
      <div className="max-w-[1200px] mx-auto px-8 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect
              x="1.5"
              y="1.5"
              width="19"
              height="19"
              rx="2"
              stroke="#14171C"
              strokeWidth="1.2"
            />
            <path d="M6 11 L11 6 L16 11 L11 16 Z" fill="#14171C" />
          </svg>
          <span className="ff-serif text-[18px] font-medium tracking-[-0.01em] text-ink">
            Sealdex
          </span>
          <span className="ff-mono text-[9.5px] font-semibold tracking-[0.22em] uppercase px-2 py-1 text-dim border border-rule">
            Devnet
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-8 text-[13px] text-dim">
          {NAV.map((n) => (
            <Link
              key={n.key}
              href={n.href}
              className={
                active === n.key
                  ? "text-ink font-medium"
                  : "hover:text-ink transition-colors"
              }
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-5">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
            <span className="text-[12px] text-dim">TEE Verified</span>
          </div>
          <span className="ff-mono text-[11px] text-dim">
            enclave://us-east-1.sealdex
          </span>
          <WalletConnectButton />
        </div>

        <button
          type="button"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="md:hidden -mr-2 p-2 text-ink"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            {open ? (
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            ) : (
              <>
                <path
                  d="M3 6h14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M3 10h14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M3 14h14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </>
            )}
          </svg>
        </button>
      </div>

      {open && (
        <div className="md:hidden border-t border-rule bg-paper">
          <nav className="max-w-[1200px] mx-auto px-8 py-4 flex flex-col">
            {NAV.map((n) => (
              <Link
                key={n.key}
                href={n.href}
                onClick={() => setOpen(false)}
                className={`py-3 border-b border-rule last:border-b-0 text-[15px] flex items-center justify-between ${
                  active === n.key ? "text-ink font-medium" : "text-ink2"
                }`}
              >
                <span>{n.label}</span>
                {active === n.key && (
                  <span className="ff-mono text-[10px] tracking-[0.18em] uppercase text-accent2">
                    here
                  </span>
                )}
              </Link>
            ))}
            <div className="pt-4 mt-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
              <span className="text-[12px] text-dim">TEE Verified</span>
              <span className="ff-mono text-[11px] text-dim ml-2">
                enclave://us-east-1.sealdex
              </span>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-rule bg-paper">
      <div className="max-w-[1200px] mx-auto px-8 h-12 flex items-center justify-between text-[11px] text-dim">
        <div className="flex items-center gap-5">
          <span className="ff-mono">Sealdex&nbsp;·&nbsp;v0.4.1</span>
          <span className="text-muted">·</span>
          <span className="hidden sm:inline">
            Sealed-bid infrastructure for autonomous agents
          </span>
        </div>
        <div className="flex items-center gap-5 ff-mono">
          <span className="text-accent2">enclave verified</span>
        </div>
      </div>
    </footer>
  );
}

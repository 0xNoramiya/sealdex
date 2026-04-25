import Link from "next/link";

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
  return (
    <header className="border-b border-rule bg-paper">
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

        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
            <span className="text-[12px] text-dim">TEE Verified</span>
          </div>
          <span className="ff-mono text-[11px] text-dim">
            enclave://us-east-1.sealdex
          </span>
        </div>
      </div>
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
          <span>Sealed-bid infrastructure for autonomous agents</span>
        </div>
        <div className="flex items-center gap-5 ff-mono">
          <span className="text-accent2">enclave verified</span>
        </div>
      </div>
    </footer>
  );
}

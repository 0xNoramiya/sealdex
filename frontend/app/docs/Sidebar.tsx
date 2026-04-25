"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "program", label: "Program design" },
  { id: "addresses", label: "Addresses" },
  { id: "decisions", label: "Design decisions" },
  { id: "run", label: "Run it locally" },
];

export default function DocsSidebar({ repoUrl }: { repoUrl: string }) {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const targets = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => !!el,
    );
    if (targets.length === 0) return;

    // Observe each section. The most-visible heading near the top of the
    // viewport is the "current" section. rootMargin biases against
    // counting headings that are barely entering the screen at the bottom.
    const observer = new IntersectionObserver(
      (entries) => {
        // Filter to headings currently in or above the viewport top region.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) {
          setActive(visible[0].target.id);
        }
      },
      {
        rootMargin: "-80px 0px -65% 0px",
        threshold: [0, 0.1, 0.5, 1],
      },
    );
    for (const t of targets) observer.observe(t);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="sticky top-8 space-y-6">
      <div>
        <div className="eyebrow mb-3">Contents</div>
        <ul className="space-y-2 text-[13px]">
          {SECTIONS.map((s) => {
            const isActive = active === s.id;
            return (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className={
                    isActive
                      ? "text-ink font-medium border-l-2 border-accent2 pl-2 -ml-2 block"
                      : "text-ink2 hover:text-accent2 transition-colors block"
                  }
                  aria-current={isActive ? "true" : undefined}
                >
                  {s.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>

      <Link
        href={repoUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2.5 ff-mono text-[10.5px] tracking-[0.18em] uppercase font-semibold px-4 h-9 bg-ink text-white hover:bg-ink2 transition-colors"
      >
        GitHub
      </Link>
    </div>
  );
}

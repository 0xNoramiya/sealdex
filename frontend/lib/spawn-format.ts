// Pure formatting helpers for the /spawn/me dashboard. Lives outside
// the page component so the formatters are unit-testable without
// booting React.

/**
 * Compact relative-time string ("3s ago", "2m ago", "4h ago", "5d ago").
 * Negative deltas ("in 30s") are handled too, in case the system clock
 * skews ahead of the registry's `updatedAt`.
 */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  const diff = Math.round(nowMs / 1000) - unixSeconds;
  const abs = Math.abs(diff);
  const suffix = diff < 0 ? "from now" : "ago";

  if (abs < 1) return "just now";
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.floor(abs / 60)}m ${suffix}`;
  if (abs < 86_400) return `${Math.floor(abs / 3600)}h ${suffix}`;
  return `${Math.floor(abs / 86_400)}d ${suffix}`;
}

export type SpawnStatus = "running" | "stopped" | "errored";

export interface StatusBadgeStyle {
  /** Tailwind classes for the badge background. */
  bg: string;
  /** Tailwind classes for the badge text colour. */
  text: string;
  /** Whether the badge should pulse (running). */
  pulse: boolean;
  /** Plain-text label. */
  label: string;
}

/** Map a spawn status to a stable visual style. Pure — no DOM access. */
export function statusBadgeStyle(status: SpawnStatus | string): StatusBadgeStyle {
  switch (status) {
    case "running":
      return { bg: "bg-accentBg", text: "text-accent2", pulse: true, label: "running" };
    case "stopped":
      return { bg: "bg-rule2", text: "text-ink2", pulse: false, label: "stopped" };
    case "errored":
      return { bg: "bg-red-50", text: "text-red-700", pulse: false, label: "errored" };
    default:
      return { bg: "bg-rule2", text: "text-dim", pulse: false, label: status };
  }
}

export function shortId(id: string, head = 4, tail = 4): string {
  if (!id || id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

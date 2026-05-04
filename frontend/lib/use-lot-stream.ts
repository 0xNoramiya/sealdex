// Client hook for the catalog page. Prefers /api/lot/stream (SSE pushes,
// no client polling at all) and falls back to /api/lot polling on either
// a terminal EventSource error or the server's `recycle` event.
//
// Why this matters: at scale, every visitor's tab polls every 2s. With
// 100 concurrent observers that's ~3000 requests/min just from one page.
// SSE collapses that to 100 long-lived connections + push-on-change. The
// cache layer in /api/lot already coalesces; SSE removes the bulk of the
// cost upstream of the cache.

"use client";

import { useEffect, useRef, useState } from "react";
import type { LotResponse } from "../app/api/lot/route";

export type LotStreamSource = "loading" | "sse" | "poll";

export function useLotStream(): {
  lot: LotResponse | null;
  source: LotStreamSource;
} {
  const [lot, setLot] = useState<LotResponse | null>(null);
  const [source, setSource] = useState<LotStreamSource>("loading");
  // Refs (not state) so handler closures see current values without
  // reattaching listeners.
  const cancelledRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    cancelledRef.current = false;

    const startPolling = () => {
      if (pollIntervalRef.current) return; // already polling
      const poll = async () => {
        try {
          const r = await fetch("/api/lot", { cache: "no-store" });
          if (!r.ok || cancelledRef.current) return;
          const data: LotResponse = await r.json();
          if (cancelledRef.current) return;
          setLot(data);
        } catch {
          /* keep last good state */
        }
      };
      poll();
      pollIntervalRef.current = setInterval(poll, 2000);
      setSource("poll");
    };

    const stopSse = () => {
      esRef.current?.close();
      esRef.current = null;
    };

    const openSse = () => {
      // Browsers without EventSource (very rare, mostly old Edge) → poll.
      if (typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      let es: EventSource;
      try {
        es = new EventSource("/api/lot/stream");
      } catch {
        startPolling();
        return;
      }
      esRef.current = es;
      const onPayload = (ev: MessageEvent) => {
        if (cancelledRef.current) return;
        try {
          const data: LotResponse = JSON.parse(ev.data);
          setLot(data);
          setSource("sse");
        } catch {
          /* malformed event — ignore */
        }
      };
      es.addEventListener("snapshot", onPayload);
      es.addEventListener("update", onPayload);
      es.addEventListener("recycle", () => {
        // Server told us this stream has hit its lifetime cap. Close the
        // connection cleanly and fall back to polling for the rest of the
        // page life — simpler than reopening + reattaching listeners.
        stopSse();
        if (!cancelledRef.current) startPolling();
      });
      es.onerror = () => {
        // EventSource auto-reconnects on transient failures (CONNECTING
        // state). Only fall back to polling on terminal closures so we
        // don't ditch SSE on a momentary network blip.
        if (es.readyState === EventSource.CLOSED && !cancelledRef.current) {
          stopSse();
          startPolling();
        }
      };
    };

    openSse();

    return () => {
      cancelledRef.current = true;
      stopSse();
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  return { lot, source };
}

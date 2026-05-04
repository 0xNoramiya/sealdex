// Server-Sent Events stream for /api/lot. Client opens this once per
// session and receives `data: <payload>\n\n` whenever the cached
// fingerprint changes. Falls back to the regular polling /api/lot
// endpoint when the browser doesn't speak SSE (we send keepalive
// comments every 25s so intermediaries don't drop the connection).

import { getLotPayload, lotFingerprint } from "@/lib/lot-cache";

export const dynamic = "force-dynamic";

const TICK_MS = 1_000;
const KEEPALIVE_MS = 25_000;
const MAX_LIFETIME_MS = 5 * 60 * 1000; // recycle to avoid memory pinning

export async function GET(req: Request) {
  const url = new URL(req.url);
  const queryAuctionId = url.searchParams.get("auctionId");
  const start = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, payload: unknown) => {
        const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
        controller.enqueue(encoder.encode(line));
      };

      // Send the current state immediately so the client can render
      // without waiting for the first tick.
      const initial = await getLotPayload(queryAuctionId);
      send("snapshot", initial);
      let lastFingerprint = lotFingerprint(queryAuctionId);
      let lastKeepalive = Date.now();

      const tick = setInterval(async () => {
        try {
          const payload = await getLotPayload(queryAuctionId);
          const fp = lotFingerprint(queryAuctionId);
          if (fp && fp !== lastFingerprint) {
            send("update", payload);
            lastFingerprint = fp;
          }
          if (Date.now() - lastKeepalive > KEEPALIVE_MS) {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
            lastKeepalive = Date.now();
          }
          if (Date.now() - start > MAX_LIFETIME_MS) {
            send("recycle", { reason: "max-lifetime" });
            cleanup();
            controller.close();
          }
        } catch (err) {
          // Surface to the client and drop — they'll reconnect.
          send("error", { message: (err as Error).message });
        }
      }, TICK_MS);

      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", onAbort);

      function cleanup() {
        clearInterval(tick);
        req.signal.removeEventListener("abort", onAbort);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering if proxied
    },
  });
}

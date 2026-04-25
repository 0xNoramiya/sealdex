import { readFile } from "node:fs/promises";
import path from "node:path";

// Mirror of agents/bidder/README.md served from the frontend so the
// /agents page CTAs work locally and on the Fly deploy without
// depending on the GitHub remote.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const file = path.resolve(
      process.cwd(),
      "..",
      "agents",
      "bidder",
      "README.md",
    );
    const content = await readFile(file, "utf-8");
    return new Response(content, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("bidder README not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

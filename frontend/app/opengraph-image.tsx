import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt =
  "Sealdex — Sealed-bid infrastructure for autonomous agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function loadFont(filename: string): Promise<ArrayBuffer | null> {
  try {
    const full = path.join(process.cwd(), "public", "fonts", filename);
    const buf = await readFile(full);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
}

export default async function OG() {
  const [fraunces, mono] = await Promise.all([
    loadFont("fraunces-medium.ttf"),
    loadFont("jetbrains-medium.ttf"),
  ]);

  const fonts: ConstructorParameters<typeof ImageResponse>[1]["fonts"] = [];
  if (fraunces) {
    fonts.push({
      name: "Fraunces",
      data: fraunces,
      style: "normal",
      weight: 500,
    });
  }
  if (mono) {
    fonts.push({
      name: "JetBrainsMono",
      data: mono,
      style: "normal",
      weight: 500,
    });
  }

  // If a font failed to load, ImageResponse needs at least one — fall back
  // to letting Satori use its built-in font.
  const serifFamily = fraunces ? "Fraunces, serif" : "serif";
  const monoFamily = mono ? "JetBrainsMono, monospace" : "monospace";

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#F5EDE0",
          padding: "72px 80px",
          fontFamily: serifFamily,
          color: "#1A1A1A",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 22,
            color: "#6B6557",
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              border: "2px solid #1A1A1A",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transform: "rotate(45deg)",
              background: "#1A1A1A",
            }}
          />
          <div
            style={{
              fontSize: 26,
              color: "#1A1A1A",
              fontWeight: 500,
              letterSpacing: -0.3,
            }}
          >
            Sealdex
          </div>
          <div
            style={{
              fontSize: 13,
              letterSpacing: 4,
              padding: "6px 12px",
              border: "1.5px solid #D9CFBE",
              color: "#6B6557",
              fontFamily: monoFamily,
              textTransform: "uppercase",
            }}
          >
            Devnet
          </div>
        </div>

        <div style={{ flex: 1, display: "flex" }} />

        <div
          style={{
            fontSize: 88,
            lineHeight: 1.04,
            letterSpacing: -2,
            color: "#1A1A1A",
            maxWidth: 980,
            display: "flex",
          }}
        >
          Auctions where AI agents can bid honestly.
        </div>

        <div
          style={{
            marginTop: 28,
            fontSize: 26,
            lineHeight: 1.5,
            color: "#3A372F",
            maxWidth: 940,
            display: "flex",
          }}
        >
          Bid amounts stay sealed inside Intel TDX hardware until the auction
          settles — so autonomous agents can bid their true valuation without
          being front-run.
        </div>

        <div
          style={{
            marginTop: 48,
            paddingTop: 24,
            borderTop: "1px solid #D9CFBE",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 16,
            fontFamily: monoFamily,
            color: "#6B6557",
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: "#1F5F4A",
              }}
            />
            TEE VERIFIED · enclave://us-east-1.sealdex
          </div>
          <div style={{ color: "#1F5F4A", fontWeight: 600 }}>
            sealed-bid · agent-native
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts,
    },
  );
}

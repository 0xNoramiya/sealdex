import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt =
  "Sealdex — Sealed-bid infrastructure for autonomous agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OG() {
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
          fontFamily: "serif",
          color: "#1A1A1A",
        }}
      >
        {/* Top row */}
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
          <div style={{ fontSize: 26, color: "#1A1A1A", fontWeight: 500 }}>
            Sealdex
          </div>
          <div
            style={{
              fontSize: 14,
              letterSpacing: 4,
              padding: "6px 12px",
              border: "1.5px solid #D9CFBE",
              color: "#6B6557",
              fontFamily: "monospace",
              textTransform: "uppercase",
            }}
          >
            Devnet
          </div>
        </div>

        {/* Spacer */}
        <div style={{ flex: 1, display: "flex" }} />

        {/* Headline */}
        <div
          style={{
            fontSize: 88,
            lineHeight: 1.05,
            letterSpacing: -1.5,
            color: "#1A1A1A",
            maxWidth: 980,
            display: "flex",
          }}
        >
          Auctions where AI agents can bid honestly.
        </div>

        {/* Subhead */}
        <div
          style={{
            marginTop: 28,
            fontSize: 26,
            lineHeight: 1.5,
            color: "#3A372F",
            maxWidth: 920,
            display: "flex",
          }}
        >
          Bid amounts stay sealed inside Intel TDX hardware until the auction
          settles — so autonomous agents can bid their true valuation without
          being front-run.
        </div>

        {/* Bottom rule + footer */}
        <div
          style={{
            marginTop: 48,
            paddingTop: 24,
            borderTop: "1px solid #D9CFBE",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            fontFamily: "monospace",
            color: "#6B6557",
            letterSpacing: 2,
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
    size,
  );
}

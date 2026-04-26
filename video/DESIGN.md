# DESIGN.md — Sealdex demo video

The video lives downstream of the Sealdex product's editorial catalog
aesthetic. Sotheby's-inspired, ceremonial, restrained. Not a tech promo.
The reveal feels like an auction-house gavel coming down, not confetti.

## Style Prompt

A parchment-toned editorial composition with hairline rules, generous
whitespace, and a single signet-green accent. Type sets the rhythm; motion
is tactful — fades, focus pulls, blur crossfades — never bouncy. The piece
should feel like leafing through a Sotheby's catalog where one of the lots
happens to be encrypted.

## Colors

| Role          | Hex       | Use                                                             |
| ------------- | --------- | --------------------------------------------------------------- |
| `paper`       | `#F5EDE0` | Background. Warm parchment, never pure white.                   |
| `card`        | `#FFFFFF` | Card / panel surfaces, sparingly.                               |
| `ink`         | `#1A1A1A` | Primary text, headlines.                                        |
| `ink2`        | `#3A372F` | Secondary text, body.                                           |
| `dim`         | `#6B6557` | Muted body, captions, attribution.                              |
| `rule`        | `#D9CFBE` | Hairline dividers and borders.                                  |
| `accent`      | `#1F5F4A` | Signet green — used sparingly for emphasis ("revealed" state).  |
| `accent2`     | `#1E8B66` | Brighter accent for active dots and highlight text.             |
| `amber`       | `#A8966B` | Sealed-state numerics. Implies "encrypted, not yet revealed".   |
| `red`         | `#8B2E2E` | Cert label band only — never anywhere else.                     |

WCAG AA: dim `#6B6557` on paper `#F5EDE0` is 4.71 — passes. Don't push
text any lighter without re-checking contrast.

## Typography

- **Display + body**: `Fraunces` — variable axis, weight 500-600. The
  serif voice. Headlines, body copy, numerics.
- **Labels + data**: `JetBrains Mono` — weight 500. Monospace voice. Used
  for eyebrows, addresses, instruction names, status pills.

Two-font pairing across categories (serif + mono). No third typeface.
Headlines 80-130px, body 24-32px, mono labels 16-22px (uppercase + 0.18em
tracking).

## Motion

- Editorial pacing. Entrances 0.5-0.7s, never under 0.3s.
- Easing palette: `sine.inOut`, `power2.out`, `power3.out`, `expo.out`.
  Vary across each scene; do not repeat.
- Transitions: blur crossfade or focus pull primary, 0.5-0.7s,
  `sine.inOut` or `power1.inOut`.
- Ambient: hairline rules can pulse-fade slowly (3-5s), the green status
  dot pulses every 1.8s. Nothing else moves while content is on screen.

## What NOT to Do

- No confetti, particle bursts, or celebratory motion. The reveal is
  ceremonial, not festive.
- No glassmorphism, frosted blur cards, or full-screen gradient
  backgrounds. Hairline borders + flat fills only.
- No electric mint, neon, or saturated accents. The accent is signet
  green `#1F5F4A` — money-coded, restrained.
- No third typeface, no ornamental script, no all-caps Fraunces (let the
  serif's optical-size axis do the work instead).
- No exit animations between scenes — the transition handles the
  handoff. Only the final scene fades elements out.

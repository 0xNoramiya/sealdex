# Sealdex demo — voiceover script

> ~107 seconds of narration across a 143-second composition. Scene 5
> contains a deliberate ~13-second silence for splicing in your screen
> capture. Total runtime: 2:23.

## Voicing notes (for ElevenLabs)

- **Voice**: a measured, mid-warm voice. Not announcer. Auction-house
  curator energy — dry, confident, restrained. Stability ~0.45,
  similarity ~0.7, style 0.35-0.45. The brand is editorial; don't oversell.
- **Pace**: 145-160 wpm. Pause briefly at em-dashes; longer at section
  breaks. Don't rush the cold open or the close.
- **Tone**: confident-but-quiet for the problem (s2), brighter on the
  solution (s3), procedural and brisk for architecture (s4), warm and
  inviting for agents (s6), low and final for the close (s7).

## Per-scene script

### Scene 1 — Cold open  · 0:00 – 0:08

> Sealdex.  
> Sealed-bid auction infrastructure for autonomous agents.

**Timing**: ~4-5 s. Land "Sealdex" at ~1.0 s after the wordmark
finishes its entrance, then tagline at ~3.0 s. Let the rest hold in
silence under the chrome reveal.

---

### Scene 2 — The problem  · 0:08 – 0:35

> Public bidding is broken for AI agents.  
>  
> On a public mempool, every signed transaction carries its bid amount
> in cleartext. An autonomous agent broadcasting on-chain is
> advertising its maximum valuation — to anyone watching the chain.  
>  
> And anyone watching can outbid by a single dollar, and capture all
> the surplus.

**Timing**: ~22-24 s. Start narration at ~0:09 (just after the
crossfade lands). Hit "leak" cue when the red `$ 3,400` pops in at
~0:10. Let the sentence about "outbid by a single dollar" land slowly.

---

### Scene 3 — The solution  · 0:35 – 0:57

> Sealdex moves the bidding window inside MagicBlock's Private
> Ephemeral Rollup. Bid amounts stay encrypted in Intel TDX hardware
> until the seller calls reveal.  
>  
> Only the winner is committed back to base Solana. Losing bids are
> discarded without disclosure — by the hardware itself.

**Timing**: ~18-20 s. Start ~0:36. The "by the hardware itself" lands
on the green sealed dot.

---

### Scene 4 — How it works  · 0:57 – 1:25

> Four instructions, one enclave.  
>  
> Create_auction posts a lot, delegates the auction to the TEE.
> Place_bid seals the bid amount on creation. Settle_auction runs
> inside the enclave — iterates every bid, finds the max, and commits
> only the winner back to base Solana. Claim_lot triggers private
> payment via an off-chain escrow agent.

**Timing**: ~24-26 s. Pace one instruction per ~5 s as the rows
stagger in. Let "only the winner" land deliberately.

---

### Scene 5 — Demo handoff  · 1:25 – 1:40  *(silence reserved)*

> Let's see it in action.

**Timing**: ~2 s of narration at 1:25 – 1:27. The remaining ~13 s is
**deliberate silence** — splice your screen capture audio over it.
If your demo recording has its own audio, mute this scene's track
entirely from 1:27 to 1:40.

---

### Scene 6 — Agents  · 1:40 – 2:12

> Sealdex isn't just an auction.  
>  
> The repo ships an AGENTS-dot-M-D and a standard M-C-P config —
> anyone with Claude Code, Cursor, or any AI runtime can become an
> autonomous bidder.  
>  
> Three paths. Clone the standalone Node bidder. Drop our M-C-P
> server into your client. Or open the repo in your runtime and tell
> it to act. The bidder persona, the rules, the on-chain tools — all
> pre-wired.

**Timing**: ~26-28 s. Use the staggered card entrances as natural
beats — start each "path" sentence as a card lands.

> ElevenLabs note: spell `AGENTS-dot-M-D` and `M-C-P` with hyphens so
> the model pronounces them as letters. Otherwise it tries to read
> "MCP" as one word.

---

### Scene 7 — Close  · 2:12 – 2:23

> Sealdex.  
> Sealed-bid infrastructure for autonomous agents.  
>  
> Live on devnet at sealdex-dot-fly-dot-dev.

**Timing**: ~7 s. Land "Sealdex" at 2:12.5, tagline at 2:14, URL at
2:17. The final ~4 s fade out is silent.

---

## ElevenLabs CLI hint

If you're rendering via the API, generate per-scene WAVs and stitch:

```bash
# scene 2 (longest)
curl -X POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id> \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Public bidding is broken for AI agents. On a public mempool, every signed transaction carries its bid amount in cleartext. An autonomous agent broadcasting on-chain is advertising its maximum valuation — to anyone watching the chain. And anyone watching can outbid by a single dollar, and capture all the surplus.",
    "model_id": "eleven_turbo_v2_5",
    "voice_settings": {"stability": 0.45, "similarity_boost": 0.7, "style": 0.4}
  }' \
  --output scene-2.mp3
```

Place each MP3 at its scene start time when assembling. Total
narration: ~107 seconds across 143 seconds of video, with 13 seconds
of intentional silence in scene 5.

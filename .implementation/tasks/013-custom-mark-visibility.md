# 013 — Custom-mark glyph visibility

**Goal:** custom-classifier mark names (§16.5 neutral glyph) must be
*visible*, not a muted `·` that disappears — found while verifying 009
against `tmp/demo`: that session's marks are all custom names
(`skim`/`hotspot`), and in dark mode the neutral dot is effectively
invisible. The user reported "can't see the annotation marks anymore".

**Status:** **done** — option 1: the custom-name glyph is the mark name's
initial (uppercased, `font-weight: 600`) in the muted color — neutral (no
canonical semantics claimed), readable in dark mode, and distinguishes
names at a glance (`S` for `skim`, `H` for `hotspot`). Full name + source
stay on hover. Spec §9.3 + §18 and ux §3.2 updated to match. Verified
headlessly against the demo: custom-name glyphs visible in the gutter on a
freshly regenerated session (306/306 stamped).

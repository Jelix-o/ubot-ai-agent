# UBot V3.0.30

V3.0.30 keeps the 2026 Chinese private-enterprise Top 500 deterministic
knowledge dataset globally available to every enabled group, while making the
separate headquarters-city research gate materially stricter. City statistics
remain unavailable until all 500 headquarters records are independently
verified and signed.

## Changes

- Routes ordinary chat through the normal reply model, even directly after a
  Top 500 answer. The ranking service now accepts only explicit ranking
  requests, a uniquely matched enterprise name, and a small closed set of
  compact ranking questions and continuations. Short province counts and
  province comparisons require a ranking-specific form. Phrases such as
  `南京的本科院校有哪些`, `江苏省有哪些大学`, and
  `2026年第一名大学是谁` cannot be captured by the ranking dataset.
- Exposes a knowledge tool to the model only when the current request clearly
  requires that verified source. General chat receives neither the Top 500
  tool nor the FAQ tool, preventing an unrelated model request from ending in
  a global ranking result.
- Fixes the province ordinal response grammar: a sole province now says
  `共N家`; only a tied position says `各N家`.
- Requires the evidence selected for a frozen headquarters record to have both
  its published date and claim date inside the inclusive 365-day window ending
  on the ranking publication date.
- Requires source-captured, explicit entity-relationship text when a source
  subject differs from the exact ranked enterprise; reviewer notes alone can
  no longer bridge legal-entity or group-name mismatches.
- Preserves faithful city quotations while allowing only safe canonical forms,
  including a final `市` omission and a fixed list of autonomous-prefecture
  short forms. Prefix matches such as `杭州湾` cannot satisfy `杭州市`.
- Adds an offline-only, Git-ignored research workspace that seeds all 500
  rank-bound candidate records without creating city claims or modifying
  production assets. Its promotion gate mirrors the runtime evidence checks.

## Verification

- Covers ordinary-chat routing after a ranking answer, tool exposure,
  province ordinal wording, city-source aliases, stale evidence,
  entity-relationship evidence, capture tampering, and the private research
  workflow.
- Runs the full Node 22 suite, admin visual smoke test, Windows/Linux release
  packaging verification, and the production deployment preflight.

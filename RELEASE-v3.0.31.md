# UBot V3.0.31

V3.0.31 hardens ordinary-chat routing around geographic and domain-specific
questions while preserving the deterministic 2026 private-enterprise ranking
and its headquarters-city verification gate.

## Changes

- Routes education, healthcare, and similar non-ranking count/list requests to
  the normal model even when a message also mentions the private-enterprise
  ranking. This covers questions such as `武汉的本科院校有多少个，前十的分别是`.
- Recognizes a headquarters-city shorthand only at the beginning of a query or
  directly after an explicit ranking prefix. It no longer scans arbitrary
  sentence fragments and mistakes a noun such as `院校` for a city.
- Preserves explicit city questions such as `2026中国民营企业500强里，杭州有多少家`;
  they remain gated until all 500 headquarters are independently verified.

## Verification

- Covers the reported university question with and without an incidental
  ranking mention, a prior ranking answer, and explicit city-count shorthands.
- Runs the full Node 22 test suite, admin visual smoke test, and Windows/Linux
  release package verification before deployment.

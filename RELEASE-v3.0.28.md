# UBot V3.0.28

V3.0.28 strengthens the headquarters-city research gate for the 2026 Chinese
private-enterprise top 500. Province and enterprise-rank queries remain
available to every enabled group; city totals and city lists remain closed
until all 500 headquarters records have independently auditable evidence.

## Changes

- Moves headquarters-city research into a separate, versioned evidence ledger
  bound to the immutable 500-row ranking checksum and a local evidence
  archive.
- Requires each city record to carry its rank, exact enterprise name,
  ranking-row hash, entity-match note, standardized city, enterprise or
  government evidence, source and claim dates, retrieval date, source-content
  hash, and claim text.
- Rejects invalid dates, non-HTTPS or placeholder evidence URLs, missing or
  altered evidence manifests, duplicate evidence reuse, incomplete `complete`
  ledgers, and inline city fields in the primary ranking data.
- Requires a deployment-pinned Ed25519 reviewer key and a matching signature
  over the completed ledger plus evidence-archive checksum. The signing
  private key remains offline; self-consistent JSON alone cannot open city
  statistics.
- Verifies a completed ledger against the same public key in local packaging,
  GitHub Actions, and the production deployer before services are stopped.
- Projects the source that supports the displayed headquarters date, and
  rejects IP-literal, local, reserved, and placeholder evidence URLs.
- Keeps partial research private: no city field is projected into bot answers
  or the read-only backend list until the ledger is complete at 500/500.
- Adds backend audit metadata for the ledger status, freeze date, ranking and
  evidence checksums, while preserving the existing group FAQ editor.
- Includes both headquarters-ledger files in Windows and Linux release assets,
  and loads the ledger during release-artifact verification.

## Verification

- Covers partial-data non-disclosure, complete signed 500-row city enablement,
  cross-province headquarters, incomplete-ledger rejection, invalid evidence
  dates and URLs, evidence-archive and signature tampering.
- Runs the full Node 22 suite, admin smoke test, and cross-platform release
  packaging checks before deployment.

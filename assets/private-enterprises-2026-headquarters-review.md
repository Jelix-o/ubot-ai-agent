# 2026 Chinese private-enterprise top 500: headquarters research ledger

- Ledger schema: `assets/private-enterprises-2026-headquarters.json`, schema version 1.
- Ranking-row checksum: `bbe2ef2c1aa564e63b798e0d51ee8c776b447fee4c1fb7db8e1e9b6167445e08`.
- Frozen date: 2026-09-22, the ranking publication date.
- Current status: `in_progress`; verified coverage: 0 of 500.

The ranking only publishes a province field. Headquarters city is an independent
research field and is deliberately held in a separate, checksum-bound ledger.
Each record must bind the rank, exact enterprise name, and immutable ranking-row
hash; give a standardized headquarters province and city; explain any entity
name mismatch; and retain a dated enterprise or government source.

An acceptable evidence record includes a stable evidence ID, source authority,
publisher, HTTPS URL, source publication date, headquarters claim date,
retrieval date, the source subject, and quoted claim. The corresponding entry
in `private-enterprises-2026-headquarters-evidence.json` contains a local,
immutable captured excerpt whose UTF-8 SHA-256 must equal the ledger field.
The capture must contain the cited subject, city, and claim text. The source and
claim dates must not be later than the frozen date. A registration address, a
company-name inference, or an undated commercial-directory entry is not
headquarters evidence.

`authority` and `publisher` are reviewer attestations rather than facts the
runtime can prove from a URL. Before signing, the independent reviewer must
verify that the cited HTTPS DNS domain is controlled by the stated enterprise
or government publisher, that the local capture faithfully reflects the cited
page, and that the source subject is the ranked enterprise (or the documented
group/subsidiary relationship). IP-literal, local, reserved, and placeholder
URLs are rejected by the runtime; a URL alone is never sufficient evidence.

The application validates the canonical research-row hash, a flattened evidence
manifest hash, and the independent local evidence-archive hash. City lookup is
enabled only when this ledger is explicitly `complete`, has exactly one valid
record for every rank 1 through 500, and has a valid Ed25519 completion
signature from the public key pinned outside the release asset. The signer
attests that every enterprise or government source and entity mapping was
reviewed under the stated protocol. Partial records are not projected into the
bot or the read-only backend listing. Cross-province headquarters are permitted
when the evidence supports them; the ranking province remains the original
published field.

This ledger currently has no entries. Do not report any city count or city
enterprise list until the full evidence review is complete.

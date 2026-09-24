# Private headquarters research workspace

`research/private/` is the local, non-production workspace for researching the
headquarters city of every enterprise in the 2026 Chinese private-enterprise
Top 500. Its manifests and captured source excerpts are ignored by Git and are
not part of the Windows/Linux release allow-lists. Only this description and
the empty directory marker are versioned.

The ranking's published province is not a headquarters-city fact. Do not infer
a city from an enterprise name, address, registration record, or ranking
province. Do not place preliminary cities, source URLs, captures, or reviewer
identity into `assets/private-enterprises-2026-headquarters*.json`.

## Start a private manifest

From the repository root, run:

```powershell
node scripts/private-enterprises-2026-headquarters-research.mjs seed
node scripts/private-enterprises-2026-headquarters-research.mjs validate
```

The first command deterministically creates
`research/private/private-enterprises-2026-headquarters-candidates.json` from
the checksum-verified primary ranking. It creates exactly 500 entries, each
bound to its rank, exact enterprise name, published ranking province, and
ranking-row SHA-256. Every entry starts as `unresearched` with `claim: null`.
It does not fetch the web or invent a city, publisher, URL, or capture.

The command refuses to write outside `research/private/`, refuses to overwrite
a non-identical manifest, and never writes a runtime asset. `research/private/`
must be a normal local directory rather than a symlink.

## Research and review

For a tentative claim, update its `reviewState` to `draft` and add a `claim`
object privately. A record becomes `approved_for_ledger` only when it has all
of these fields:

```json
{
  "entityMatch": "The exact ranked enterprise and source subject relationship",
  "headquarters": {
    "province": "Province or municipality",
    "city": "Headquarters city",
    "administrativeLevel": "prefecture",
    "asOf": "2026-09-22"
  },
  "source": {
    "evidenceId": "hq-2026-001",
    "authority": "enterprise",
    "publisher": "Verified enterprise or government publisher",
    "url": "https://publisher.example/path",
    "publishedOn": "2026-09-01",
    "claimAsOf": "2026-09-01",
    "retrievedOn": "2026-09-22",
    "sourceSubject": "Entity named on the source",
    "claimText": "Quoted source text that explicitly says the headquarters city",
    "entityRelationText": "Required quoted source relationship when sourceSubject differs from the ranked enterprise",
    "capturePath": "evidence/hq-2026-001.txt",
    "captureSha256": "sha256 of that exact UTF-8 capture"
  },
  "review": {
    "state": "approved",
    "independent": true,
    "reviewerId": "independent-reviewer-id",
    "reviewedOn": "2026-09-23",
    "publisherDomainVerified": true,
    "captureVerified": true,
    "entityMappingVerified": true,
    "headquartersClaimVerified": true,
    "attestation": "independently_verified_publisher_capture_entity_and_headquarters_claim"
  }
}
```

The example is a schema illustration only, not a source or a company fact.
Keep the source's minimal, dated text capture at the exact relative path under
`research/private/evidence/`. The capture must include the cited source subject
and quoted headquarters claim, and its UTF-8 SHA-256 must match. The claim
must be one original sentence/clause or one original table row that explicitly
binds the exact `sourceSubject`, a headquarters predicate, and the cited city;
do not assemble those facts from adjacent clauses or fields. The selected
source's `claimAsOf` must equal the headquarters `asOf`; both it and
`publishedOn` must be within the 365 calendar days ending on the frozen date.
When `sourceSubject` differs from the ranked enterprise, `entityRelationText`
must quote the source, name both entities, and establish the same entity via a
name-continuity expression such as `简称`, `即`, `原名`, `更名`, `曾用名`, or
`变更为`; it must appear verbatim in the capture. `旗下`, `子公司`, `控股`,
and `品牌` are not same-entity evidence and cannot transfer a headquarters
claim. The independent reviewer must explicitly confirm the publisher's domain
control, capture fidelity, entity mapping, and headquarters claim. A candidate
with a non-HTTPS/placeholder source URL, an absent or altered capture, stale
selected dates, an unsupported entity mapping, or no complete independent
review is rejected.

The canonical city may use only the same source-faithful aliases accepted by
the runtime: a city may omit a final `市`, and the fixed autonomous-prefecture
short forms are accepted. A shortened form must not be a prefix of a different
Han-character place name, so `杭州` cannot validate a `杭州湾` claim. Do not derive
broader aliases from a city name.

After a reviewed local edit, recompute the manifest checksum without changing
its review state:

```powershell
node scripts/private-enterprises-2026-headquarters-research.mjs seal
node scripts/private-enterprises-2026-headquarters-research.mjs validate
node scripts/private-enterprises-2026-headquarters-research.mjs validate --promotion
```

`validate --promotion` is a read-only gate. It requires all 500 records to be
`approved_for_ledger`, with a distinct source evidence ID, source/capture hash,
and dated independent reviewer attestation for every record. It never converts
the candidate manifest to the published ledger, never changes the ledger from
`in_progress`, and never enables city queries. A future ledger conversion still
requires the separate runtime-sidecar validation, immutable evidence archive,
and offline Ed25519 completion approval documented in
`assets/private-enterprises-2026-headquarters-review.md`.

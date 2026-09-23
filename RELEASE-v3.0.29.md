# UBot V3.0.29

V3.0.29 fixes a formal Linux deployment edge case in the GitHub Release API.
It does not alter the 2026 private-enterprise ranking or the headquarters-city
research gate introduced in V3.0.28.

## Changes

- Validates the final tagged Release metadata first, then retrieves the
  release-owned asset collection by its validated numeric Release ID.
- Handles GitHub's transient empty embedded asset arrays without accepting a
  separate or unverified download URL.
- Still requires the exact expected checksum asset URL and matching SHA-256
  manifest before extracting a release or stopping any service.

## Verification

- Covers the asset-list provenance path in the Linux deployment tests.
- Runs the full Node 22 suite, admin smoke test, and Windows/Linux release
  packaging verification before deployment.

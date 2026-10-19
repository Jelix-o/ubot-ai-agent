# Historical Release Reconstruction Control

This document governs the required reconstruction of GitHub Release metadata
for v3.0.18 through v3.0.44 after the credential incident is contained. It is
not a permission to rewrite shared history, publish a release, or expose old
release bodies.

## Safe Inventory

Run the local inventory only in a trusted checkout:

```bash
node scripts/run-node22.cjs scripts/historical-release-inventory.mjs
```

It writes an ignored `.codex_tmp/historical-release-inventory.json` containing
annotated-tag, commit, tree, package, and release-note object identities plus
body hashes, byte counts, heuristic privacy-rule counts, and named local
references of every Git object type. It never writes release bodies, assets,
credentials, or GitHub API requests. A nonzero privacy count means the body
must be handled in an access-controlled quarantine rather than copied into Git;
zero is not evidence that a body is safe.

## Required Sequence

1. Rotate the exposed provider credential and confirm issuer-side revocation.
2. Use the inventory as a lower-bound audit of currently named local refs. It
   inspects commit, tag, tree, and blob refs, including Codex turn-diff refs
   that ordinary `git log --all -- <path>` misses. It cannot prove coverage of
   reflogs, unreachable objects, other clones, backups, renamed copies, or
   external assets. The cleanup scope includes local and remote branches/tags,
   `refs/stash`, Codex snapshots and turn-diff refs, remote-tracking refs,
   linked worktree branches, reflogs, object packs, local backups, server
   backups, and release artifacts. The historical Release range does not limit
   credential cleanup: later descendant tags and branches must also be
   rewritten.
3. In an isolated mirror, export each historical release body and asset list to
   a restricted quarantine. Scan, redact, hash, and have the resulting body,
   asset names, and checksums independently approved. Do not place the raw
   exports in the repository or issue tracker.
4. Before force-pushing any historical tag, have a repository administrator
   disable GitHub Actions or every tag-triggered Release workflow. Each source
   tag from v3.0.18 through v3.0.44 embeds the old workflow with workflow-level
   `contents: write`, floating `@vN` Actions references, and no current secret
   scan or release gate. `UBOT_RELEASE_PIPELINE_ENABLED=false` protects only
   the new workflow, not those historical files.
5. Have a GitHub repository administrator perform the approved rewrite and
   force-push. Retire superseded tags and require every collaborator to
   re-clone. Verify no affected object remains reachable before normal release
   publication is re-enabled.
6. Recreate historical GitHub Releases from the approved mapping. The normal
   Release workflow must not be repurposed for historical rebuilds: each
   cleaned tag needs an independently approved current release-note marker and
   artifact mapping. Use a separately reviewed, administrator-operated
   reconstruction procedure that consumes only the approved quarantine mapping.

## Current State

The current local helper is intentionally dry-run only, and the automated
Release workflow is fail-closed behind the repository variable
`UBOT_RELEASE_PIPELINE_ENABLED`. A manual dispatch defaults to verification;
publication additionally requires `publish=true` and a protected
`production-release` GitHub Environment configured by a repository
administrator. Neither is authorization to bypass the above sequence. The
v3.0.18--v3.0.44 bodies and asset mappings remain pending secure export and
approval.

Earlier V1/V2 audit and release documents are also subject to an explicit
archive-or-retire decision. Do not silently delete them until their retention
owner, storage location, access controls, and disposal record are confirmed.

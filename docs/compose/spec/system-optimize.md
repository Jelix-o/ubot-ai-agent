---
feature: system-optimize
status: delivered
updated: 2026-02-13
branch: codex/system-optimize
commits: c0b1b34..(see branch HEAD)
---

# System Optimize

## Report

**What was built** — Completed the unfinished “remove TTS + simplify admin auth” direction into a verifiable 3.0.19 baseline: production and tests align on password-only admin login (min 12 characters), retired voice/TTS/TOTP surfaces, and QQ group owner/admin auto in-group powers documented to match code. Fixed admin console logic (role default, load errors, reauth/password error UX, meme library super-admin-only), cleaned thinking-chain microcopy, and rewrote README/COMMANDS/ADMIN-RECOVERY/OPERATIONS/MIGRATION/RELEASE for the new model.

**Verification** —
- `node scripts/run-node22.cjs scripts/build.cjs` → PASS
- `node scripts/run-node22.cjs scripts/test.cjs` → 628 tests, 626 pass, 0 fail, 2 skipped
- `node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs` → `ADMIN_SMOKE_OK`
- Fresh reviewer: no critical findings; remaining non-critical items addressed (401 business errors, GroupsView load toast, ops docs TOTP wording, memes superOnly, invalid_password HTTP 400)

**Journey log** —
1. Main held an unfinished ~3.7k-line deletion of TTS/MFA; tests and smoke still expected old contracts, so build was red until tests were rewritten to current behavior.
2. Password policy `MIN_PASSWORD_LENGTH=12` must cover bootstrap/invite/change/reset together; otherwise empty-table bootstrap can create weak accounts.
3. Frontend `api()` treating every HTTP 401 as session expiry breaks wrong-password UX; business codes need non-redirect paths.
4. Product decision: QQ owner/admin auto in-group admin is intentional; docs had to follow code rather than reverse.
5. Meme library GET was accidentally reachable by group_admin; tightened to `requireSuperAdmin` + superOnly route.

## [S1] Problem

Unfinished TTS retirement + admin auth simplification left build/tests/docs inconsistent; admin UX and security docs drifted from implementation.

## [S2] Design

- Auth: password login + invite + reauth; no TOTP; password ≥ 12 on create/change/reset/bootstrap.
- Permissions: QQ owner/admin auto in-group commands only; backend accounts own console auth.
- Voice retired at API/data layers; docs and tests match.
- Admin UI: simple confident copy, visible load errors, no thinking-chain microcopy.

## [S3] Out of Scope

No TOTP reintroduction; no merge of sibling feature branches; no production deploy/push unless requested.

## Tasks

- [x] T6: 构建/测试/冒烟对齐 — acceptance: build/test/smoke green (covers: S2)
- [x] T7: 业务逻辑修复 — acceptance: password policy + QQ docs + meme gate (covers: S2)
- [x] T8: 后台逻辑修复 — acceptance: role/readonly/errors/reauth UX (covers: S2)
- [x] T9: 文档与发布 — acceptance: README/COMMANDS/ADMIN-RECOVERY/OPS/MIGRATION/RELEASE (covers: S2)
- [x] T10: 后台 UI — acceptance: unified clean UI, no thinking-chain microcopy (covers: S2; depends: T6)

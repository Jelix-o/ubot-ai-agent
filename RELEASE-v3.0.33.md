# UBot V3.0.33

Redesigns the administration console and adds auditable cross-group operations
and model-usage analytics.

## Changes

- Organizes all existing admin pages into six workspaces with shared responsive
  navigation, light/dark themes, URL-backed filters, and consistent dialogs,
  tables, drawers, and save feedback.
- Splits group and system settings into focused sections and improves member,
  task, audit, media, and configuration review workflows.
- Adds cross-group configuration copy and content batch operations with
  permission checks, expiring previews, revision checks, durable task results,
  cancellation, and interruption recovery.
- Records model requests from the release onward without storing prompts or
  generated content; adds scoped analytics for usage, latency, images, and
  upstream-reported currency-qualified charges.
- Adds additive SQLite migrations for model analytics and durable bulk tasks.

## Verification

- Full Node 22 test suite, TypeScript check, and admin visual smoke test.
- Browser checks for all admin routes, workspace navigation, light and dark
  themes, responsive layouts, bulk previews, and URL-restored analytics filters.
- Linux release package verification and production deployment smoke checks.

# UBot V3.0.32

Knowledge sources now require an explicit command or a named factual query.
Ordinary conversation no longer receives ranking or FAQ tools, so questions
such as `南京的本科院校有哪些` cannot be captured by an earlier ranking discussion.

## Changes

- Adds `#民营企业排名` for the shared 2026 ranking and `#群知识库` for the current
  group's FAQ pack. Keeps the existing administrator status command `#知识库`.
- Accepts factual queries naming `民营企业排名` or `2026中国民营企业500强`.
  Bare ranking questions and discussions about source names stay in normal chat.
- Restricts each selected query to its source. Unsupported requests and missing
  matches receive that source's scope or no-result response, with no fallback
  to another source. Ranking answers keep batching and the verified-city gate.
- Allows follow-ups for the same sender in the same group and conversation chain
  for ten minutes, while preserving mention/reply policies. New topics, source
  switches, unrelated reply chains, expiry, and restart end the continuation.
- Adds command settings to the knowledge admin page. Super administrators own
  the global ranking command; group administrators manage their group's FAQ
  command. Existing FAQ editing permissions remain unchanged.
- Stores bindings separately in additive SQLite migration 16. Rejects malformed
  commands, overlapping source commands, and conflicts with built-in commands,
  including when editing system commands. Existing installations use defaults.

## Verification

- Full test suite, backend admin smoke test, and browser checks of command
  validation, persistence, ranking access, and narrow-screen layout.
- Regression coverage for source isolation, group boundaries, command changes,
  permissions, migrations, contextual follow-ups, expiry, and ordinary chat.
- Windows/Linux release package verification and official release deployment.

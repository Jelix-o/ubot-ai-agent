# UBot Command And Behavior Contract

This retained document records the supported group-facing behavior. The current
admin command configuration and the in-group `#帮助` response remain the
runtime authority; this file intentionally contains no account identifiers,
credentials, or production conversation data.

## Conversation And Memory

- `@bot <message>` and a reply to a confirmed bot response may start a normal
  conversation when the group is enabled and not muted.
- `#帮助`, `#功能`, and `#命令` show capabilities available to the
  caller. Administrators can rename or disable configurable commands in the
  admin console, subject to server-side permission floors.
- `#记忆 <内容>` saves only the caller's explicit memory in the current
  group. Natural-language "remember" requests are equivalent only when they
  explicitly address the bot or reply to a confirmed bot message.
- A member who has opted out of memory does not receive new personal memories
  and does not have prior personal memory used in replies. Do not use the
  command path to store passwords, API keys, tokens, addresses, or other
  sensitive material.

## Models And Generation

- `#模型`, `#模型 状态`, and `#模型 列表` show the effective model.
  Only a super administrator can set a group exception or restore the global
  route with `#模型 跟随`.
- The production reply default is `sol`. `gemini` may be enabled only as an
  explicit fallback after a separately verified credential rotation; it is not
  the default reply model.
- `#画图 <提示词>` and `#生图 <提示词>` generate one image when the group,
  caller permission, mute state, blacklist, and cooldown permit it. Failed
  attempts do not consume a successful-generation cooldown.
- `#网页 <需求>` and `#html <需求>` publish an isolated static preview.
  Preview content is served from the separate preview origin and never shares
  admin cookies or API routes.

## BT Search

`#bt <keywords> [anime|movie|adult]` and `/bt` run the preserved BT search
capability. It is intentionally isolated from chat context and does not invoke
the conversation model. Results are returned as one merged-forward card when
the transport supports it; an explicitly rejected forward request receives one
short fallback notice, while ambiguous delivery is never automatically resent.

- Empty input shows concise help; `#bt --help` shows all supported options.
- `--fast`, `--full`, `--detail`, `--source`, `--timeout`, `--limit`,
  `--no-cache`, `--no-deep`, `--json`, and `--debug` retain their current
  parser contracts. The backend validates every value before it reaches a
  provider adapter.
- Searches use a single active worker slot and a bounded queue. Cached results,
  individual provider failure, timeout, verification-page responses, and
  unavailable dependencies have distinct user-facing outcomes.
- Adult-classified results carry the mandatory adult-content notice and are
  eligible for the configured silent recall only after a confirmed outer
  delivery receipt. They are for adults only and must follow local law and the
  approved content policy.

The engines, Python dependencies, browser state, proxy setting, cache, and
runtime ownership model are documented in [assets/bt/README.md](assets/bt/README.md).
This feature remains retained pending the product, compliance, and operational
ownership decision recorded in the desktop governance checklist.

## Retired Behavior

- `#admin` and legacy in-group administrator-list mutation are retired. Web
  administration uses independent accounts; in-group authority follows the
  configured role and current group role only.
- Voice and TTS commands are retired.
- Roast mode is retired. Runtime configuration has no roast user-list field,
  and legacy API writes receive `410 roast_mode_retired` rather than silently
  changing group behavior.

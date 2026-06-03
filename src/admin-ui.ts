export const ADMIN_CSS = `
:root { color-scheme: light; --ink: oklch(22% 0.012 238); --muted: oklch(50% 0.012 238); --line: oklch(86% 0.012 238); --paper: oklch(98% 0.006 238); --panel: oklch(96% 0.008 238); --accent: oklch(55% 0.16 168); --accent-soft: oklch(92% 0.045 168); --danger: oklch(52% 0.16 28); --warn: oklch(78% 0.13 78); }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 Inter, "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--paper); }
button, input, select, textarea { font: inherit; }
button { min-height: 36px; border: 1px solid var(--accent); background: var(--accent); color: oklch(98% 0.006 168); padding: 0 14px; border-radius: 6px; cursor: pointer; }
button.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
button.danger { background: var(--danger); border-color: var(--danger); }
button:disabled { opacity: .58; cursor: wait; }
.login-page { min-height: 100vh; display: grid; place-items: center; }
.login-shell { width: min(420px, calc(100vw - 32px)); }
.login-panel { border: 1px solid var(--line); background: var(--panel); padding: 28px; border-radius: 8px; }
.eyebrow { margin: 0 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-size: 12px; }
h1, h2, h3 { margin: 0; letter-spacing: 0; }
h1 { font-size: 28px; }
h2 { font-size: 18px; margin-bottom: 14px; }
h3 { font-size: 15px; }
.stack { display: grid; gap: 14px; margin-top: 22px; }
label { display: grid; gap: 6px; color: var(--muted); }
input, select, textarea { min-height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: oklch(99% 0.004 238); color: var(--ink); }
textarea { min-height: 72px; padding: 8px 10px; resize: vertical; }
.message { min-height: 20px; color: var(--danger); }
.toast { position: fixed; right: 18px; bottom: 18px; max-width: min(420px, calc(100vw - 36px)); border: 1px solid var(--line); border-radius: 8px; background: oklch(99% 0.004 238); box-shadow: 0 12px 32px oklch(22% 0.012 238 / .16); padding: 10px 12px; color: var(--ink); z-index: 10; }
.toast.error { border-color: oklch(78% 0.09 28); color: var(--danger); }
.toast.ok { border-color: oklch(82% 0.07 168); color: oklch(34% 0.12 168); }
.app-shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
aside { border-right: 1px solid var(--line); background: oklch(94% 0.012 238); padding: 18px; display: grid; grid-template-rows: auto 1fr auto; gap: 24px; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand span { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 6px; background: var(--accent-soft); color: oklch(38% 0.14 168); font-weight: 700; }
nav { display: grid; align-content: start; gap: 8px; }
nav button { text-align: left; background: transparent; color: var(--ink); border-color: transparent; }
nav button.active { background: var(--accent-soft); border-color: oklch(82% 0.07 168); }
main { padding: 24px; min-width: 0; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
header select { width: 180px; }
.metric-row { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 12px; margin-bottom: 14px; }
.metric-row div { border: 1px solid var(--line); background: var(--panel); padding: 18px; border-radius: 8px; display: grid; gap: 4px; }
.metric-row b { font-size: 26px; line-height: 1; }
.metric-row span { color: var(--muted); }
.workbench-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr); gap: 14px; }
.compact-list { display: grid; gap: 8px; }
.compact-row { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: grid; gap: 4px; background: oklch(99% 0.004 238); }
.compact-row b { overflow-wrap: anywhere; }
.quick-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.panel { border: 1px solid var(--line); background: oklch(99% 0.004 238); padding: 18px; border-radius: 8px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
.toolbar input { width: min(280px, 100%); }
.filter-summary { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin: -4px 0 14px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.filter-summary > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.filter-summary strong { font-size: 13px; }
.filter-summary span { display: inline-flex; flex-wrap: wrap; gap: 6px; color: var(--muted); }
.filter-chip { min-height: 24px; align-items: center; padding: 0 8px; border: 1px solid var(--line); border-radius: 999px; background: oklch(99% 0.004 238); font-size: 12px; overflow-wrap: anywhere; }
.filter-chip b { margin-right: 4px; color: var(--ink); }
.filter-chip.muted { border-color: transparent; background: transparent; padding-inline: 0; }
.hint-row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.hint-row span { color: var(--muted); overflow-wrap: anywhere; }
.list { display: grid; gap: 10px; }
article { border: 1px solid var(--line); border-radius: 8px; padding: 14px; display: grid; gap: 10px; }
article span { color: var(--muted); overflow-wrap: anywhere; }
.row-head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; }
.row-head label { min-width: 56px; padding-top: 2px; }
.row-head h3 { margin-bottom: 3px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.secondary-actions { padding-top: 2px; }
.detail-block { display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.grid-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 8px; margin-bottom: 14px; align-items: start; }
.candidate-form { display: grid; grid-template-columns: 140px minmax(160px, 1fr) minmax(160px, 1.2fr) 170px; gap: 8px; align-items: start; }
.candidate-help { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--muted); font-size: 13px; }
.candidate-help b { color: var(--ink); }
.memory-form { display: grid; grid-template-columns: 140px 190px minmax(160px, 1fr) 110px 120px; gap: 8px; align-items: start; }
.memory-form textarea { grid-column: 3 / span 3; }
.owner-field { display: grid; gap: 4px; min-width: 190px; }
.owner-field span { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.evidence { border: 1px solid var(--line); background: var(--panel); border-radius: 6px; padding: 10px; color: var(--muted); overflow-wrap: anywhere; }
.evidence b { color: var(--ink); }
.evidence summary { cursor: pointer; display: grid; grid-template-columns: auto minmax(180px, max-content) minmax(0, 1fr); gap: 8px; align-items: baseline; }
.evidence summary span, .evidence summary em { color: var(--muted); font-style: normal; min-width: 0; }
.evidence summary em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evidence-body { margin-top: 8px; display: grid; gap: 6px; max-height: 220px; overflow: auto; border-top: 1px solid var(--line); padding-top: 8px; }
.evidence-body p { margin: 0; color: var(--ink); }
.member-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.member-meta, .meta { color: var(--muted); overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border-radius: 999px; background: var(--accent-soft); color: oklch(34% 0.12 168); font-size: 12px; }
.badge.warn { background: oklch(94% 0.06 78); color: oklch(42% 0.09 78); }
.group-block { display: grid; gap: 8px; margin-bottom: 18px; }
.inline-editor { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; background: var(--panel); }
.inline-editor summary { cursor: pointer; font-weight: 600; }
.inline-editor form { margin-top: 10px; margin-bottom: 0; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); }
.pagination-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 860px) { .app-shell { grid-template-columns: 1fr; } aside { position: static; border-right: 0; border-bottom: 1px solid var(--line); } nav { grid-template-columns: repeat(2, 1fr); } .metric-row, .workbench-grid, .grid-form, .candidate-form, .memory-form, .evidence summary { grid-template-columns: 1fr; } .memory-form textarea { grid-column: auto; } header { align-items: start; flex-direction: column; } header select { width: 100%; } }
`;


export const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UBot 后台</title>
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="login-page">
  <main class="login-shell">
    <section class="login-panel">
      <p class="eyebrow">UBot</p>
      <h1>后台登录</h1>
      <form id="loginForm" class="stack">
        <label>账号<input name="username" autocomplete="username" required></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">登录</button>
        <p id="message" class="message"></p>
      </form>
    </section>
  </main>
  <script src="/admin-login.js" defer></script>
</body>
</html>`;

export const ADMIN_APP_HTML_V2 = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UBot 后台</title>
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <div class="app-shell">
    <aside>
      <div class="brand"><span>UB</span><strong>UBot 后台</strong></div>
      <nav>
        <button data-view="overview" class="active">总览</button>
        <button data-view="groups">群配置</button>
        <button data-view="members">成员管理</button>
        <button data-view="candidates">候选记忆</button>
        <button data-view="memories">长期记忆</button>
        <button data-view="knowledge">知识库</button>
        <button data-view="health">健康状态</button>
      </nav>
      <button id="logout" class="ghost">退出登录</button>
    </aside>
    <main>
      <header>
        <div>
          <p class="eyebrow">运维控制台</p>
          <h1 id="viewTitle">总览</h1>
        </div>
        <select id="groupFilter"></select>
      </header>
      <section id="content"></section>
      <div id="toast" class="toast" hidden></div>
    </main>
  </div>
  <script src="/admin-app.js" defer></script>
</body>
</html>`;

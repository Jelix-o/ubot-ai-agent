export const ADMIN_CSS = `
:root {
  color-scheme: light;
  --bg: oklch(97.5% 0.008 220);
  --surface: oklch(99% 0.004 220);
  --surface-2: oklch(96% 0.01 220);
  --surface-3: oklch(91.5% 0.014 220);
  --ink: oklch(23% 0.018 230);
  --muted: oklch(52% 0.018 230);
  --line: oklch(84% 0.016 225);
  --accent: oklch(52% 0.145 171);
  --accent-ink: oklch(98% 0.006 171);
  --accent-soft: oklch(91% 0.045 171);
  --danger: oklch(54% 0.16 25);
  --warn: oklch(66% 0.14 75);
  --success: oklch(54% 0.13 151);
  --shadow: 0 14px 38px oklch(23% 0.018 230 / .12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: oklch(20% 0.012 230);
  --surface: oklch(25% 0.014 230);
  --surface-2: oklch(29% 0.016 230);
  --surface-3: oklch(34% 0.016 230);
  --ink: oklch(92% 0.008 220);
  --muted: oklch(70% 0.014 220);
  --line: oklch(39% 0.018 230);
  --accent: oklch(68% 0.12 171);
  --accent-ink: oklch(18% 0.012 171);
  --accent-soft: oklch(34% 0.045 171);
  --danger: oklch(70% 0.13 25);
  --warn: oklch(74% 0.12 75);
  --success: oklch(70% 0.11 151);
  --shadow: 0 18px 44px oklch(10% 0.01 230 / .36);
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; font: 14px/1.45 "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--bg); }
button, input, select, textarea { font: inherit; }
button { min-height: 34px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); padding: 0 12px; border-radius: 7px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
button:hover { filter: brightness(.98); }
button.ghost { background: var(--surface); color: var(--ink); border-color: var(--line); }
button.danger { background: var(--danger); border-color: var(--danger); color: oklch(98% 0.006 25); }
button:disabled { opacity: .58; cursor: wait; }
input, select, textarea { min-height: 34px; border: 1px solid var(--line); border-radius: 7px; padding: 0 10px; background: var(--surface); color: var(--ink); min-width: 0; }
input[type="checkbox"] { width: 16px; height: 16px; min-height: 0; padding: 0; accent-color: var(--accent); }
textarea { min-height: 76px; padding: 9px 10px; resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid color-mix(in oklch, var(--accent), transparent 58%); outline-offset: 2px; }
label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
h1, h2, h3, p { margin: 0; letter-spacing: 0; }
h1 { font-size: 24px; line-height: 1.15; }
h2 { font-size: 17px; line-height: 1.25; }
h3 { font-size: 15px; line-height: 1.3; }
.eyebrow { margin: 0; color: var(--muted); font-size: 12px; }
.login-page { min-height: 100vh; display: grid; place-items: center; padding: 22px; }
.login-shell { width: min(420px, 100%); }
.login-panel { border: 1px solid var(--line); background: var(--surface); padding: 28px; border-radius: 8px; box-shadow: var(--shadow); }
.stack { display: grid; gap: 14px; margin-top: 22px; }
.message { min-height: 20px; color: var(--danger); }
.toast { position: fixed; right: 18px; bottom: 18px; max-width: min(420px, calc(100vw - 36px)); border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); padding: 10px 12px; color: var(--ink); z-index: 10; }
.toast.error { border-color: color-mix(in oklch, var(--danger), var(--line) 52%); color: var(--danger); }
.toast.ok { border-color: color-mix(in oklch, var(--success), var(--line) 58%); color: var(--success); }
.app-shell { min-height: 100vh; display: grid; grid-template-columns: 252px minmax(0, 1fr); }
aside { border-right: 1px solid var(--line); background: var(--surface-2); padding: 18px; display: grid; grid-template-rows: auto 1fr auto; gap: 22px; }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand span { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-weight: 800; }
.brand div { display: grid; gap: 2px; min-width: 0; }
.brand strong { overflow-wrap: anywhere; }
.brand small { color: var(--muted); font-size: 12px; }
nav { display: grid; align-content: start; gap: 5px; }
nav button { width: 100%; justify-content: flex-start; text-align: left; background: transparent; color: var(--ink); border-color: transparent; }
nav button.active { background: var(--surface); border-color: var(--line); color: var(--ink); box-shadow: 0 1px 0 oklch(100% 0 0 / .28) inset; }
.side-footer { display: grid; gap: 10px; }
.theme-control { display: inline-grid; grid-template-columns: repeat(3, 1fr); gap: 2px; border: 1px solid var(--line); border-radius: 8px; padding: 2px; background: var(--surface); }
.theme-control button { min-height: 28px; border: 0; background: transparent; color: var(--muted); padding: 0 8px; border-radius: 6px; }
.theme-control button.active { background: var(--accent-soft); color: var(--accent); }
main { padding: 22px; min-width: 0; }
header { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-bottom: 18px; }
header > div { display: grid; gap: 4px; min-width: 0; }
.header-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
header select { width: 180px; }
.metric-row { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; margin-bottom: 12px; }
.metric-row div { border: 1px solid var(--line); background: var(--surface); padding: 14px; border-radius: 8px; display: grid; gap: 3px; }
.metric-row b { font-size: 25px; line-height: 1; }
.metric-row span { color: var(--muted); }
.workbench-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, .75fr); gap: 12px; }
.panel { border: 1px solid var(--line); background: var(--surface); padding: 16px; border-radius: 8px; min-width: 0; }
.panel h2 { margin-bottom: 12px; }
.panel > .toolbar:first-child h2 { margin-bottom: 0; }
.page-loading { margin: -4px 0 12px; padding: 8px 10px; border: 1px solid color-mix(in oklch, var(--accent), var(--line) 60%); border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 13px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
.toolbar input { width: min(280px, 100%); }
.toolbar h2 { margin-right: auto; }
.compact-list, .list { display: grid; gap: 9px; }
.compact-row, article { border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 9px; background: var(--surface); min-width: 0; }
.compact-row { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
.compact-row span:last-child { color: var(--muted); overflow-wrap: anywhere; }
article span { color: var(--muted); overflow-wrap: anywhere; }
.filter-summary { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin: -2px 0 12px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.filter-summary > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.filter-summary strong { font-size: 13px; }
.filter-summary span { display: inline-flex; flex-wrap: wrap; gap: 6px; color: var(--muted); }
.filter-chip, .badge { min-height: 22px; display: inline-flex; align-items: center; padding: 0 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.filter-chip b { margin-right: 4px; color: var(--ink); }
.filter-chip.muted { border-color: transparent; background: transparent; padding-inline: 0; }
.badge { color: var(--accent); border-color: color-mix(in oklch, var(--accent), var(--line) 60%); background: var(--accent-soft); }
.badge.warn { color: var(--warn); border-color: color-mix(in oklch, var(--warn), var(--line) 60%); background: transparent; }
.hint-row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.hint-row span { color: var(--muted); overflow-wrap: anywhere; }
.row-head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; }
.row-head label { min-width: 56px; padding-top: 2px; }
.row-head h3 { margin-bottom: 3px; }
.actions, .secondary-actions, .quick-actions, .pagination-controls, .candidate-help { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.candidate-help { gap: 6px 12px; color: var(--muted); font-size: 13px; }
.candidate-help b { color: var(--ink); }
.detail-block { display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.grid-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 8px; margin-bottom: 12px; align-items: start; }
.candidate-form { display: grid; grid-template-columns: 140px minmax(160px, 1fr) minmax(160px, 1.2fr) 170px; gap: 8px; align-items: start; }
.memory-form { display: grid; grid-template-columns: 140px 190px minmax(160px, 1fr) 110px 120px; gap: 8px; align-items: start; }
.memory-form textarea { grid-column: 3 / span 3; }
.owner-field { display: grid; gap: 4px; min-width: 190px; }
.owner-field span, .member-meta, .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.evidence { border: 1px solid var(--line); background: var(--surface-2); border-radius: 7px; padding: 10px; color: var(--muted); overflow-wrap: anywhere; }
.evidence b { color: var(--ink); }
.evidence summary { cursor: pointer; display: grid; grid-template-columns: auto minmax(180px, max-content) minmax(0, 1fr); gap: 8px; align-items: baseline; }
.evidence summary span, .evidence summary em { color: var(--muted); font-style: normal; min-width: 0; }
.evidence summary em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evidence-body { margin-top: 8px; display: grid; gap: 6px; max-height: 220px; overflow: auto; border-top: 1px solid var(--line); padding-top: 8px; }
.evidence-body p { color: var(--ink); }
.member-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 9px; }
.group-block { display: grid; gap: 8px; margin-bottom: 18px; }
.settings-form { display: grid; gap: 14px; }
.settings-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; align-items: start; }
.settings-grid label { min-width: 0; }
.settings-grid label:has(> input[type="checkbox"]) { display: flex; align-items: center; min-height: 34px; gap: 8px; color: var(--ink); padding-top: 21px; }
.settings-grid textarea { min-height: 96px; }
.settings-wide { grid-column: 1 / -1; }
.health-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.health-card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--surface); display: grid; gap: 8px; }
.health-card.ok { border-color: color-mix(in oklch, var(--success), var(--line) 55%); }
.health-card.bad { border-color: color-mix(in oklch, var(--danger), var(--line) 55%); }
.health-card p { color: var(--muted); overflow-wrap: anywhere; }
.inline-editor { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; background: var(--surface-2); }
.inline-editor summary { cursor: pointer; font-weight: 600; }
.inline-editor form { margin-top: 10px; margin-bottom: 0; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
@media (max-width: 860px) {
  .app-shell { grid-template-columns: 1fr; }
  aside { position: static; grid-template-rows: auto auto auto; border-right: 0; border-bottom: 1px solid var(--line); }
  nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  main { padding: 20px; }
  header { align-items: start; flex-direction: column; }
  .header-actions, header select { width: 100%; }
  .header-actions { justify-content: stretch; }
  .header-actions > * { flex: 1 1 150px; }
  .metric-row, .workbench-grid, .grid-form, .candidate-form, .memory-form, .settings-grid, .health-grid, .evidence summary { grid-template-columns: 1fr; }
  .memory-form textarea, .settings-wide { grid-column: auto; }
  .toolbar { align-items: stretch; }
  .toolbar > * { max-width: 100%; }
  .toolbar input, .toolbar select, .toolbar button { width: 100%; }
  .toolbar h2 { width: 100%; margin-right: 0; }
  .member-grid { grid-template-columns: 1fr; }
  .compact-row { grid-template-columns: 1fr; }
}
`;

const THEME_BOOTSTRAP = `<script>
(() => {
  const stored = localStorage.getItem("ubot-admin-theme") || "system";
  const resolved = stored === "system" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : stored === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = stored;
})();
</script>`;

export const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UBot 后台</title>
  ${THEME_BOOTSTRAP}
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
  ${THEME_BOOTSTRAP}
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <div class="app-shell">
    <aside>
      <div class="brand"><span>UB</span><div><strong>UBot 后台</strong><small>群聊运维控制台</small></div></div>
      <nav>
        <button data-view="overview" class="active">总览</button>
        <button data-view="groups">群配置</button>
        <button data-view="members">成员管理</button>
        <button data-view="candidates">候选记忆</button>
        <button data-view="memories">长期记忆</button>
        <button data-view="knowledge">知识库</button>
        <button data-view="health">健康状态</button>
      </nav>
      <div class="side-footer">
        <div class="theme-control" aria-label="主题切换">
          <button type="button" data-theme-option="light">浅色</button>
          <button type="button" data-theme-option="dark">深色</button>
          <button type="button" data-theme-option="system">系统</button>
        </div>
        <button id="logout" class="ghost">退出登录</button>
      </div>
    </aside>
    <main>
      <header>
        <div>
          <p class="eyebrow">运维控制台</p>
          <h1 id="viewTitle">总览</h1>
        </div>
        <div class="header-actions">
          <select id="groupFilter"></select>
        </div>
      </header>
      <section id="content"></section>
      <div id="toast" class="toast" hidden></div>
    </main>
  </div>
  <script src="/admin-app.js" defer></script>
</body>
</html>`;

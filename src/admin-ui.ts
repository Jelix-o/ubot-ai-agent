export const ADMIN_CSS = `
:root {
  color-scheme: light;
  --bg: oklch(97.8% 0.009 205);
  --bg-soft: oklch(95.8% 0.014 194);
  --surface: oklch(99.2% 0.004 205);
  --surface-2: oklch(97.2% 0.008 205);
  --surface-3: oklch(93.5% 0.012 205);
  --ink: oklch(21% 0.025 236);
  --muted: oklch(53% 0.025 230);
  --subtle: oklch(67% 0.021 225);
  --line: oklch(86% 0.018 215);
  --line-strong: oklch(78% 0.024 215);
  --accent: oklch(61% 0.155 164);
  --accent-strong: oklch(52% 0.16 164);
  --accent-ink: oklch(98% 0.006 164);
  --accent-soft: oklch(92.5% 0.045 164);
  --blue: oklch(60% 0.15 252);
  --blue-soft: oklch(93.5% 0.035 252);
  --orange: oklch(70% 0.145 62);
  --orange-soft: oklch(95% 0.042 62);
  --purple: oklch(68% 0.145 292);
  --purple-soft: oklch(94.5% 0.04 292);
  --danger: oklch(58% 0.16 24);
  --danger-soft: oklch(95% 0.035 24);
  --warn: oklch(70% 0.13 70);
  --warn-soft: oklch(95% 0.04 70);
  --success: oklch(58% 0.14 155);
  --success-soft: oklch(93% 0.045 155);
  --shadow: 0 18px 46px oklch(33% 0.04 230 / .09);
  --shadow-soft: 0 8px 24px oklch(33% 0.04 230 / .055);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: oklch(20% 0.014 225);
  --bg-soft: oklch(24% 0.018 225);
  --surface: oklch(26% 0.016 225);
  --surface-2: oklch(30% 0.018 225);
  --surface-3: oklch(35% 0.02 225);
  --ink: oklch(92% 0.008 210);
  --muted: oklch(72% 0.015 214);
  --subtle: oklch(61% 0.018 214);
  --line: oklch(39% 0.022 225);
  --line-strong: oklch(48% 0.025 225);
  --accent: oklch(70% 0.13 164);
  --accent-strong: oklch(63% 0.145 164);
  --accent-ink: oklch(18% 0.018 164);
  --accent-soft: oklch(34% 0.052 164);
  --blue: oklch(72% 0.11 252);
  --blue-soft: oklch(34% 0.045 252);
  --orange: oklch(77% 0.12 62);
  --orange-soft: oklch(36% 0.05 62);
  --purple: oklch(77% 0.115 292);
  --purple-soft: oklch(36% 0.045 292);
  --danger: oklch(72% 0.12 24);
  --danger-soft: oklch(35% 0.05 24);
  --warn: oklch(78% 0.1 70);
  --warn-soft: oklch(36% 0.045 70);
  --success: oklch(73% 0.11 155);
  --success-soft: oklch(35% 0.048 155);
  --shadow: 0 22px 54px oklch(12% 0.015 230 / .38);
  --shadow-soft: 0 10px 28px oklch(12% 0.015 230 / .3);
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--bg); }
body {
  margin: 0;
  min-height: 100vh;
  font: 14px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at 8% 92%, color-mix(in oklch, var(--accent-soft), transparent 34%), transparent 30%),
    linear-gradient(135deg, var(--bg) 0%, var(--surface-2) 44%, var(--bg) 100%);
}
button, input, select, textarea { font: inherit; }
button {
  min-height: 36px;
  border: 1px solid var(--accent-strong);
  background: linear-gradient(180deg, var(--accent), var(--accent-strong));
  color: var(--accent-ink);
  padding: 0 14px;
  border-radius: 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  white-space: nowrap;
  box-shadow: 0 8px 18px color-mix(in oklch, var(--accent), transparent 78%);
}
button:hover { filter: brightness(.985); transform: translateY(-1px); }
button.ghost {
  background: var(--surface);
  color: var(--ink);
  border-color: var(--line);
  box-shadow: none;
}
button.danger {
  background: var(--danger);
  border-color: var(--danger);
  color: oklch(98% 0.006 24);
}
button.icon-button {
  width: 40px;
  min-width: 40px;
  padding: 0;
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
  border-color: var(--line);
  box-shadow: var(--shadow-soft);
}
button:disabled { opacity: .52; cursor: not-allowed; transform: none; box-shadow: none; }
input, select, textarea {
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 11px;
  background: var(--surface);
  color: var(--ink);
  min-width: 0;
}
input[type="checkbox"] {
  width: 17px;
  height: 17px;
  min-height: 0;
  padding: 0;
  border-radius: 5px;
  accent-color: var(--accent);
}
textarea { min-height: 84px; padding: 10px 11px; resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible {
  outline: 3px solid color-mix(in oklch, var(--accent), transparent 72%);
  outline-offset: 2px;
}
label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
h1, h2, h3, p { margin: 0; letter-spacing: 0; }
h1 { font-size: 28px; line-height: 1.15; font-weight: 760; }
h2 { font-size: 18px; line-height: 1.25; font-weight: 720; }
h3 { font-size: 15px; line-height: 1.3; font-weight: 720; }
.eyebrow { margin: 0; color: var(--muted); font-size: 13px; }
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  overflow: hidden;
}
.login-shell {
  width: min(1390px, 100%);
  min-height: min(760px, calc(100vh - 64px));
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(420px, 540px);
  align-items: center;
  gap: 52px;
  padding: 72px;
  border: 1px solid color-mix(in oklch, var(--line), transparent 20%);
  border-radius: 24px;
  background: color-mix(in oklch, var(--surface), transparent 4%);
  box-shadow: var(--shadow);
}
.login-copy { display: grid; gap: 34px; align-content: center; }
.login-copy .brand { margin-bottom: 18px; }
.login-copy h2 { font-size: 30px; line-height: 1.2; }
.login-copy p { color: var(--muted); font-size: 16px; }
.login-visual {
  width: min(520px, 100%);
  aspect-ratio: 1.25;
  border-radius: 28px;
  background:
    radial-gradient(circle at 50% 82%, color-mix(in oklch, var(--accent), transparent 68%), transparent 28%),
    linear-gradient(145deg, color-mix(in oklch, var(--accent-soft), transparent 8%), var(--surface));
  position: relative;
  box-shadow: inset 0 1px 0 oklch(100% 0 0 / .8), var(--shadow-soft);
}
.login-visual::before {
  content: "";
  position: absolute;
  left: 18%;
  right: 16%;
  top: 29%;
  height: 40%;
  border-radius: 22px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 30px 54px color-mix(in oklch, var(--accent), transparent 78%);
}
.login-visual::after {
  content: "UB";
  position: absolute;
  right: 18%;
  bottom: 24%;
  width: 78px;
  height: 78px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 800;
  box-shadow: 0 18px 34px color-mix(in oklch, var(--accent), transparent 65%);
}
.login-panel {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 48px;
  border-radius: 18px;
  box-shadow: var(--shadow-soft);
}
.stack { display: grid; gap: 18px; margin-top: 26px; }
.login-form-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; color: var(--muted); font-size: 13px; }
.login-form-row label { display: inline-flex; align-items: center; gap: 8px; }
.login-help { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; color: var(--subtle); text-align: center; }
.login-help::before, .login-help::after { content: ""; height: 1px; background: var(--line); }
.message { min-height: 20px; color: var(--danger); }
.message.danger { color: var(--danger); }
.toast {
  position: fixed;
  right: 22px;
  bottom: 22px;
  max-width: min(440px, calc(100vw - 44px));
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--shadow);
  padding: 12px 14px;
  color: var(--ink);
  z-index: 20;
}
.toast.error { border-color: color-mix(in oklch, var(--danger), var(--line) 45%); color: var(--danger); }
.toast.ok { border-color: color-mix(in oklch, var(--success), var(--line) 48%); color: var(--success); }
.app-shell { min-height: 100vh; display: grid; grid-template-columns: 278px minmax(0, 1fr); }
aside {
  border-right: 1px solid var(--line);
  background: color-mix(in oklch, var(--surface), transparent 10%);
  padding: 28px 18px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 28px;
  box-shadow: 14px 0 34px oklch(35% 0.04 220 / .045);
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: 13px;
  background: linear-gradient(145deg, var(--accent), var(--accent-strong));
  color: var(--accent-ink);
  font-weight: 850;
  box-shadow: 0 10px 22px color-mix(in oklch, var(--accent), transparent 66%);
}
.brand div { display: grid; gap: 2px; min-width: 0; }
.brand strong { font-size: 27px; line-height: 1; color: color-mix(in oklch, var(--ink), var(--accent) 18%); }
.brand small { color: var(--muted); font-size: 13px; }
nav { display: grid; align-content: start; gap: 8px; }
nav button {
  width: 100%;
  justify-content: flex-start;
  text-align: left;
  background: transparent;
  color: var(--muted);
  border-color: transparent;
  box-shadow: none;
  min-height: 46px;
  padding: 0 14px;
  font-weight: 650;
}
nav button::before {
  content: attr(data-icon);
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--muted);
  background: var(--surface);
}
nav button.active {
  background: color-mix(in oklch, var(--accent-soft), transparent 6%);
  border-color: transparent;
  color: var(--accent-strong);
  box-shadow: none;
}
nav button.active::before {
  color: var(--accent-ink);
  background: var(--accent);
  border-color: var(--accent);
}
.side-footer { display: grid; gap: 18px; }
.side-status {
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  overflow: hidden;
}
.side-status strong {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  color: var(--success);
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.side-status strong::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
}
.side-status span { display: block; padding: 10px 12px; color: var(--muted); font-size: 13px; }
.theme-control { display: inline-grid; grid-template-columns: repeat(3, 1fr); gap: 2px; border: 1px solid var(--line); border-radius: 9px; padding: 2px; background: var(--surface); }
.theme-control button { min-height: 30px; border: 0; background: transparent; color: var(--muted); padding: 0 8px; border-radius: 7px; box-shadow: none; }
.theme-control button.active { background: var(--accent-soft); color: var(--accent-strong); }
.user-mini { display: flex; gap: 10px; align-items: center; padding-top: 18px; border-top: 1px solid var(--line); }
.user-mini .avatar { width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: var(--accent-ink); font-weight: 800; }
.user-mini div { display: grid; gap: 2px; min-width: 0; }
.user-mini small { color: var(--muted); }
main { padding: 32px 34px 48px; min-width: 0; }
header {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(420px, auto);
  align-items: start;
  gap: 20px;
  margin-bottom: 26px;
}
header > div { display: grid; gap: 7px; min-width: 0; }
.header-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; }
.global-search {
  width: min(380px, 100%);
  position: relative;
}
.global-search input {
  width: 100%;
  height: 44px;
  padding-left: 42px;
  padding-right: 58px;
  border-radius: 10px;
  box-shadow: var(--shadow-soft);
}
.global-search::before { content: "⌕"; position: absolute; left: 16px; top: 9px; color: var(--muted); font-size: 19px; z-index: 1; }
.global-search kbd {
  position: absolute;
  right: 10px;
  top: 10px;
  min-width: 34px;
  height: 24px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--muted);
  background: var(--surface-2);
  font: 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
}
header select { width: 230px; height: 44px; border-radius: 10px; box-shadow: var(--shadow-soft); }
.metric-row { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 18px; margin-bottom: 20px; }
.metric-row div {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 24px 24px 20px;
  border-radius: 14px;
  display: grid;
  gap: 8px;
  min-height: 146px;
  box-shadow: var(--shadow-soft);
  position: relative;
  overflow: hidden;
}
.metric-row div::after {
  content: "";
  position: absolute;
  right: 22px;
  bottom: 20px;
  width: 74px;
  height: 22px;
  border-bottom: 3px solid currentColor;
  border-radius: 50%;
  opacity: .8;
}
.metric-row div:nth-child(1) { color: var(--accent); }
.metric-row div:nth-child(2) { color: var(--orange); }
.metric-row div:nth-child(3) { color: var(--blue); }
.metric-row div:nth-child(4) { color: var(--purple); }
.metric-row b { font-size: 34px; line-height: 1; color: var(--ink); }
.metric-row span { color: var(--muted); }
.workbench-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(360px, .85fr); gap: 18px; }
.panel {
  border: 1px solid var(--line);
  background: color-mix(in oklch, var(--surface), transparent 0%);
  padding: 20px;
  border-radius: 14px;
  min-width: 0;
  box-shadow: var(--shadow-soft);
}
.panel h2 { margin-bottom: 14px; }
.panel > .toolbar:first-child h2 { margin-bottom: 0; }
.page-loading {
  margin: -8px 0 16px;
  padding: 9px 12px;
  border: 1px solid color-mix(in oklch, var(--accent), var(--line) 60%);
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 13px;
}
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; align-items: center; }
.toolbar input { width: min(360px, 100%); }
.toolbar h2 { margin-right: auto; }
.filter-panel {
  display: grid;
  grid-template-columns: minmax(240px, 1.4fr) repeat(4, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid color-mix(in oklch, var(--line), transparent 12%);
  border-radius: 12px;
  background: color-mix(in oklch, var(--surface-2), var(--surface) 40%);
}
.filter-panel input, .filter-panel select { width: 100%; }
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 18px;
  margin-bottom: 16px;
}
.section-head > div { display: grid; gap: 5px; min-width: 0; }
.section-head p { color: var(--muted); max-width: 68ch; }
.stat-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.stat-strip div {
  border: 1px solid color-mix(in oklch, var(--line), transparent 10%);
  border-radius: 10px;
  background: color-mix(in oklch, var(--surface), var(--surface-2) 34%);
  padding: 14px;
  display: grid;
  gap: 4px;
}
.stat-strip b { font-size: 24px; line-height: 1; color: var(--ink); }
.stat-strip span { color: var(--muted); font-size: 12px; }
.empty-state {
  min-height: 220px;
  border: 1px dashed var(--line-strong);
  border-radius: 12px;
  background:
    linear-gradient(135deg, color-mix(in oklch, var(--accent-soft), transparent 35%), transparent 44%),
    var(--surface);
  display: grid;
  place-items: center;
  text-align: center;
  padding: 28px;
  color: var(--muted);
}
.empty-state > div { display: grid; gap: 10px; max-width: 440px; }
.empty-state b { color: var(--ink); font-size: 18px; }
.status-dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 4px color-mix(in oklch, var(--success), transparent 78%);
}
.status-dot.bad { background: var(--danger); box-shadow: 0 0 0 4px color-mix(in oklch, var(--danger), transparent 78%); }
.status-dot.warn { background: var(--warn); box-shadow: 0 0 0 4px color-mix(in oklch, var(--warn), transparent 78%); }
.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.status-tabs button {
  border-radius: 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  box-shadow: none;
  padding-inline: 10px;
}
.status-tabs button.active {
  color: var(--accent-strong);
  border-bottom-color: var(--accent);
}
.status-tabs span {
  min-width: 22px;
  min-height: 22px;
  display: inline-grid;
  place-items: center;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--surface-2);
  color: inherit;
  font-size: 12px;
}
.bulk-bar {
  min-height: 52px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-2);
}
.bulk-bar label { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); }
.compact-list, .list { display: grid; gap: 10px; }
.compact-row, article {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
  display: grid;
  gap: 10px;
  background: var(--surface);
  min-width: 0;
}
.list article { border-color: color-mix(in oklch, var(--line), transparent 10%); }
.compact-row { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
.compact-row span:last-child { color: var(--muted); overflow-wrap: anywhere; }
article span { color: var(--muted); overflow-wrap: anywhere; }
.filter-summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin: -2px 0 16px;
  padding: 11px 14px;
  border: 1px solid color-mix(in oklch, var(--accent), var(--line) 62%);
  border-radius: 10px;
  background: color-mix(in oklch, var(--accent-soft), transparent 20%);
}
.filter-summary > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.filter-summary strong { font-size: 13px; color: var(--accent-strong); }
.filter-summary span { display: inline-flex; flex-wrap: wrap; gap: 6px; color: var(--muted); }
.filter-chip, .badge {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.filter-chip b { margin-right: 4px; color: var(--ink); }
.filter-chip.muted { border-color: transparent; background: transparent; padding-inline: 0; }
.badge { color: var(--accent-strong); border-color: color-mix(in oklch, var(--accent), var(--line) 60%); background: var(--accent-soft); }
.badge.warn { color: var(--orange); border-color: color-mix(in oklch, var(--orange), var(--line) 60%); background: var(--orange-soft); }
.hint-row { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; margin: 0 0 16px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
.hint-row span { color: var(--muted); overflow-wrap: anywhere; }
.row-head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px; align-items: start; }
.row-head label { min-width: 64px; padding-top: 2px; }
.row-head h3 { margin-bottom: 4px; }
.review-list, .memory-group-list { display: grid; gap: 10px; }
.review-row, .memory-row {
  display: grid;
  grid-template-columns: 28px minmax(260px, 1.6fr) minmax(120px, .75fr) minmax(100px, .65fr) minmax(100px, .65fr) minmax(90px, .55fr) auto;
  gap: 14px;
  align-items: center;
  padding: 16px;
  border: 1px solid color-mix(in oklch, var(--line), transparent 8%);
  border-radius: 12px;
  background: var(--surface);
}
.review-row > .detail-block,
.memory-row > .detail-block,
.review-row > .message {
  grid-column: 2 / -1;
}
.row-check { display: grid; place-items: center; min-width: 0; }
.row-main { display: grid; gap: 5px; min-width: 0; }
.row-main h3, .row-main span { overflow-wrap: anywhere; }
.row-meta { display: grid; gap: 4px; min-width: 0; }
.row-meta span { font-size: 12px; color: var(--muted); }
.row-meta b { font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
.row-actions { justify-content: flex-end; }
.memory-group {
  border: 1px solid color-mix(in oklch, var(--line), transparent 8%);
  border-radius: 12px;
  background: var(--surface);
  overflow: hidden;
}
.memory-group-head {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
  padding: 14px 16px;
  background: color-mix(in oklch, var(--surface-2), var(--surface) 35%);
  border-bottom: 1px solid var(--line);
}
.memory-group-head span { color: var(--muted); }
.memory-rows { display: grid; }
.memory-row {
  grid-template-columns: 28px 36px minmax(260px, 1.7fr) minmax(110px, .7fr) minmax(90px, .55fr) minmax(90px, .55fr) auto;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  border-bottom: 1px solid var(--line);
}
.memory-row:last-child { border-bottom: 0; }
.memory-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 800;
  font-size: 12px;
}
.actions, .secondary-actions, .quick-actions, .pagination-controls, .candidate-help { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.candidate-help { gap: 6px 14px; color: var(--muted); font-size: 13px; }
.candidate-help b { color: var(--ink); }
.detail-block { display: grid; gap: 9px; padding-top: 10px; border-top: 1px solid var(--line); }
.grid-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 10px; margin-bottom: 14px; align-items: start; }
.candidate-form { display: grid; grid-template-columns: 150px minmax(170px, 1fr) minmax(190px, 1.2fr) 190px; gap: 10px; align-items: start; }
.memory-form { display: grid; grid-template-columns: 150px 200px minmax(180px, 1fr) 120px 130px; gap: 10px; align-items: start; }
.memory-form textarea { grid-column: 3 / span 3; }
.owner-field { display: grid; gap: 4px; min-width: 190px; }
.owner-field span, .member-meta, .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.evidence { border: 1px solid var(--line); background: var(--surface-2); border-radius: 9px; padding: 11px; color: var(--muted); overflow-wrap: anywhere; }
.evidence b { color: var(--ink); }
.evidence summary { cursor: pointer; display: grid; grid-template-columns: auto minmax(180px, max-content) minmax(0, 1fr); gap: 8px; align-items: baseline; }
.evidence summary span, .evidence summary em { color: var(--muted); font-style: normal; min-width: 0; }
.evidence summary em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evidence-body { margin-top: 8px; display: grid; gap: 6px; max-height: 220px; overflow: auto; border-top: 1px solid var(--line); padding-top: 8px; }
.evidence-body p { color: var(--ink); }
.member-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.member-grid article { min-height: 166px; }
.group-block { display: grid; gap: 9px; margin-bottom: 18px; }
.group-config-list { display: grid; gap: 14px; }
.group-config-card { padding: 0; overflow: hidden; border-color: color-mix(in oklch, var(--line), transparent 8%); }
.group-config-card details { display: grid; }
.group-config-card summary {
  cursor: pointer;
  list-style: none;
  padding: 0;
}
.group-config-card summary::-webkit-details-marker { display: none; }
.group-config-summary {
  display: grid;
  grid-template-columns: 52px minmax(220px, 1.4fr) repeat(4, minmax(120px, .75fr));
  gap: 14px;
  align-items: center;
  padding: 18px;
}
.group-avatar {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 800;
}
.group-config-summary > div:not(.group-avatar) { display: grid; gap: 4px; min-width: 0; }
.group-config-summary span { color: var(--muted); overflow-wrap: anywhere; }
.group-config-summary b { color: var(--ink); }
.settings-form { display: grid; gap: 16px; }
.settings-layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  padding: 0 18px 18px;
  align-items: start;
}
.settings-card {
  border: 1px solid color-mix(in oklch, var(--line), transparent 8%);
  border-radius: 12px;
  background: color-mix(in oklch, var(--surface), var(--surface-2) 30%);
  padding: 16px;
  display: grid;
  gap: 12px;
  align-content: start;
}
.settings-card h3 { margin: 0; }
.settings-card-wide { grid-column: 1 / -1; }
.settings-card-wide textarea { min-height: 180px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.settings-card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.settings-card-head span { color: var(--muted); }
.settings-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; align-content: start; }
.settings-grid label { min-width: 0; }
.settings-grid label:has(> input[type="checkbox"]) { display: flex; align-items: center; min-height: 36px; gap: 9px; color: var(--ink); padding-top: 21px; }
.settings-grid textarea { min-height: 88px; }
.settings-wide { grid-column: 1 / -1; }
.sticky-actions {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
  background: color-mix(in oklch, var(--surface), transparent 3%);
}
.health-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.health-card { border: 1px solid var(--line); border-radius: 12px; padding: 18px; background: var(--surface); display: grid; gap: 10px; min-height: 150px; }
.health-card h3 { display: flex; align-items: center; gap: 9px; }
.health-card.ok { border-color: color-mix(in oklch, var(--success), var(--line) 55%); }
.health-card.bad { border-color: color-mix(in oklch, var(--danger), var(--line) 55%); }
.health-card p { color: var(--muted); overflow-wrap: anywhere; }
.health-diagnostics { margin-top: 16px; }
.inline-editor { border: 1px solid var(--line); border-radius: 11px; padding: 12px 14px; margin-bottom: 16px; background: var(--surface); }
.inline-editor summary { cursor: pointer; font-weight: 700; }
.inline-editor summary em { margin-left: 10px; color: var(--muted); font-style: normal; font-weight: 400; }
.inline-editor form { margin-top: 12px; margin-bottom: 0; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-top: 16px; color: var(--muted); }
.pagination-controls button { min-width: 40px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
table.admin-table { width: 100%; border-collapse: collapse; }
table.admin-table th, table.admin-table td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
table.admin-table th { color: var(--muted); font-size: 12px; font-weight: 700; background: var(--surface-2); }
@media (max-width: 1120px) {
  .app-shell { grid-template-columns: 228px minmax(0, 1fr); }
  header { grid-template-columns: 1fr; }
  .header-actions { justify-content: flex-start; }
  .metric-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workbench-grid { grid-template-columns: 1fr; }
  .filter-panel, .settings-layout { grid-template-columns: 1fr; }
  .review-row, .memory-row { grid-template-columns: 28px minmax(0, 1fr); }
  .review-row > *, .memory-row > * { grid-column: 2; }
  .review-row > .row-check, .memory-row > .row-check { grid-column: 1; grid-row: 1 / span 2; }
  .row-actions { justify-content: flex-start; }
  .group-config-summary { grid-template-columns: 52px minmax(0, 1fr); }
}
@media (max-width: 860px) {
  .login-page { padding: 0; }
  .login-shell { min-height: 100vh; grid-template-columns: 1fr; padding: 28px; border-radius: 0; }
  .login-copy { display: none; }
  .login-panel { padding: 30px 24px; }
  .app-shell { grid-template-columns: 1fr; }
  aside { position: static; grid-template-rows: auto auto auto; gap: 16px; padding: 18px; border-right: 0; border-bottom: 1px solid var(--line); }
  aside .brand-mark { width: 36px; height: 36px; border-radius: 12px; }
  aside .brand strong { font-size: 24px; }
  nav { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
  nav button { min-height: 38px; padding: 0 8px; justify-content: center; font-size: 12px; }
  nav button::before { width: 22px; height: 22px; border-radius: 7px; }
  .side-footer { gap: 12px; }
  .user-mini { padding-top: 12px; }
  main { padding: 20px; }
  header { align-items: start; }
  .header-actions, header select, .global-search { width: 100%; }
  .header-actions { justify-content: stretch; }
  .header-actions > * { flex: 1 1 150px; }
  .metric-row, .grid-form, .candidate-form, .memory-form, .settings-grid, .health-grid, .evidence summary { grid-template-columns: 1fr; }
  .section-head, .stat-strip { grid-template-columns: 1fr; }
  .section-head { display: grid; }
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
  <title>UBot 后台登录</title>
  ${THEME_BOOTSTRAP}
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="login-page">
  <main class="login-shell">
    <section class="login-copy" aria-label="UBot 后台介绍">
      <div class="brand"><span class="brand-mark">UB</span><div><strong>UBot</strong><small>群聊运营控制台</small></div></div>
      <div>
        <h2>高效运营 · 智能管理</h2>
        <p>让群聊运营更简单、更智能、更安全。</p>
      </div>
      <div class="login-visual" aria-hidden="true"></div>
    </section>
    <section class="login-panel">
      <p class="eyebrow">UBot</p>
      <h1>后台登录</h1>
      <p class="eyebrow">欢迎回来，请输入账号密码登录系统</p>
      <form id="loginForm" class="stack">
        <label>账号<input name="username" autocomplete="username" placeholder="请输入账号" required></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required></label>
        <div class="login-form-row">
          <label><input type="checkbox" disabled> 记住登录</label>
          <span>安全登录，保护账号信息</span>
        </div>
        <button type="submit">登录</button>
        <div class="login-help"><span>如需帮助，请联系系统管理员</span></div>
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
      <div class="brand"><span class="brand-mark">UB</span><div><strong>UBot</strong><small>群聊运营控制台</small></div></div>
      <nav>
        <button data-view="overview" data-icon="⌂" class="active">总览</button>
        <button data-view="groups" data-icon="⚙">群配置</button>
        <button data-view="members" data-icon="👥">成员管理</button>
        <button data-view="candidates" data-icon="A">候选记忆</button>
        <button data-view="memories" data-icon="▣">长期记忆</button>
        <button data-view="knowledge" data-icon="?">知识库</button>
        <button data-view="health" data-icon="✓">健康状态</button>
      </nav>
      <div class="side-footer">
        <div class="side-status"><strong>系统运行正常</strong><span>UBot v2.0.0</span></div>
        <div class="theme-control" aria-label="主题切换">
          <button type="button" data-theme-option="light">浅色</button>
          <button type="button" data-theme-option="dark">深色</button>
          <button type="button" data-theme-option="system">系统</button>
        </div>
        <div class="user-mini"><span class="avatar">AI</span><div><strong>admin</strong><small>管理员</small></div></div>
        <button id="logout" class="ghost">退出登录</button>
      </div>
    </aside>
    <main>
      <header>
        <div>
          <h1 id="viewTitle">总览</h1>
          <p id="viewSubtitle" class="eyebrow">掌握当前群聊助手的关键数据与运行状态</p>
        </div>
        <div class="header-actions">
          <label class="global-search" aria-label="全局搜索"><input id="globalSearch" placeholder="搜索成员、记忆、FAQ..."><kbd>⌘ K</kbd></label>
          <select id="groupFilter"></select>
          <button id="refreshCurrent" class="icon-button" type="button" title="刷新当前页面">↻</button>
          <button class="icon-button" type="button" data-jump-view="health" title="查看健康状态">●</button>
          <button class="icon-button" type="button" data-theme-option="system" title="跟随系统主题">⚙</button>
        </div>
      </header>
      <section id="content"></section>
      <div id="toast" class="toast" hidden></div>
    </main>
  </div>
  <script src="/admin-app.js" defer></script>
</body>
</html>`;

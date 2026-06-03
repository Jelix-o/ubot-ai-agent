const ADMIN_CSS = `
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
.list { display: grid; gap: 10px; }
article { border: 1px solid var(--line); border-radius: 8px; padding: 14px; display: grid; gap: 10px; }
article span { color: var(--muted); overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.grid-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 8px; margin-bottom: 14px; align-items: start; }
.candidate-form { display: grid; grid-template-columns: 140px minmax(160px, 1fr) minmax(160px, 1.2fr) 170px; gap: 8px; align-items: start; }
.memory-form { display: grid; grid-template-columns: 140px 190px minmax(160px, 1fr) 110px 120px; gap: 8px; align-items: start; }
.memory-form textarea { grid-column: 3 / span 3; }
.evidence { border: 1px solid var(--line); background: var(--panel); border-radius: 6px; padding: 10px; color: var(--muted); overflow-wrap: anywhere; }
.evidence b { color: var(--ink); }
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
@media (max-width: 860px) { .app-shell { grid-template-columns: 1fr; } aside { position: static; border-right: 0; border-bottom: 1px solid var(--line); } nav { grid-template-columns: repeat(2, 1fr); } .metric-row, .workbench-grid, .grid-form, .candidate-form, .memory-form { grid-template-columns: 1fr; } .memory-form textarea { grid-column: auto; } header { align-items: start; flex-direction: column; } header select { width: 100%; } }
`;

export const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI-Project 机器人后台</title>
  <style>${ADMIN_CSS}</style>
</head>
<body class="login-page">
  <main class="login-shell">
    <section class="login-panel">
      <p class="eyebrow">AI-Project</p>
      <h1>机器人后台</h1>
      <form id="loginForm" class="stack">
        <label>账号<input name="username" autocomplete="username" required></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">登录</button>
        <p id="message" class="message"></p>
      </form>
    </section>
  </main>
  <script>
    document.querySelector('#loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (res.ok) location.href = '/';
      else document.querySelector('#message').textContent = '账号或密码错误';
    });
  </script>
</body>
</html>`;

export const ADMIN_APP_HTML_V2 = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI-Project 机器人后台</title>
  <style>${ADMIN_CSS}</style>
</head>
<body>
  <div class="app-shell">
    <aside>
      <div class="brand"><span>AI</span><strong>机器人后台</strong></div>
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
  <script>
    const state = { view: 'overview', groups: [], groupId: '', members: [], memberQuery: '', memberPage: 1, memberPageSize: 24, editingMemberId: '', subjectUserId: '', candidateType: '', candidateStatus: '', candidateQuery: '', memoryQuery: '', knowledgeQuery: '', pendingDelete: '', notice: '', memoryPage: 1, memoryPageSize: 20, candidatePage: 1, candidatePageSize: 20, knowledgePage: 1, knowledgePageSize: 20, editingCandidateId: '', editingMemoryId: '', editingKnowledgeId: '', currentCandidates: [], currentMemories: [], currentKnowledge: [] };
    const titleByView = { overview: '总览', groups: '群配置', members: '成员管理', candidates: '候选记忆', memories: '长期记忆', knowledge: '知识库', health: '健康状态' };
    const content = () => document.querySelector('#content');
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const selected = (left, right) => left === right ? ' selected' : '';
    const typeText = (value) => value === 'member_profile' ? '成员画像' : '群事实';
    const statusText = (value) => ({ pending: '待审', approved: '已批准', rejected: '已拒绝' }[value] || value);
    const enabledText = (value) => value ? '启用' : '停用';
    const ownerLabel = (item) => item.subjectLabel?.label || (item.type === 'member_profile' && !item.subjectUserId ? '未归属' : '群整体');
    const shortText = (value, limit = 160) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      return text.length > limit ? text.slice(0, limit) + '...' : text;
    };
    const toast = (message, type = 'ok') => {
      const node = document.querySelector('#toast');
      node.textContent = message;
      node.className = 'toast ' + type;
      node.hidden = false;
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => { node.hidden = true; }, type === 'error' ? 5200 : 2200);
    };
    const evidenceHtml = (item) => {
      const evidence = item.evidence;
      if (!evidence) return '<div class="evidence"><b>来源证据：</b>无来源记录</div>';
      const speakers = (evidence.speakers || []).map(s => (s.userName ? esc(s.userName) + ' / QQ ' + esc(s.userId) : 'QQ ' + esc(s.userId))).join('、') || '无';
      return '<div class="evidence"><b>来源证据：</b>' + esc(evidence.summary) + '<br>时间段：' + esc(evidence.startAt) + ' 至 ' + esc(evidence.endAt) + '<br>消息数：' + esc(evidence.messageCount) + ' · 参与：' + speakers + '</div>';
    };
    const api = async (url, options = {}) => {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
      if (res.status === 401) location.href = '/login';
      if (!res.ok) {
        let message = await res.text();
        try { message = JSON.parse(message).error || message; } catch {}
        throw new Error(message || '请求失败');
      }
      return res.json();
    };
    const runAction = async (button, work, success = '操作完成') => {
      try {
        if (button) button.disabled = true;
        await work();
        if (success) toast(success);
      } catch (error) {
        toast(error.message || '操作失败', 'error');
      } finally {
        if (button) button.disabled = false;
      }
    };
    async function loadGroups() {
      const data = await api('/api/groups');
      state.groups = data.groups || [];
      state.groupId = state.groupId || state.groups[0]?.groupId || '';
      document.querySelector('#groupFilter').innerHTML = state.groups.map(g => '<option value="' + esc(g.groupId) + '">' + esc(g.groupId) + '</option>').join('');
      document.querySelector('#groupFilter').value = state.groupId;
    }
    async function loadMembers(force = false) {
      if (!state.groupId) return [];
      if (!force && state.members.length > 0) return state.members;
      const data = await api('/api/groups/' + encodeURIComponent(state.groupId) + '/members' + (force ? '?refresh=1' : ''));
      state.members = data.members || [];
      return state.members;
    }
    function memberOptions(includeAll = false, selectedUserId = '') {
      const baseLabel = includeAll ? '全部成员' : '群整体';
      const base = '<option value=""' + selected(selectedUserId, '') + '>' + baseLabel + '</option>';
      return base + state.members.map(m => '<option value="' + esc(m.userId) + '"' + selected(m.userId, selectedUserId) + '>' + esc(m.displayName) + ' / QQ ' + esc(m.userId) + (m.note ? ' / 备注：' + esc(m.note) : '') + '</option>').join('');
    }
    async function render() {
      document.querySelector('#viewTitle').textContent = titleByView[state.view];
      document.querySelectorAll('nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view));
      state.pendingDelete = '';
      if (state.view === 'overview') return renderOverview();
      if (state.view === 'groups') return renderGroups();
      if (state.view === 'members') return renderMembers();
      if (state.view === 'candidates') return renderCandidates();
      if (state.view === 'memories') return renderMemories();
      if (state.view === 'knowledge') return renderKnowledge();
      return renderHealth();
    }
    async function renderOverview() {
      const groupQuery = state.groupId ? '?groupId=' + encodeURIComponent(state.groupId) : '';
      const [data, candidateData, memoryData, knowledgeData] = await Promise.all([
        api('/api/overview' + groupQuery),
        state.groupId ? api('/api/memory-candidates?groupId=' + encodeURIComponent(state.groupId) + '&status=pending&page=1&pageSize=5') : Promise.resolve({ candidates: [] }),
        state.groupId ? api('/api/memories?groupId=' + encodeURIComponent(state.groupId) + '&page=1&pageSize=5') : Promise.resolve({ memories: [] }),
        state.groupId ? api('/api/knowledge?groupId=' + encodeURIComponent(state.groupId) + '&page=1&pageSize=5') : Promise.resolve({ entries: [] }),
      ]);
      content().innerHTML = '<div class="metric-row"><div><b>' + data.stats.groupCount + '</b><span>已配置群</span></div><div><b>' + data.stats.pendingCandidateCount + '</b><span>当前群待审记忆</span></div><div><b>' + data.stats.memoryCount + '</b><span>当前群长期记忆</span></div><div><b>' + data.stats.knowledgeCount + '</b><span>当前群 FAQ</span></div></div><div class="workbench-grid"><section class="panel"><h2>当前群待处理</h2>' + overviewCandidates(candidateData.candidates || []) + '<div class="quick-actions"><button data-jump-view="candidates">审核候选记忆</button><button data-jump-view="members" class="ghost">维护成员备注</button><button data-jump-view="memories" class="ghost">查看长期记忆</button></div></section><section class="panel"><h2>运行状态</h2><p>' + esc(data.transportHealth.detail) + '</p><div class="quick-actions"><button data-jump-view="health" class="ghost">查看健康状态</button><button data-jump-view="groups" class="ghost">查看群配置</button></div></section><section class="panel"><h2>最新长期记忆</h2>' + overviewMemories(memoryData.memories || []) + '</section><section class="panel"><h2>知识库</h2>' + overviewKnowledge(knowledgeData.entries || []) + '<div class="quick-actions"><button data-jump-view="knowledge" class="ghost">维护 FAQ</button></div></section></div>';
    }
    function overviewCandidates(candidates) {
      if (!candidates.length) return '<p class="message">当前群没有待审候选。</p>';
      return '<div class="compact-list">' + candidates.map(c => '<div class="compact-row"><b>' + esc(c.title) + '</b><span>' + esc(ownerLabel(c)) + ' · ' + esc(typeText(c.type)) + ' · 置信度 ' + esc(c.confidence) + '</span><span>' + esc(shortText(c.content, 120)) + '</span></div>').join('') + '</div>';
    }
    function overviewMemories(memories) {
      if (!memories.length) return '<p class="message">当前群暂无长期记忆。</p>';
      return '<div class="compact-list">' + memories.map(m => '<div class="compact-row"><b>' + esc(m.title) + '</b><span>' + esc(ownerLabel(m)) + ' · ' + esc(typeText(m.type)) + ' · ' + enabledText(m.enabled) + '</span><span>' + esc(shortText(m.content, 120)) + '</span></div>').join('') + '</div>';
    }
    function overviewKnowledge(entries) {
      if (!entries.length) return '<p class="message">当前群暂无 FAQ。</p>';
      return '<div class="compact-list">' + entries.map(k => '<div class="compact-row"><b>' + esc(k.title) + '</b><span>关键词：' + esc((k.keywords || []).join('、') || '无') + '</span><span>' + esc(shortText(k.answer, 120)) + '</span></div>').join('') + '</div>';
    }
    async function renderGroups() {
      await loadGroups();
      content().innerHTML = '<section class="panel"><h2>群配置</h2><div class="list">' + state.groups.map(g => '<article><b>群 ' + esc(g.groupId) + '</b><span>当前技能 ' + esc(g.currentSkillId) + '，管理员 ' + g.switcherUserIds.length + ' 人，实时对话 ' + g.liveChatUserIds.length + ' 人，人工身份 ' + (g.manualIdentities || []).length + ' 条</span></article>').join('') + '</div></section>';
    }
    async function renderMembers() {
      await loadMembers();
      const query = state.memberQuery.trim().toLowerCase();
      const members = state.members.filter(m => !query || [m.userId, m.displayName, m.card, m.nickname, m.note, ...(m.aliases || [])].some(v => String(v || '').toLowerCase().includes(query)));
      const pageInfo = paginateLocal(members, state.memberPage, state.memberPageSize);
      state.memberPage = pageInfo.page;
      const pageMembers = members.slice(pageInfo.startIndex, pageInfo.endIndex);
      content().innerHTML = '<section class="panel"><div class="toolbar"><input id="memberSearch" value="' + esc(state.memberQuery) + '" placeholder="搜索 QQ、名字、别名、备注"><select id="memberPageSize"><option value="12"' + selected(String(state.memberPageSize), '12') + '>每页 12 人</option><option value="24"' + selected(String(state.memberPageSize), '24') + '>每页 24 人</option><option value="48"' + selected(String(state.memberPageSize), '48') + '>每页 48 人</option></select><button data-refresh-members>刷新</button></div><div class="member-grid">' + pageMembers.map(rowMember).join('') + '</div>' + memberPagination(pageInfo) + '</section>';
      document.querySelector('#memberSearch')?.addEventListener('input', event => { state.memberQuery = event.target.value; state.memberPage = 1; renderMembers(); });
      document.querySelector('#memberPageSize')?.addEventListener('change', event => { state.memberPageSize = Number(event.target.value) || 24; state.memberPage = 1; renderMembers(); });
    }
    function rowMember(m) {
      const meta = '<div class="member-meta">QQ ' + esc(m.userId) + (m.card ? ' · 群名片 ' + esc(m.card) : '') + (m.nickname ? ' · 昵称 ' + esc(m.nickname) : '') + (m.role ? ' · 角色 ' + esc(m.role) : '') + (m.note ? ' · 备注：' + esc(m.note) : '') + '</div>';
      const badges = '<div><span class="badge">' + m.memoryCount + ' 条记忆</span> <span class="badge warn">' + m.pendingCandidateCount + ' 条待审</span>' + ((m.aliases || []).length ? ' <span class="badge">' + esc((m.aliases || []).join('、')) + '</span>' : '') + '</div>';
      if (state.editingMemberId !== m.userId) {
        return '<article data-member-id="' + esc(m.userId) + '"><h3>' + esc(m.displayName) + '</h3>' + meta + badges + '<div class="actions"><button type="button" data-edit-member="' + esc(m.userId) + '">编辑备注</button><button type="button" class="ghost" data-view-member="' + esc(m.userId) + '">查看记忆</button>' + (m.hasManualIdentity ? '<button type="button" class="ghost" data-delete-identity="' + esc(m.userId) + '">删除备注</button>' : '') + '</div></article>';
      }
      return '<article><h3>' + esc(m.displayName) + '</h3>' + meta + badges + '<form class="memberForm" data-user-id="' + esc(m.userId) + '"><input name="names" value="' + esc((m.aliases || []).join(', ')) + '" placeholder="别名，用逗号分隔"><input name="note" value="' + esc(m.note || '') + '" placeholder="系统备注"><div class="actions"><button>保存备注</button><button type="button" data-cancel-edit>收起</button><button type="button" class="ghost" data-view-member="' + esc(m.userId) + '">查看记忆</button>' + (m.hasManualIdentity ? '<button type="button" class="ghost" data-delete-identity="' + esc(m.userId) + '">删除备注</button>' : '') + '</div></form></article>';
    }
    async function renderCandidates() {
      await loadMembers();
      const query = new URLSearchParams({ groupId: state.groupId });
      if (state.candidateStatus) query.set('status', state.candidateStatus);
      if (state.candidateType) query.set('type', state.candidateType);
      if (state.subjectUserId) query.set('subjectUserId', state.subjectUserId);
      if (state.candidateQuery.trim()) query.set('q', state.candidateQuery.trim());
      query.set('page', String(state.candidatePage));
      query.set('pageSize', String(state.candidatePageSize));
      const data = await api('/api/memory-candidates?' + query.toString());
      const pageInfo = data.pagination || { page: state.candidatePage, pageSize: state.candidatePageSize, total: (data.candidates || []).length, totalPages: 1 };
      state.currentCandidates = data.candidates || [];
      state.candidatePage = pageInfo.page;
      const notice = state.notice ? '<p class="message">' + esc(state.notice) + '</p>' : '';
      state.notice = '';
      content().innerHTML = '<section class="panel"><div class="toolbar"><input id="candidateSearch" value="' + esc(state.candidateQuery) + '" placeholder="搜索标题、内容、来源、QQ"><select id="candidateStatus"><option value="pending"' + selected(state.candidateStatus, 'pending') + '>待审</option><option value="approved"' + selected(state.candidateStatus, 'approved') + '>已批准</option><option value="rejected"' + selected(state.candidateStatus, 'rejected') + '>已拒绝</option><option value=""' + selected(state.candidateStatus, '') + '>全部</option></select><select id="candidateType"><option value="">全部类型</option><option value="member_profile"' + selected(state.candidateType, 'member_profile') + '>成员画像</option><option value="group_fact"' + selected(state.candidateType, 'group_fact') + '>群事实</option></select><select id="subjectFilter">' + memberOptions(true, state.subjectUserId) + '</select><select id="candidatePageSize"><option value="10"' + selected(String(state.candidatePageSize), '10') + '>每页 10 条</option><option value="20"' + selected(String(state.candidatePageSize), '20') + '>每页 20 条</option><option value="50"' + selected(String(state.candidatePageSize), '50') + '>每页 50 条</option></select><button data-bulk-approve>批量批准当前页</button></div>' + notice + '<div class="list">' + state.currentCandidates.map(rowCandidate).join('') + '</div>' + candidatePagination(pageInfo) + '</section>';
      document.querySelector('#candidateSearch').addEventListener('input', debounce(event => { state.candidateQuery = event.target.value; state.candidatePage = 1; renderCandidates(); }, 250));
      document.querySelector('#candidateStatus').addEventListener('change', event => { state.candidateStatus = event.target.value; state.candidatePage = 1; renderCandidates(); });
      document.querySelector('#candidateType').addEventListener('change', event => { state.candidateType = event.target.value; state.candidatePage = 1; renderCandidates(); });
      document.querySelector('#subjectFilter').addEventListener('change', event => { state.subjectUserId = event.target.value; state.candidatePage = 1; renderCandidates(); });
      document.querySelector('#candidatePageSize').addEventListener('change', event => { state.candidatePageSize = Number(event.target.value) || 20; state.candidatePage = 1; renderCandidates(); });
    }
    function rowCandidate(c) {
      const needsOwner = c.type === 'member_profile' && !c.subjectUserId;
      const meta = '<div class="meta">归属：' + esc(ownerLabel(c)) + ' · 类型：' + esc(typeText(c.type)) + ' · 状态：' + esc(statusText(c.status)) + ' · 置信度：' + esc(c.confidence) + (needsOwner ? ' · 需要选择成员或转为群事实' : '') + '</div>';
      if (state.editingCandidateId !== c.id) {
        return '<article data-candidate-id="' + esc(c.id) + '"><h3>' + esc(c.title) + '</h3><span>' + esc(shortText(c.content)) + '</span>' + meta + evidenceHtml(c) + '<div class="actions"><button type="button" data-edit-candidate="' + esc(c.id) + '">编辑</button><button type="button" data-approve="' + esc(c.id) + '">批准</button><button type="button" data-approve-as-fact="' + esc(c.id) + '" class="ghost">转为群事实并批准</button><button type="button" data-reject="' + esc(c.id) + '" class="ghost">拒绝</button><button type="button" data-delete-candidate="' + esc(c.id) + '" class="ghost">' + (state.pendingDelete === c.id ? '确认删除' : '删除') + '</button></div></article>';
      }
      return '<article data-candidate-id="' + esc(c.id) + '"><form class="candidateForm" data-candidate-id="' + esc(c.id) + '"><div class="candidate-form"><select name="type"><option value="member_profile"' + selected(c.type, 'member_profile') + '>成员画像</option><option value="group_fact"' + selected(c.type, 'group_fact') + '>群事实</option></select><input name="title" value="' + esc(c.title) + '" placeholder="标题"><textarea name="content" placeholder="内容">' + esc(c.content) + '</textarea><select name="subjectUserId">' + memberOptions(false, c.subjectUserId || '') + '</select></div>' + meta + evidenceHtml(c) + '<div class="actions"><button type="button" data-save-candidate="' + esc(c.id) + '">保存</button><button type="button" data-approve="' + esc(c.id) + '">批准</button><button type="button" data-approve-as-fact="' + esc(c.id) + '" class="ghost">转为群事实并批准</button><button type="button" data-reject="' + esc(c.id) + '" class="ghost">拒绝</button><button type="button" data-cancel-edit>收起</button><button type="button" data-delete-candidate="' + esc(c.id) + '" class="ghost">' + (state.pendingDelete === c.id ? '确认删除' : '删除') + '</button></div></form></article>';
    }
    async function renderMemories() {
      await loadMembers();
      const query = new URLSearchParams({ groupId: state.groupId });
      if (state.subjectUserId) query.set('subjectUserId', state.subjectUserId);
      if (state.memoryQuery.trim()) query.set('q', state.memoryQuery.trim());
      query.set('page', String(state.memoryPage));
      query.set('pageSize', String(state.memoryPageSize));
      const data = await api('/api/memories?' + query.toString());
      const memories = data.memories || [];
      state.currentMemories = memories;
      const pageInfo = data.pagination || { page: state.memoryPage, pageSize: state.memoryPageSize, total: memories.length, totalPages: 1 };
      state.memoryPage = pageInfo.page;
      const groups = groupMemories(memories);
      content().innerHTML = '<section class="panel"><div class="toolbar"><input id="memorySearch" value="' + esc(state.memoryQuery) + '" placeholder="搜索标题、内容、来源、QQ"><select id="memorySubjectFilter">' + memberOptions(true, state.subjectUserId) + '</select><select id="memoryPageSize"><option value="10"' + selected(String(state.memoryPageSize), '10') + '>每页 10 条</option><option value="20"' + selected(String(state.memoryPageSize), '20') + '>每页 20 条</option><option value="50"' + selected(String(state.memoryPageSize), '50') + '>每页 50 条</option><option value="100"' + selected(String(state.memoryPageSize), '100') + '>每页 100 条</option></select></div>' + memoryForm() + groups.map(g => '<div class="group-block"><h3>' + esc(g.label) + '</h3><div class="list">' + g.items.map(rowMemory).join('') + '</div></div>').join('') + memoryPagination(pageInfo) + '</section>';
      document.querySelector('#memorySearch').addEventListener('input', debounce(event => { state.memoryQuery = event.target.value; state.memoryPage = 1; renderMemories(); }, 250));
      document.querySelector('#memorySubjectFilter').addEventListener('change', event => { state.subjectUserId = event.target.value; state.memoryPage = 1; renderMemories(); });
      document.querySelector('#memoryPageSize').addEventListener('change', event => { state.memoryPageSize = Number(event.target.value) || 20; state.memoryPage = 1; renderMemories(); });
      document.querySelector('#memoryPageJump').addEventListener('submit', event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target).entries()); state.memoryPage = Number(data.page) || 1; renderMemories(); });
    }
    function memoryForm() {
      return '<details class="inline-editor"><summary>新增长期记忆</summary><form id="memoryForm" class="grid-form"><select name="type"><option value="group_fact">群事实</option><option value="member_profile">成员画像</option></select><select name="subjectUserId">' + memberOptions(false) + '</select><input name="title" placeholder="标题"><input name="content" placeholder="内容"><button>新增</button></form></details>';
    }
    function groupMemories(memories) {
      const map = new Map();
      for (const memory of memories) {
        const label = ownerLabel(memory);
        if (!map.has(label)) map.set(label, []);
        map.get(label).push(memory);
      }
      return [...map.entries()].map(([label, items]) => ({ label, items }));
    }
    function rowMemory(m) {
      const meta = '<div class="meta">当前归属：' + esc(ownerLabel(m)) + ' · 类型：' + esc(typeText(m.type)) + ' · 状态：' + enabledText(m.enabled) + ' · 置信度：' + esc(m.confidence) + '</div>';
      if (state.editingMemoryId !== m.id) {
        return '<article data-memory-id="' + esc(m.id) + '"><h3>' + esc(m.title) + '</h3><span>' + esc(shortText(m.content)) + '</span>' + meta + evidenceHtml(m) + '<div class="actions"><button type="button" data-edit-memory="' + esc(m.id) + '">编辑</button><button type="button" data-toggle-memory="' + esc(m.id) + '" data-enabled="' + (!m.enabled) + '" class="ghost">' + (m.enabled ? '停用' : '启用') + '</button><button type="button" data-delete-memory="' + esc(m.id) + '" class="ghost">' + (state.pendingDelete === m.id ? '确认删除' : '删除') + '</button></div></article>';
      }
      return '<article><form class="memoryItemForm" data-memory-id="' + esc(m.id) + '"><div class="memory-form"><select name="type"><option value="member_profile"' + selected(m.type, 'member_profile') + '>成员画像</option><option value="group_fact"' + selected(m.type, 'group_fact') + '>群事实</option></select><select name="subjectUserId">' + memberOptions(false, m.subjectUserId || '') + '</select><input name="title" value="' + esc(m.title) + '" placeholder="标题"><input name="confidence" type="number" min="0" max="1" step="0.01" value="' + esc(m.confidence) + '" placeholder="置信度"><select name="enabled"><option value="true"' + selected(String(m.enabled), 'true') + '>启用</option><option value="false"' + selected(String(m.enabled), 'false') + '>停用</option></select><textarea name="content" placeholder="内容">' + esc(m.content) + '</textarea></div>' + meta + evidenceHtml(m) + '<div class="actions"><button type="button" data-save-memory="' + esc(m.id) + '">保存编辑</button><button type="button" data-toggle-memory="' + esc(m.id) + '" data-enabled="' + (!m.enabled) + '" class="ghost">' + (m.enabled ? '停用' : '启用') + '</button><button type="button" data-cancel-edit>收起</button><button type="button" data-delete-memory="' + esc(m.id) + '" class="ghost">' + (state.pendingDelete === m.id ? '确认删除' : '删除') + '</button></div></form></article>';
    }
    function memoryPagination(pageInfo) {
      const start = pageInfo.total === 0 ? 0 : ((pageInfo.page - 1) * pageInfo.pageSize) + 1;
      const end = Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total);
      const label = pageInfo.total === 0 ? '暂无长期记忆' : '第 ' + start + '-' + end + ' 条，共 ' + pageInfo.total + ' 条';
      return '<div class="pagination"><span>' + esc(label) + '</span><div class="pagination-controls"><button class="ghost" data-memory-page="prev"' + (pageInfo.page <= 1 ? ' disabled' : '') + '>上一页</button><span>第 ' + pageInfo.page + ' / ' + pageInfo.totalPages + ' 页</span><button class="ghost" data-memory-page="next"' + (pageInfo.page >= pageInfo.totalPages ? ' disabled' : '') + '>下一页</button><form id="memoryPageJump" class="pagination-controls"><input name="page" type="number" min="1" max="' + pageInfo.totalPages + '" value="' + pageInfo.page + '" aria-label="页码" style="width:86px"><button class="ghost">跳转</button></form></div></div>';
    }
    function paginateLocal(items, page, pageSize) {
      const total = items.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const normalizedPage = Math.min(Math.max(1, page), totalPages);
      const startIndex = (normalizedPage - 1) * pageSize;
      const endIndex = Math.min(startIndex + pageSize, total);
      return { page: normalizedPage, pageSize, total, totalPages, startIndex, endIndex };
    }
    function memberPagination(pageInfo) {
      const start = pageInfo.total === 0 ? 0 : pageInfo.startIndex + 1;
      const label = pageInfo.total === 0 ? '暂无成员' : '第 ' + start + '-' + pageInfo.endIndex + ' 人，共 ' + pageInfo.total + ' 人';
      return '<div class="pagination"><span>' + esc(label) + '</span><div class="pagination-controls"><button class="ghost" data-member-page="prev"' + (pageInfo.page <= 1 ? ' disabled' : '') + '>上一页</button><span>第 ' + pageInfo.page + ' / ' + pageInfo.totalPages + ' 页</span><button class="ghost" data-member-page="next"' + (pageInfo.page >= pageInfo.totalPages ? ' disabled' : '') + '>下一页</button></div></div>';
    }
    function candidatePagination(pageInfo) {
      const start = pageInfo.total === 0 ? 0 : ((pageInfo.page - 1) * pageInfo.pageSize) + 1;
      const end = Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total);
      const label = pageInfo.total === 0 ? '暂无候选记忆' : '第 ' + start + '-' + end + ' 条，共 ' + pageInfo.total + ' 条';
      return '<div class="pagination"><span>' + esc(label) + '</span><div class="pagination-controls"><button class="ghost" data-candidate-page="prev"' + (pageInfo.page <= 1 ? ' disabled' : '') + '>上一页</button><span>第 ' + pageInfo.page + ' / ' + pageInfo.totalPages + ' 页</span><button class="ghost" data-candidate-page="next"' + (pageInfo.page >= pageInfo.totalPages ? ' disabled' : '') + '>下一页</button></div></div>';
    }
    function knowledgePagination(pageInfo) {
      const start = pageInfo.total === 0 ? 0 : ((pageInfo.page - 1) * pageInfo.pageSize) + 1;
      const end = Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total);
      const label = pageInfo.total === 0 ? '暂无 FAQ' : '第 ' + start + '-' + end + ' 条，共 ' + pageInfo.total + ' 条';
      return '<div class="pagination"><span>' + esc(label) + '</span><div class="pagination-controls"><button class="ghost" data-knowledge-page="prev"' + (pageInfo.page <= 1 ? ' disabled' : '') + '>上一页</button><span>第 ' + pageInfo.page + ' / ' + pageInfo.totalPages + ' 页</span><button class="ghost" data-knowledge-page="next"' + (pageInfo.page >= pageInfo.totalPages ? ' disabled' : '') + '>下一页</button></div></div>';
    }
    function debounce(fn, wait) {
      let timer;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
      };
    }
    async function renderKnowledge() {
      const query = new URLSearchParams({ groupId: state.groupId, page: String(state.knowledgePage), pageSize: String(state.knowledgePageSize) });
      if (state.knowledgeQuery.trim()) query.set('q', state.knowledgeQuery.trim());
      const data = await api('/api/knowledge?' + query.toString());
      const pageInfo = data.pagination || { page: state.knowledgePage, pageSize: state.knowledgePageSize, total: (data.entries || []).length, totalPages: 1 };
      state.currentKnowledge = data.entries || [];
      state.knowledgePage = pageInfo.page;
      content().innerHTML = '<section class="panel"><h2>文本 FAQ</h2><div class="toolbar"><input id="knowledgeSearch" value="' + esc(state.knowledgeQuery) + '" placeholder="搜索标题、问题、答案、关键词"><select id="knowledgePageSize"><option value="10"' + selected(String(state.knowledgePageSize), '10') + '>每页 10 条</option><option value="20"' + selected(String(state.knowledgePageSize), '20') + '>每页 20 条</option><option value="50"' + selected(String(state.knowledgePageSize), '50') + '>每页 50 条</option></select></div>' + knowledgeForm() + '<div class="list">' + state.currentKnowledge.map(rowKnowledge).join('') + '</div>' + knowledgePagination(pageInfo) + '</section>';
      document.querySelector('#knowledgeSearch').addEventListener('input', debounce(event => { state.knowledgeQuery = event.target.value; state.knowledgePage = 1; renderKnowledge(); }, 250));
      document.querySelector('#knowledgePageSize').addEventListener('change', event => { state.knowledgePageSize = Number(event.target.value) || 20; state.knowledgePage = 1; renderKnowledge(); });
    }
    function knowledgeForm() {
      return '<details class="inline-editor"><summary>新增 FAQ</summary><form id="knowledgeForm" class="grid-form"><input name="title" placeholder="标题"><input name="question" placeholder="问题"><input name="answer" placeholder="答案"><input name="keywords" placeholder="关键词，用逗号分隔"><button>新增</button></form></details>';
    }
    function rowKnowledge(k) {
      const meta = '<div class="meta">关键词：' + esc((k.keywords || []).join('、')) + ' · 状态：' + enabledText(k.enabled) + '</div>';
      if (state.editingKnowledgeId !== k.id) {
        return '<article data-knowledge-id="' + esc(k.id) + '"><h3>' + esc(k.title) + '</h3><span>问：' + esc(shortText(k.question, 90)) + '<br>答：' + esc(shortText(k.answer, 140)) + '</span>' + meta + '<div class="actions"><button type="button" data-edit-knowledge="' + esc(k.id) + '">编辑</button><button type="button" data-toggle-knowledge="' + esc(k.id) + '" data-enabled="' + (!k.enabled) + '" class="ghost">' + (k.enabled ? '停用' : '启用') + '</button><button type="button" data-delete-knowledge="' + esc(k.id) + '" class="ghost">' + (state.pendingDelete === k.id ? '确认删除' : '删除') + '</button></div></article>';
      }
      return '<article><form class="knowledgeItemForm" data-knowledge-id="' + esc(k.id) + '"><div class="grid-form"><input name="title" value="' + esc(k.title) + '" placeholder="标题"><input name="question" value="' + esc(k.question) + '" placeholder="问题"><input name="answer" value="' + esc(k.answer) + '" placeholder="答案"><input name="keywords" value="' + esc((k.keywords || []).join(', ')) + '" placeholder="关键词"><select name="enabled"><option value="true"' + selected(String(k.enabled), 'true') + '>启用</option><option value="false"' + selected(String(k.enabled), 'false') + '>停用</option></select></div>' + meta + '<div class="actions"><button type="button" data-save-knowledge="' + esc(k.id) + '">保存编辑</button><button type="button" data-toggle-knowledge="' + esc(k.id) + '" data-enabled="' + (!k.enabled) + '" class="ghost">' + (k.enabled ? '停用' : '启用') + '</button><button type="button" data-cancel-edit>收起</button><button type="button" data-delete-knowledge="' + esc(k.id) + '" class="ghost">' + (state.pendingDelete === k.id ? '确认删除' : '删除') + '</button></div></form></article>';
    }
    async function renderHealth() {
      const data = await api('/api/health');
      content().innerHTML = '<section class="panel"><h2>健康状态</h2><pre>' + esc(JSON.stringify(data, null, 2)) + '</pre></section>';
    }
    function candidatePayload(id) {
      const form = document.querySelector('.candidateForm[data-candidate-id="' + CSS.escape(id) + '"]');
      if (!form) {
        const candidate = state.currentCandidates.find(item => item.id === id) || {};
        return { type: candidate.type, title: candidate.title, content: candidate.content, subjectUserId: candidate.subjectUserId || null };
      }
      const data = Object.fromEntries(new FormData(form).entries());
      return { type: data.type, title: data.title, content: data.content, subjectUserId: data.subjectUserId || null };
    }
    function memoryPayload(id) {
      const form = document.querySelector('.memoryItemForm[data-memory-id="' + CSS.escape(id) + '"]');
      if (!form) {
        const memory = state.currentMemories.find(item => item.id === id) || {};
        return { type: memory.type, title: memory.title, content: memory.content, confidence: Number(memory.confidence), enabled: Boolean(memory.enabled), subjectUserId: memory.subjectUserId || null };
      }
      const data = Object.fromEntries(new FormData(form).entries());
      return { type: data.type, title: data.title, content: data.content, confidence: Number(data.confidence), enabled: data.enabled === 'true', subjectUserId: data.subjectUserId || null };
    }
    function knowledgePayload(id) {
      const form = document.querySelector('.knowledgeItemForm[data-knowledge-id="' + CSS.escape(id) + '"]');
      if (!form) {
        const entry = state.currentKnowledge.find(item => item.id === id) || {};
        return { title: entry.title, question: entry.question, answer: entry.answer, keywords: entry.keywords || [], enabled: Boolean(entry.enabled) };
      }
      const data = Object.fromEntries(new FormData(form).entries());
      return { title: data.title, question: data.question, answer: data.answer, keywords: String(data.keywords || '').split(/[,，、]+/), enabled: data.enabled === 'true' };
    }
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      if (target.dataset.view) { state.view = target.dataset.view; state.subjectUserId = ''; state.memberPage = 1; state.memoryPage = 1; state.candidatePage = 1; state.knowledgePage = 1; await render(); }
      if (target.dataset.jumpView) { state.view = target.dataset.jumpView; state.subjectUserId = ''; state.memberPage = 1; state.memoryPage = 1; state.candidatePage = 1; state.knowledgePage = 1; await render(); }
      if (target.dataset.refreshMembers !== undefined) { await runAction(target, async () => { state.members = []; state.memberPage = 1; await loadMembers(true); await renderMembers(); }, '成员列表已刷新'); }
      if (target.dataset.viewMember) { state.subjectUserId = target.dataset.viewMember; state.view = 'memories'; state.memoryPage = 1; await render(); }
      if (target.dataset.deleteIdentity) { await runAction(target, async () => { await api('/api/groups/' + encodeURIComponent(state.groupId) + '/members/' + encodeURIComponent(target.dataset.deleteIdentity) + '/identity', { method: 'DELETE' }); state.members = []; state.editingMemberId = ''; await renderMembers(); }, '成员备注已删除'); }
      if (target.dataset.editMember) { state.editingMemberId = target.dataset.editMember; await renderMembers(); }
      if (target.dataset.editCandidate) { state.editingCandidateId = target.dataset.editCandidate; await renderCandidates(); }
      if (target.dataset.editMemory) { state.editingMemoryId = target.dataset.editMemory; await renderMemories(); }
      if (target.dataset.editKnowledge) { state.editingKnowledgeId = target.dataset.editKnowledge; await renderKnowledge(); }
      if (target.dataset.cancelEdit !== undefined) { state.editingMemberId = ''; state.editingCandidateId = ''; state.editingMemoryId = ''; state.editingKnowledgeId = ''; await render(); }
      if (target.dataset.saveCandidate) { await runAction(target, async () => { await api('/api/memory-candidates/' + target.dataset.saveCandidate, { method: 'PUT', body: JSON.stringify(candidatePayload(target.dataset.saveCandidate)) }); state.editingCandidateId = ''; await renderCandidates(); }, '候选记忆已保存'); }
      if (target.dataset.approve) { await runAction(target, async () => { await api('/api/memory-candidates/' + target.dataset.approve + '/approve', { method: 'POST', body: JSON.stringify(candidatePayload(target.dataset.approve)) }); await renderCandidates(); }, '候选记忆已批准'); }
      if (target.dataset.approveAsFact) { await runAction(target, async () => { const payload = candidatePayload(target.dataset.approveAsFact); await api('/api/memory-candidates/' + target.dataset.approveAsFact + '/approve', { method: 'POST', body: JSON.stringify({ ...payload, type: 'group_fact', subjectUserId: null }) }); await renderCandidates(); }, '已转为群事实并批准'); }
      if (target.dataset.reject) { await runAction(target, async () => { await api('/api/memory-candidates/' + target.dataset.reject + '/reject', { method: 'POST', body: '{}' }); await renderCandidates(); }, '候选记忆已拒绝'); }
      if (target.dataset.bulkApprove !== undefined) {
        await runAction(target, async () => {
          let skipped = 0;
          for (const candidate of state.currentCandidates) {
            const id = candidate.id;
            try { await api('/api/memory-candidates/' + id + '/approve', { method: 'POST', body: JSON.stringify(candidatePayload(id)) }); } catch { skipped += 1; }
          }
          state.notice = skipped ? '有 ' + skipped + ' 条候选未满足批准条件，已跳过。成员画像必须先选择归属成员。' : '';
          await renderCandidates();
        }, '当前页批量处理完成');
      }
      if (target.dataset.deleteCandidate) { if (state.pendingDelete !== target.dataset.deleteCandidate) { state.pendingDelete = target.dataset.deleteCandidate; await renderCandidates(); return; } await runAction(target, async () => { await api('/api/memory-candidates/' + target.dataset.deleteCandidate, { method: 'DELETE' }); await renderCandidates(); }, '候选记忆已删除'); }
      if (target.dataset.saveMemory) { await runAction(target, async () => { await api('/api/memories/' + target.dataset.saveMemory, { method: 'PUT', body: JSON.stringify(memoryPayload(target.dataset.saveMemory)) }); state.members = []; state.editingMemoryId = ''; await renderMemories(); }, '长期记忆已保存'); }
      if (target.dataset.toggleMemory) { await runAction(target, async () => { await api('/api/memories/' + target.dataset.toggleMemory, { method: 'PUT', body: JSON.stringify({ enabled: target.dataset.enabled === 'true' }) }); await renderMemories(); }, '长期记忆状态已更新'); }
      if (target.dataset.deleteMemory) { if (state.pendingDelete !== target.dataset.deleteMemory) { state.pendingDelete = target.dataset.deleteMemory; await renderMemories(); return; } await runAction(target, async () => { await api('/api/memories/' + target.dataset.deleteMemory, { method: 'DELETE' }); await renderMemories(); }, '长期记忆已删除'); }
      if (target.dataset.memberPage === 'prev') { state.memberPage -= 1; await renderMembers(); }
      if (target.dataset.memberPage === 'next') { state.memberPage += 1; await renderMembers(); }
      if (target.dataset.candidatePage === 'prev') { state.candidatePage -= 1; await renderCandidates(); }
      if (target.dataset.candidatePage === 'next') { state.candidatePage += 1; await renderCandidates(); }
      if (target.dataset.memoryPage === 'prev') { state.memoryPage -= 1; await renderMemories(); }
      if (target.dataset.memoryPage === 'next') { state.memoryPage += 1; await renderMemories(); }
      if (target.dataset.knowledgePage === 'prev') { state.knowledgePage -= 1; await renderKnowledge(); }
      if (target.dataset.knowledgePage === 'next') { state.knowledgePage += 1; await renderKnowledge(); }
      if (target.dataset.saveKnowledge) { await runAction(target, async () => { await api('/api/knowledge/' + target.dataset.saveKnowledge, { method: 'PUT', body: JSON.stringify(knowledgePayload(target.dataset.saveKnowledge)) }); state.editingKnowledgeId = ''; await renderKnowledge(); }, 'FAQ 已保存'); }
      if (target.dataset.toggleKnowledge) { await runAction(target, async () => { await api('/api/knowledge/' + target.dataset.toggleKnowledge, { method: 'PUT', body: JSON.stringify({ enabled: target.dataset.enabled === 'true' }) }); await renderKnowledge(); }, 'FAQ 状态已更新'); }
      if (target.dataset.deleteKnowledge) { if (state.pendingDelete !== target.dataset.deleteKnowledge) { state.pendingDelete = target.dataset.deleteKnowledge; await renderKnowledge(); return; } await runAction(target, async () => { await api('/api/knowledge/' + target.dataset.deleteKnowledge, { method: 'DELETE' }); await renderKnowledge(); }, 'FAQ 已删除'); }
    });
    document.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const data = Object.fromEntries(new FormData(form).entries());
      if (form.classList.contains('memberForm')) {
        await runAction(form.querySelector('button'), async () => {
          await api('/api/groups/' + encodeURIComponent(state.groupId) + '/members/' + encodeURIComponent(form.dataset.userId) + '/identity', { method: 'PUT', body: JSON.stringify({ names: String(data.names || '').split(/[,，、]+/), note: data.note }) });
          state.members = [];
          state.editingMemberId = '';
          await renderMembers();
        }, '成员备注已保存');
        return;
      }
      if (form.id === 'memoryForm') {
        await runAction(form.querySelector('button'), async () => {
          await api('/api/memories', { method: 'POST', body: JSON.stringify({ ...data, groupId: state.groupId, subjectUserId: data.subjectUserId || null }) });
          state.memoryPage = 1;
          await render();
        }, '长期记忆已新增');
      }
      if (form.id === 'knowledgeForm') {
        await runAction(form.querySelector('button'), async () => {
          await api('/api/knowledge', { method: 'POST', body: JSON.stringify({ ...data, groupId: state.groupId, keywords: String(data.keywords || '').split(/[,，、]+/) }) });
          state.knowledgePage = 1;
          await render();
        }, 'FAQ 已新增');
      }
    });
    document.querySelector('#groupFilter').addEventListener('change', async (event) => { state.groupId = event.target.value; state.members = []; state.subjectUserId = ''; state.memberPage = 1; state.memoryPage = 1; state.candidatePage = 1; state.knowledgePage = 1; await render(); });
    document.querySelector('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
    loadGroups().then(render);
  </script>
</body>
</html>`;

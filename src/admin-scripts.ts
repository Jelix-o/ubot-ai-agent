export const LOGIN_JS = String.raw`
document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (res.ok) location.href = '/';
  else document.querySelector('#message').textContent = '账号或密码错误';
});
`.trimStart();

export const ADMIN_APP_JS = String.raw`
const state = { view: 'overview', groups: [], groupId: '', memberQuery: '', memberPage: 1, memberPageSize: 24, editingMemberId: '', expandedProfileMemberId: '', subjectUserId: '', candidateType: '', candidateStatus: 'pending', candidateQuery: '', selectedCandidateIds: new Set(), selectedMemoryIds: new Set(), expandedCandidateIds: new Set(), expandedMemoryIds: new Set(), memoryQuery: '', memoryType: '', memoryEnabled: '', knowledgeQuery: '', pendingDelete: '', notice: '', memoryPage: 1, memoryPageSize: 20, candidatePage: 1, candidatePageSize: 20, knowledgePage: 1, knowledgePageSize: 20, editingCandidateId: '', editingMemoryId: '', editingKnowledgeId: '', currentMembers: [], currentCandidates: [], currentMemories: [], currentKnowledge: [], profileSummaries: new Map(), ownerMembersByGroup: new Map(), ownerMembersInflight: new Map(), ownerMemberVersions: new Map() };
let renderVersion = 0;
let renderAbortController = null;
let groupsLoadedAt = 0;
let groupsInflight = null;
const renderCache = new Map();
const renderCacheTtlMs = 8000;
let ownerMemberSearchTimer = null;
let isApplyingHistoryState = false;
const titleByView = { overview: '总览', groups: '群配置', members: '成员管理', candidates: '候选记忆', memories: '长期记忆', knowledge: '知识库', health: '健康状态' };
const subtitleByView = {
  overview: '掌握当前群聊助手的关键数据与运行状态',
  groups: '管理自动回复、定时规则、权限和人工身份，让每个群有独立策略',
  members: '查看成员备注、长期记忆和完整画像，快速定位需要维护的人',
  candidates: '审核模型提取的候选记忆，决定是否进入长期记忆库',
  memories: '维护已批准的长期记忆，控制归属、状态和来源证据',
  knowledge: '管理群内 FAQ 和可复用回答，减少重复解释',
  health: '监控 NapCat、画像模型和运行环境，及时发现异常',
};
const validViews = new Set(Object.keys(titleByView));
const content = () => document.querySelector('#content');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const selected = (left, right) => left === right ? ' selected' : '';
const themeStorageKey = 'ubot-admin-theme';
function resolveTheme(mode) {
  return mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : mode === 'dark' ? 'dark' : 'light';
}
function applyTheme(mode = localStorage.getItem(themeStorageKey) || 'system') {
  document.documentElement.dataset.theme = resolveTheme(mode);
  document.documentElement.dataset.themeMode = mode;
  document.querySelectorAll('[data-theme-option]').forEach(button => button.classList.toggle('active', button.dataset.themeOption === mode));
}
const typeText = (value) => value === 'member_profile' ? '成员画像' : '群事实';
const statusText = (value) => ({ pending: '待审', approved: '已批准', rejected: '已拒绝' }[value] || value);
const enabledText = (value) => value ? '启用' : '停用';
const ownerLabel = (item) => item.subjectLabel?.label || (item.type === 'member_profile' && !item.subjectUserId ? '未归属' : '群整体');
const shortText = (value, limit = 160) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '...' : text;
};
const cloneData = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};
const nextRenderToken = () => {
  renderAbortController?.abort();
  renderAbortController = new AbortController();
  return ++renderVersion;
};
const isLatestRender = (token) => token === renderVersion;
const setPageLoading = (message = '正在更新列表...') => {
  const panel = content()?.querySelector('section.panel');
  if (!panel) return;
  let node = panel.querySelector('[data-page-loading]');
  if (!node) {
    node = document.createElement('div');
    node.className = 'page-loading';
    node.dataset.pageLoading = '1';
    panel.prepend(node);
  }
  node.textContent = message;
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
  if (evidence.hasFullEvidence) {
    return '<div class="evidence" data-evidence-box="' + esc(item.id) + '"><b>来源证据</b><span>' + esc(evidence.messageCount) + ' 条 · ' + esc(evidence.startAt) + ' 至 ' + esc(evidence.endAt) + ' · ' + esc(evidence.speakerCount) + ' 人参与</span><em>' + esc(evidence.summaryPreview || '无摘要') + '</em><button type="button" class="ghost" data-load-evidence="' + esc(item.id) + '" data-evidence-kind="' + esc(item.status ? 'candidate' : 'memory') + '">查看完整来源</button></div>';
  }
  const speakers = (evidence.speakers || []).map(s => (s.userName ? esc(s.userName) + ' / QQ ' + esc(s.userId) : 'QQ ' + esc(s.userId))).join('、') || '无';
  const summary = shortText(evidence.summary, 120);
  return '<details class="evidence"><summary><b>来源证据</b><span>' + esc(evidence.messageCount) + ' 条 · ' + esc(evidence.startAt) + ' 至 ' + esc(evidence.endAt) + ' · ' + esc((evidence.speakers || []).length) + ' 人参与</span><em>' + esc(summary) + '</em></summary><div class="evidence-body"><p>' + esc(evidence.summary) + '</p><span>参与：' + speakers + '</span></div></details>';
};
const fullEvidenceHtml = (item) => {
  if (!item?.evidence || item.evidence.hasFullEvidence) return evidenceHtml(item || {});
  return evidenceHtml(item);
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
const apiForRender = async (url) => {
  try {
    const cached = renderCache.get(url);
    if (cached && Date.now() - cached.time < renderCacheTtlMs) return cloneData(cached.data);
    const data = await api(url, { signal: renderAbortController?.signal });
    renderCache.set(url, { time: Date.now(), data: cloneData(data) });
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    throw error;
  }
};
function invalidateRenderCache(match) {
  if (!match) {
    renderCache.clear();
    return;
  }
  for (const key of renderCache.keys()) {
    if (typeof match === 'string' ? key.startsWith(match) : match.test(key)) renderCache.delete(key);
  }
}
function invalidateGroupsCache() {
  groupsLoadedAt = 0;
  invalidateRenderCache('/api/groups');
}
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
const preloadOwnerMembers = () => {
  void ensureOwnerMembers().catch(error => toast(error.message || '成员列表加载失败', 'error'));
};
function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (view && validViews.has(view)) state.view = view;
  state.groupId = params.get('groupId') || state.groupId;
  state.memberQuery = params.get('memberQuery') || '';
  state.memberPage = positiveInt(params.get('memberPage'), state.memberPage);
  state.memberPageSize = positiveInt(params.get('memberPageSize'), state.memberPageSize);
  state.subjectUserId = params.get('subjectUserId') || '';
  state.candidateType = params.get('candidateType') || '';
  state.candidateStatus = params.has('candidateStatus') ? params.get('candidateStatus') || '' : state.candidateStatus;
  state.candidateQuery = params.get('candidateQuery') || '';
  state.candidatePage = positiveInt(params.get('candidatePage'), state.candidatePage);
  state.candidatePageSize = positiveInt(params.get('candidatePageSize'), state.candidatePageSize);
  state.memoryQuery = params.get('memoryQuery') || '';
  state.memoryType = params.get('memoryType') || '';
  state.memoryEnabled = params.get('memoryEnabled') || '';
  state.memoryPage = positiveInt(params.get('memoryPage'), state.memoryPage);
  state.memoryPageSize = positiveInt(params.get('memoryPageSize'), state.memoryPageSize);
  state.knowledgeQuery = params.get('knowledgeQuery') || '';
  state.knowledgePage = positiveInt(params.get('knowledgePage'), state.knowledgePage);
  state.knowledgePageSize = positiveInt(params.get('knowledgePageSize'), state.knowledgePageSize);
}
function positiveInt(value, fallback) {
  const next = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}
function syncUrlState({ replace = false } = {}) {
  if (isApplyingHistoryState) return;
  const params = new URLSearchParams();
  setUrlParam(params, 'view', state.view, 'overview');
  setUrlParam(params, 'groupId', state.groupId, '');
  if (state.view === 'members') {
    setUrlParam(params, 'memberQuery', state.memberQuery, '');
    setUrlParam(params, 'memberPage', String(state.memberPage), '1');
    setUrlParam(params, 'memberPageSize', String(state.memberPageSize), '24');
  }
  if (state.view === 'candidates') {
    setUrlParam(params, 'subjectUserId', state.subjectUserId, '');
    setUrlParam(params, 'candidateType', state.candidateType, '');
    setUrlParam(params, 'candidateStatus', state.candidateStatus, 'pending');
    setUrlParam(params, 'candidateQuery', state.candidateQuery, '');
    setUrlParam(params, 'candidatePage', String(state.candidatePage), '1');
    setUrlParam(params, 'candidatePageSize', String(state.candidatePageSize), '20');
  }
  if (state.view === 'memories') {
    setUrlParam(params, 'subjectUserId', state.subjectUserId, '');
    setUrlParam(params, 'memoryQuery', state.memoryQuery, '');
    setUrlParam(params, 'memoryType', state.memoryType, '');
    setUrlParam(params, 'memoryEnabled', state.memoryEnabled, '');
    setUrlParam(params, 'memoryPage', String(state.memoryPage), '1');
    setUrlParam(params, 'memoryPageSize', String(state.memoryPageSize), '20');
  }
  if (state.view === 'knowledge') {
    setUrlParam(params, 'knowledgeQuery', state.knowledgeQuery, '');
    setUrlParam(params, 'knowledgePage', String(state.knowledgePage), '1');
    setUrlParam(params, 'knowledgePageSize', String(state.knowledgePageSize), '20');
  }
  const nextUrl = location.pathname + (params.toString() ? '?' + params.toString() : '');
  if (nextUrl === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', nextUrl);
}
function setUrlParam(params, key, value, defaultValue) {
  const normalized = String(value ?? '');
  if (normalized && normalized !== defaultValue) params.set(key, normalized);
}
function clearTransientState() {
  state.pendingDelete = '';
  state.notice = '';
  state.editingMemberId = '';
  state.editingCandidateId = '';
  state.editingMemoryId = '';
  state.editingKnowledgeId = '';
  state.selectedCandidateIds = new Set();
  state.selectedMemoryIds = new Set();
  state.expandedCandidateIds = new Set();
  state.expandedMemoryIds = new Set();
}
async function navigateTo(view, options = {}) {
  state.view = view;
  if (options.clearSubject !== false) state.subjectUserId = '';
  state.memberPage = 1;
  state.memoryPage = 1;
  state.candidatePage = 1;
  state.knowledgePage = 1;
  clearTransientState();
  syncUrlState();
  await render();
}
async function loadGroups(options = {}) {
  const maxAgeMs = options.maxAgeMs ?? 30000;
  if (!options.refresh && state.groups.length && Date.now() - groupsLoadedAt < maxAgeMs) {
    document.querySelector('#groupFilter').value = state.groupId;
    return;
  }
  if (!options.refresh && groupsInflight) return groupsInflight;
  const work = api('/api/groups').then(data => {
  state.groups = data.groups || [];
  if (!state.groups.some(group => group.groupId === state.groupId)) {
    state.groupId = state.groups[0]?.groupId || '';
  }
  document.querySelector('#groupFilter').innerHTML = state.groups.map(g => '<option value="' + esc(g.groupId) + '">' + esc(g.groupId) + '</option>').join('');
  document.querySelector('#groupFilter').value = state.groupId;
    groupsLoadedAt = Date.now();
  }).finally(() => {
    if (groupsInflight === work) groupsInflight = null;
  });
  groupsInflight = work;
  return work;
}
function memberFilterControl(id, selectedUserId = '') {
  return '<input id="' + id + '" value="' + esc(selectedUserId) + '" list="ownerMemberOptions" placeholder="归属 QQ，留空全部">';
}
function ownerInput(name, selectedUserId = '', label = '') {
  return ownerMemberOptionsSlotHtml(true) + '<label class="owner-field"><input name="' + name + '" value="' + esc(selectedUserId) + '" list="ownerMemberOptions" placeholder="归属 QQ，留空为群整体"><span>' + esc(label || (selectedUserId ? '当前 QQ ' + selectedUserId : '群整体')) + '</span></label>';
}
function filterSummaryHtml(kind, items) {
  const activeItems = items.filter(item => item.value !== undefined && item.value !== null && String(item.value) !== '' && String(item.value) !== item.defaultValue);
  const clearAction = kind === 'candidate' ? 'data-clear-candidate-filters' : kind === 'memory' ? 'data-clear-memory-filters' : kind === 'member' ? 'data-clear-member-filters' : 'data-clear-knowledge-filters';
  const countText = activeItems.length ? '已启用 ' + activeItems.length + ' 个筛选' : '未启用筛选';
  const chips = activeItems.length
    ? activeItems.map(item => '<span class="filter-chip"><b>' + esc(item.label) + '</b>' + esc(item.text ?? item.value) + '</span>').join('')
    : '<span class="filter-chip muted">显示当前群默认列表</span>';
  return '<div class="filter-summary"><div><strong>' + countText + '</strong><span>' + chips + '</span></div><button type="button" class="ghost" ' + clearAction + (activeItems.length ? '' : ' disabled') + '>清空筛选</button></div>';
}
function pageStatStrip(items) {
  return '<div class="stat-strip">' + items.map(item => '<div><b>' + esc(item.value) + '</b><span>' + esc(item.label) + '</span></div>').join('') + '</div>';
}
function resetGroupScopedState() {
  state.memberQuery = '';
  state.subjectUserId = '';
  state.candidateType = '';
  state.candidateStatus = 'pending';
  state.candidateQuery = '';
  state.selectedCandidateIds = new Set();
  state.selectedMemoryIds = new Set();
  state.expandedCandidateIds = new Set();
  state.expandedMemoryIds = new Set();
  state.memoryQuery = '';
  state.memoryType = '';
  state.memoryEnabled = '';
  state.knowledgeQuery = '';
  state.pendingDelete = '';
  state.notice = '';
  state.memberPage = 1;
  state.memoryPage = 1;
  state.candidatePage = 1;
  state.knowledgePage = 1;
  state.editingMemberId = '';
  state.editingCandidateId = '';
  state.editingMemoryId = '';
  state.editingKnowledgeId = '';
  state.currentMembers = [];
  state.currentCandidates = [];
  state.currentMemories = [];
  state.currentKnowledge = [];
}
function ownerMemberOptionsHtml() {
  const members = state.ownerMembersByGroup.get(state.groupId) || [];
  return '<datalist id="ownerMemberOptions">' + members.map(member => {
    const parts = [member.displayName, member.note, member.card, member.nickname].filter(Boolean);
    return '<option value="' + esc(member.userId) + '" label="' + esc(parts.join(' / ') || ('QQ ' + member.userId)) + '"></option>';
  }).join('') + '</datalist>';
}
function ownerMemberOptionsSlotHtml(renderOptions = false) {
  return '<span data-owner-member-options>' + (renderOptions ? ownerMemberOptionsHtml() : '') + '</span>';
}
function refreshOwnerMemberOptionsSlot() {
  const slot = document.querySelector('[data-owner-member-options]');
  if (slot) slot.innerHTML = ownerMemberOptionsHtml();
}
async function ensureOwnerMembers(options = {}) {
  if (!state.groupId) return;
  const search = String(options.query || '').trim();
  if (!search && state.ownerMembersByGroup.has(state.groupId)) return;
  const groupId = state.groupId;
  const inflightKey = groupId + ':' + search;
  const existing = state.ownerMembersInflight.get(inflightKey);
  if (existing) return existing;
  const version = state.ownerMemberVersions.get(groupId) || 0;
  const query = search
    ? new URLSearchParams({ q: search, page: '1', pageSize: String(options.pageSize || 20) })
    : new URLSearchParams({ all: '1', pageSize: String(options.pageSize || 100) });
  if (options.refresh) query.set('refresh', '1');
  const promise = api('/api/groups/' + encodeURIComponent(groupId) + '/members?' + query.toString())
    .then(data => {
      if ((state.ownerMemberVersions.get(groupId) || 0) === version) {
        const members = data.members || [];
        if (search) mergeOwnerMembers(groupId, members);
        else state.ownerMembersByGroup.set(groupId, members);
        refreshOwnerMemberOptionsSlot();
      }
    })
    .finally(() => {
      if (state.ownerMembersInflight.get(inflightKey) === promise) state.ownerMembersInflight.delete(inflightKey);
    });
  state.ownerMembersInflight.set(inflightKey, promise);
  return promise;
}
function mergeOwnerMembers(groupId, members) {
  const current = state.ownerMembersByGroup.get(groupId) || [];
  const byId = new Map(current.map(member => [member.userId, member]));
  for (const member of members) {
    if (member?.userId) byId.set(member.userId, member);
  }
  state.ownerMembersByGroup.set(groupId, [...byId.values()]);
}
function clearOwnerMemberInflight(groupId) {
  for (const key of state.ownerMembersInflight.keys()) {
    if (key === groupId || key.startsWith(groupId + ':')) state.ownerMembersInflight.delete(key);
  }
}
function invalidateMemberCaches() {
  state.profileSummaries = new Map();
  invalidateGroupsCache();
  invalidateRenderCache('/api/overview');
}
function invalidateCandidateCaches() {
  invalidateRenderCache('/api/memory-candidates');
  invalidateRenderCache('/api/memories');
  invalidateRenderCache('/api/overview');
  invalidateGroupsCache();
}
function invalidateMemoryCaches() {
  state.profileSummaries = new Map();
  invalidateRenderCache('/api/memories');
  invalidateRenderCache('/api/overview');
  invalidateGroupsCache();
}
function invalidateKnowledgeCaches() {
  invalidateRenderCache('/api/knowledge');
  invalidateRenderCache('/api/overview');
}
function scheduleOwnerMemberSearch(value) {
  clearTimeout(ownerMemberSearchTimer);
  const query = String(value || '').trim();
  ownerMemberSearchTimer = setTimeout(() => {
    const options = query && !/^\d+$/.test(query)
      ? { query, pageSize: 20 }
      : { pageSize: 100 };
    void ensureOwnerMembers(options).catch(error => toast(error.message || '成员搜索失败', 'error'));
  }, query ? 180 : 0);
}
function syncGlobalSearchInput() {
  const input = document.querySelector('#globalSearch');
  if (!(input instanceof HTMLInputElement)) return;
  const value = state.view === 'members'
    ? state.memberQuery
    : state.view === 'candidates'
      ? state.candidateQuery
      : state.view === 'memories'
        ? state.memoryQuery
        : state.view === 'knowledge'
          ? state.knowledgeQuery
          : '';
  if (input.value !== value) input.value = value;
}
async function applyGlobalSearch(value) {
  const query = String(value || '').trim();
  if (state.view === 'overview' || state.view === 'groups' || state.view === 'health') {
    clearTransientState();
    if (looksLikeMemberSearch(query)) {
      state.view = 'members';
      state.memberQuery = query;
      state.memberPage = 1;
    } else if (/faq|知识|问答|问题|答案/i.test(query)) {
      state.view = 'knowledge';
      state.knowledgeQuery = query.replace(/faq|知识|问答|问题|答案/ig, '').trim();
      state.knowledgePage = 1;
    } else if (/候选|待审|审核/i.test(query)) {
      state.view = 'candidates';
      state.candidateQuery = query.replace(/候选|待审|审核/ig, '').trim();
      state.candidatePage = 1;
    } else {
      state.view = 'memories';
      state.memoryQuery = query;
      state.memoryPage = 1;
    }
    syncUrlState();
    await render();
    return;
  }
  if (state.view === 'members') {
    state.memberQuery = query;
    state.memberPage = 1;
    syncUrlState({ replace: true });
    await renderMembers();
    return;
  }
  if (state.view === 'candidates') {
    state.candidateQuery = query;
    state.candidatePage = 1;
    syncUrlState({ replace: true });
    await renderCandidates();
    return;
  }
  if (state.view === 'memories') {
    state.memoryQuery = query;
    state.memoryPage = 1;
    syncUrlState({ replace: true });
    await renderMemories();
    return;
  }
  if (state.view === 'knowledge') {
    state.knowledgeQuery = query;
    state.knowledgePage = 1;
    syncUrlState({ replace: true });
    await renderKnowledge();
  }
}
function looksLikeMemberSearch(query) {
  if (!query) return false;
  if (/^\d{5,12}$/.test(query)) return true;
  if (/[成员|用户|昵称|备注|画像]/.test(query)) return true;
  if (/^[\u4e00-\u9fff]{2,8}$/.test(query) && !/记忆|长期|群聊|知识|问答|候选|审核|健康/.test(query)) return true;
  return false;
}
async function refreshCurrentView() {
  invalidateRenderCache();
  if (state.view === 'members') {
    await renderMembers(true);
    return;
  }
  if (state.view === 'groups') {
    await loadGroups({ refresh: true });
  }
  await render();
}
async function render() {
  try {
    document.querySelector('#viewTitle').textContent = titleByView[state.view];
    const subtitle = document.querySelector('#viewSubtitle');
    if (subtitle) subtitle.textContent = subtitleByView[state.view] || '';
    syncGlobalSearchInput();
    document.querySelectorAll('nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view));
    state.pendingDelete = '';
    if (state.view === 'overview') return await renderOverview();
    if (state.view === 'groups') return await renderGroups();
    if (state.view === 'members') return await renderMembers();
    if (state.view === 'candidates') return await renderCandidates();
    if (state.view === 'memories') return await renderMemories();
    if (state.view === 'knowledge') return await renderKnowledge();
    return await renderHealth();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    toast(error.message || '页面加载失败', 'error');
  }
}
async function renderOverview() {
  const token = nextRenderToken();
  const groupQuery = state.groupId ? '?groupId=' + encodeURIComponent(state.groupId) : '';
  const data = await apiForRender('/api/overview' + groupQuery);
  if (!data || !isLatestRender(token)) return;
  const recent = data.recent || {};
  content().innerHTML = '<div class="metric-row"><div><b>' + data.stats.groupCount + '</b><span>已配置群</span></div><div><b>' + data.stats.pendingCandidateCount + '</b><span>当前群待审记忆</span></div><div><b>' + data.stats.memoryCount + '</b><span>当前群长期记忆</span></div><div><b>' + data.stats.knowledgeCount + '</b><span>当前群 FAQ</span></div></div><div class="workbench-grid"><section class="panel"><div class="section-head"><div><h2>当前群待处理</h2><p>优先处理待审候选，避免有价值的信息堆积。</p></div><button data-jump-view="candidates" class="ghost">进入审核</button></div>' + overviewCandidates(recent.candidates || []) + '<div class="quick-actions"><button data-jump-view="candidates">审核候选记忆</button><button data-jump-view="members" class="ghost">维护成员备注</button><button data-jump-view="memories" class="ghost">查看长期记忆</button></div></section><section class="panel"><div class="section-head"><div><h2>运行状态</h2><p>模型和传输层异常会影响画像、记忆或消息收发。</p></div><button data-jump-view="health" class="ghost">查看详情</button></div>' + healthSummaryHtml(data.transportHealth, data.profileAiHealth) + '<div class="quick-actions"><button data-jump-view="health" class="ghost">查看健康状态</button><button data-jump-view="groups" class="ghost">查看群配置</button></div></section><section class="panel"><div class="section-head"><div><h2>最新长期记忆</h2><p>最近写入或更新的正式记忆。</p></div></div>' + overviewMemories(recent.memories || []) + '</section><section class="panel"><div class="section-head"><div><h2>知识库</h2><p>当前群可复用 FAQ。</p></div><button data-jump-view="knowledge" class="ghost">维护 FAQ</button></div>' + overviewKnowledge(recent.knowledge || []) + '</section></div>';
}
function healthSummaryHtml(transportHealth, profileAiHealth) {
  return '<div class="compact-list"><div class="compact-row"><b><span class="status-dot ' + (transportHealth?.ok ? '' : 'bad') + '"></span>NapCat 连接</b><span>' + esc(transportHealth?.ok ? '正常' : '异常') + '</span><span>' + esc(transportHealth?.detail || '暂无详情') + '</span></div><div class="compact-row"><b><span class="status-dot ' + (profileAiHealth?.ok ? '' : 'bad') + '"></span>画像/记忆模型</b><span>' + esc(profileAiHealth?.ok ? '正常' : '异常') + (profileAiHealth?.cached ? ' · 缓存' : '') + '</span><span>' + esc(profileAiHealth?.detail || '暂无详情') + '</span></div></div>';
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
  const token = nextRenderToken();
  setPageLoading('正在更新群配置...');
  const data = await apiForRender('/api/groups');
  if (!isLatestRender(token)) return;
  state.groups = data?.groups || [];
  groupsLoadedAt = Date.now();
  const activeGroup = state.groups.find(group => group.groupId === state.groupId) || state.groups[0] || {};
  const stats = pageStatStrip([
    { label: '已配置群', value: state.groups.length },
    { label: '当前技能', value: activeGroup.currentSkillId || '-' },
    { label: '管理员', value: (activeGroup.switcherUserIds || []).length },
    { label: '实时对话', value: (activeGroup.liveChatUserIds || []).length },
  ]);
  content().innerHTML = '<section class="panel"><div class="section-head"><div><h2>群配置</h2><p>编辑自动回复、定时规则、权限和人工身份。保存后当前群会按新策略运行。</p></div><button type="button" data-refresh-groups>刷新群配置</button></div>' + stats + '<div class="group-config-list">' + state.groups.map(rowGroupConfig).join('') + '</div></section>';
}
function rowGroupConfig(g) {
  const open = g.groupId === state.groupId ? ' open' : '';
  const delay = g.liveChatDelaySeconds || ((g.liveChatDelayMinutes || 5) * 60);
  const summary = '<div class="group-config-summary"><div class="group-avatar">群</div><div><h3>群 ' + esc(g.groupId) + '</h3><span>技能 ' + esc(g.currentSkillId) + ' · 模型 ' + esc((g.replyModelMode || 'gpt').toUpperCase()) + '</span></div><div><span>管理员</span><b>' + esc((g.switcherUserIds || []).length) + '</b></div><div><span>实时对话</span><b>' + esc((g.liveChatUserIds || []).length) + '</b></div><div><span>黑名单</span><b>' + esc((g.blacklistedUserIds || []).length) + '</b></div><div><span>状态</span><b>' + esc(g.botMuted ? '静音' : '运行') + '</b></div></div>';
  const basic = '<section class="settings-card"><h3>基础设置</h3><div class="settings-grid"><label>当前技能<input name="currentSkillId" value="' + esc(g.currentSkillId) + '" required></label><label>回复模型<select name="replyModelMode"><option value="gpt"' + selected(g.replyModelMode || 'gpt', 'gpt') + '>GPT</option><option value="mimo"' + selected(g.replyModelMode || 'gpt', 'mimo') + '>Mimo/Profile</option></select></label><label>实时对话延迟秒数<input name="liveChatDelaySeconds" type="number" min="1" value="' + esc(delay) + '"></label><label>日报人数<input name="dailyReportTopUserCount" type="number" min="1" value="' + esc(g.dailyReportTopUserCount || 5) + '"></label></div></section>';
  const strategy = '<section class="settings-card"><h3>回复策略</h3><div class="settings-grid"><label class="settings-wide">允许技能<textarea name="allowedSkillIds">' + esc(lines(g.allowedSkillIds)) + '</textarea></label><label><input type="checkbox" name="dailyReportEnabled"' + checked(g.dailyReportEnabled !== false) + '> 群聊日报</label><label><input type="checkbox" name="holidayCountdownEnabled"' + checked(g.holidayCountdownEnabled !== false) + '> 节日倒计时</label><label><input type="checkbox" name="scheduledRemindersEnabled"' + checked(g.scheduledRemindersEnabled !== false) + '> 定时提醒</label><label><input type="checkbox" name="opsAlertsEnabled"' + checked(g.opsAlertsEnabled !== false) + '> 运维告警</label><label><input type="checkbox" name="botMuted"' + checked(g.botMuted === true) + '> 机器人静音</label></div></section>';
  const members = '<section class="settings-card"><h3>群管理</h3><div class="settings-grid"><label>管理员 QQ<textarea name="switcherUserIds">' + esc(lines(g.switcherUserIds)) + '</textarea></label><label>实时对话 QQ<textarea name="liveChatUserIds">' + esc(lines(g.liveChatUserIds)) + '</textarea></label><label>黑名单 QQ<textarea name="blacklistedUserIds">' + esc(lines(g.blacklistedUserIds)) + '</textarea></label><label>日报时间<input name="dailyReportTime" type="time" value="' + esc(g.dailyReportTime || '17:59') + '"></label><label>节日倒计时<input name="holidayCountdownTime" type="time" value="' + esc(g.holidayCountdownTime || '09:00') + '"></label></div></section>';
  const identity = '<section class="settings-card settings-card-wide"><div class="settings-card-head"><h3>人工身份 JSON</h3><span>影响成员识别、画像展示和群聊称呼</span></div><textarea name="manualIdentities" spellcheck="false">' + esc(JSON.stringify(g.manualIdentities || [], null, 2)) + '</textarea></section>';
  return '<article class="group-config-card" data-group-config-id="' + esc(g.groupId) + '"><details' + open + '><summary>' + summary + '</summary><form class="settings-form groupConfigForm" data-group-id="' + esc(g.groupId) + '"><div class="settings-layout">' + basic + strategy + members + identity + '</div><div class="sticky-actions"><button type="submit">保存群配置</button><button type="button" class="ghost" data-reload-group-config="' + esc(g.groupId) + '">重新读取</button><span class="meta">保存前请确认 QQ、时间和 JSON 格式。</span></div></form></details></article>';
}
const checked = (value) => value ? ' checked' : '';
const lines = (value) => (value || []).join('\n');
async function renderMembers(force = false) {
  const token = nextRenderToken();
  setPageLoading(force ? '正在同步群成员...' : '正在更新成员列表...');
  if (force) {
    state.ownerMemberVersions.set(state.groupId, (state.ownerMemberVersions.get(state.groupId) || 0) + 1);
    clearOwnerMemberInflight(state.groupId);
    state.ownerMembersByGroup.delete(state.groupId);
  }
  const query = new URLSearchParams({ page: String(state.memberPage), pageSize: String(state.memberPageSize) });
  if (state.memberQuery.trim()) query.set('q', state.memberQuery.trim());
  if (force) query.set('refresh', '1');
  const data = await apiForRender('/api/groups/' + encodeURIComponent(state.groupId) + '/members?' + query.toString());
  if (!data || !isLatestRender(token)) return;
  const pageInfo = data.pagination || { page: state.memberPage, pageSize: state.memberPageSize, total: (data.members || []).length, totalPages: 1 };
  state.currentMembers = data.members || [];
  if (!state.memberQuery.trim() && state.memberPage === 1 && state.currentMembers.length >= pageInfo.total) {
    state.ownerMembersByGroup.set(state.groupId, state.currentMembers);
  }
  state.memberPage = pageInfo.page;
  const empty = state.currentMembers.length ? '' : '<p class="message">没有符合筛选条件的成员。</p>';
  const memberMemoryTotal = state.currentMembers.reduce((sum, member) => sum + Number(member.memoryCount || 0), 0);
  const memberPendingTotal = state.currentMembers.reduce((sum, member) => sum + Number(member.pendingCandidateCount || 0), 0);
  const manualCount = state.currentMembers.filter(member => member.hasManualIdentity).length;
  const memberStats = '<div class="stat-strip"><div><b>' + esc(pageInfo.total) + '</b><span>匹配成员</span></div><div><b>' + esc(memberMemoryTotal) + '</b><span>当前页记忆数</span></div><div><b>' + esc(memberPendingTotal) + '</b><span>当前页待审</span></div><div><b>' + esc(manualCount) + '</b><span>已维护身份</span></div></div>';
  const summary = filterSummaryHtml('member', [
    { label: '搜索', value: state.memberQuery },
    { label: '每页', value: String(state.memberPageSize), defaultValue: '24', text: state.memberPageSize + ' 人' },
  ]);
  content().innerHTML = '<section class="panel"><div class="section-head"><div><h2>成员列表</h2><p>成员备注会影响画像展示和机器人识别，优先维护核心成员。</p></div><button data-refresh-members>同步群成员</button></div>' + memberStats + '<div class="toolbar"><input id="memberSearch" value="' + esc(state.memberQuery) + '" placeholder="搜索 QQ、名字、别名、备注"><select id="memberPageSize"><option value="12"' + selected(String(state.memberPageSize), '12') + '>每页 12 人</option><option value="24"' + selected(String(state.memberPageSize), '24') + '>每页 24 人</option><option value="48"' + selected(String(state.memberPageSize), '48') + '>每页 48 人</option></select><span class="meta">默认显示本地身份和已有记忆，必要时再同步 NapCat 群成员。</span></div>' + summary + empty + '<div class="member-grid">' + state.currentMembers.map(rowMember).join('') + '</div>' + listPagination('member', pageInfo, '成员') + '</section>';
  document.querySelector('#memberSearch')?.addEventListener('input', debounce(event => { state.memberQuery = event.target.value; state.memberPage = 1; syncUrlState({ replace: true }); renderMembers(); }, 180));
  document.querySelector('#memberPageSize')?.addEventListener('change', event => { state.memberPageSize = Number(event.target.value) || 24; state.memberPage = 1; syncUrlState(); renderMembers(); });
}
function rowMember(m) {
  const meta = '<div class="member-meta">QQ ' + esc(m.userId) + (m.card ? ' · 群名片 ' + esc(m.card) : '') + (m.nickname ? ' · 昵称 ' + esc(m.nickname) : '') + (m.role ? ' · 角色 ' + esc(m.role) : '') + (m.note ? ' · 备注：' + esc(m.note) : '') + '</div>';
  const badges = '<div><span class="badge">' + m.memoryCount + ' 条记忆</span> <span class="badge warn">' + m.pendingCandidateCount + ' 条待审</span>' + ((m.aliases || []).length ? ' <span class="badge">' + esc((m.aliases || []).join('、')) + '</span>' : '') + '</div>';
  const profileActions = '<button type="button" class="ghost" data-load-profile-summary="' + esc(m.userId) + '" data-profile-type="overall">查看群聊画像</button><button type="button" class="ghost" data-load-profile-summary="' + esc(m.userId) + '" data-profile-type="yesterday">查看昨日画像</button>';
  const profileSummary = profileSummaryHtml(m.userId);
  if (state.editingMemberId !== m.userId) {
    return '<article data-member-id="' + esc(m.userId) + '"><h3>' + esc(m.displayName) + '</h3>' + meta + badges + '<div class="actions"><button type="button" data-edit-member="' + esc(m.userId) + '">编辑备注</button><button type="button" class="ghost" data-view-member="' + esc(m.userId) + '">查看记忆</button>' + profileActions + (m.hasManualIdentity ? '<button type="button" class="ghost" data-delete-identity="' + esc(m.userId) + '">' + (state.pendingDelete === 'identity:' + m.userId ? '确认删除备注' : '删除备注') + '</button>' : '') + '</div>' + profileSummary + '</article>';
  }
  return '<article data-member-id="' + esc(m.userId) + '"><h3>' + esc(m.displayName) + '</h3>' + meta + badges + '<form class="memberForm" data-user-id="' + esc(m.userId) + '"><input name="names" value="' + esc((m.aliases || []).join(', ')) + '" placeholder="别名，用逗号分隔"><input name="note" value="' + esc(m.note || '') + '" placeholder="系统备注"><div class="actions"><button>保存备注</button><button type="button" data-cancel-edit>收起</button><button type="button" class="ghost" data-view-member="' + esc(m.userId) + '">查看记忆</button>' + profileActions + (m.hasManualIdentity ? '<button type="button" class="ghost" data-delete-identity="' + esc(m.userId) + '">' + (state.pendingDelete === 'identity:' + m.userId ? '确认删除备注' : '删除备注') + '</button>' : '') + '</div></form>' + profileSummary + '</article>';
}
function profileSummaryKey(userId, type) {
  return state.groupId + ':' + userId + ':' + type;
}
function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}
function profileSummaryHtml(userId) {
  if (state.expandedProfileMemberId !== userId) return '';
  const entries = ['overall', 'yesterday']
    .map(type => state.profileSummaries.get(profileSummaryKey(userId, type)))
    .filter(Boolean);
  if (!entries.length) return '';
  return entries.map(entry => {
    const title = entry.type === 'yesterday' ? '昨日画像全文' : '群聊画像全文';
    if (entry.loading) {
      return '<div class="detail-block profile-summary"><b>' + title + '</b><p class="message">正在生成画像...</p></div>';
    }
    if (entry.error) {
      return '<div class="detail-block profile-summary"><b>' + title + '</b><p class="message danger">' + esc(entry.error) + '</p></div>';
    }
    const data = entry.data || {};
    const meta = [
      data.generatedAt ? '生成：' + formatDateTime(data.generatedAt) : '',
      Number.isFinite(data.memoryCount) ? '来源记忆：' + data.memoryCount + ' 条' : '',
      data.cached ? '缓存' : '新生成',
    ].filter(Boolean).join(' · ');
    return '<div class="detail-block profile-summary"><b>' + title + '</b><span>' + esc(meta) + '</span><pre>' + esc(data.summary || '暂无画像') + '</pre></div>';
  }).join('');
}
async function loadProfileSummary(userId, type) {
  const normalizedType = type === 'yesterday' ? 'yesterday' : 'overall';
  const key = profileSummaryKey(userId, normalizedType);
  state.expandedProfileMemberId = userId;
  state.profileSummaries.set(key, { type: normalizedType, loading: true });
  replaceMemberById(userId);
  try {
    const data = await api('/api/groups/' + encodeURIComponent(state.groupId) + '/members/' + encodeURIComponent(userId) + '/profile-summary?type=' + encodeURIComponent(normalizedType));
    state.profileSummaries.set(key, { type: normalizedType, data });
  } catch (error) {
    state.profileSummaries.set(key, { type: normalizedType, error: error.message || '画像生成失败' });
  }
  replaceMemberById(userId);
}
function replaceMemberById(userId) {
  const article = document.querySelector('article[data-member-id="' + cssEscape(userId) + '"]');
  if (!article) return false;
  const member = state.currentMembers.find(item => item.userId === userId);
  if (!member) return false;
  article.outerHTML = rowMember(member);
  return true;
}
async function renderCandidates() {
  const token = nextRenderToken();
  setPageLoading('正在更新候选记忆...');
  const query = new URLSearchParams({ groupId: state.groupId });
  if (state.candidateStatus) query.set('status', state.candidateStatus);
  if (state.candidateType) query.set('type', state.candidateType);
  if (state.subjectUserId) query.set('subjectUserId', state.subjectUserId);
  if (state.candidateQuery.trim()) query.set('q', state.candidateQuery.trim());
  query.set('page', String(state.candidatePage));
  query.set('pageSize', String(state.candidatePageSize));
  query.set('evidence', 'preview');
  const data = await apiForRender('/api/memory-candidates?' + query.toString());
  if (!data || !isLatestRender(token)) return;
  const pageInfo = data.pagination || { page: state.candidatePage, pageSize: state.candidatePageSize, total: (data.candidates || []).length, totalPages: 1 };
  state.currentCandidates = data.candidates || [];
  const currentCandidateIds = new Set(state.currentCandidates.map(candidate => candidate.id));
  state.selectedCandidateIds = new Set([...state.selectedCandidateIds].filter(id => currentCandidateIds.has(id)));
  state.expandedCandidateIds = new Set([...state.expandedCandidateIds].filter(id => currentCandidateIds.has(id)));
  state.candidatePage = pageInfo.page;
  const notice = state.notice ? '<p class="message" data-local-notice="candidate">' + esc(state.notice) + '</p>' : '';
  state.notice = '';
  const empty = state.currentCandidates.length ? '' : '<p class="message" data-local-empty="candidate">' + esc(candidateEmptyText()) + '</p>';
  const pagination = listPagination('candidate', pageInfo, '候选记忆', true);
  const statusCounts = candidateStatusCounts();
  const stats = pageStatStrip([
    { label: '匹配候选', value: pageInfo.total },
    { label: '当前页待处理', value: statusCounts.pending },
    { label: '当前页已入库', value: statusCounts.approved },
    { label: '平均置信度', value: averageConfidence(state.currentCandidates) },
  ]);
  const tabs = candidateTabs(statusCounts);
  const summary = filterSummaryHtml('candidate', [
    { label: '状态', value: state.candidateStatus, defaultValue: 'pending', text: state.candidateStatus ? statusText(state.candidateStatus) : '全部状态' },
    { label: '类型', value: state.candidateType, text: state.candidateType ? typeText(state.candidateType) : '' },
    { label: '归属 QQ', value: state.subjectUserId },
    { label: '搜索', value: state.candidateQuery },
    { label: '每页', value: String(state.candidatePageSize), defaultValue: '20', text: state.candidatePageSize + ' 条' },
  ]);
  content().innerHTML = '<section class="panel">' + ownerMemberOptionsSlotHtml() + '<div class="section-head"><div><h2>候选记忆审核</h2><p>先确认归属和内容，再决定入库、调整或不采纳。</p></div></div>' + stats + '<div class="filter-panel"><input id="candidateSearch" value="' + esc(state.candidateQuery) + '" placeholder="搜索标题、内容、来源、QQ"><select id="candidateStatus"><option value="pending"' + selected(state.candidateStatus, 'pending') + '>待处理</option><option value="approved"' + selected(state.candidateStatus, 'approved') + '>已入长期记忆</option><option value="rejected"' + selected(state.candidateStatus, 'rejected') + '>不采纳记录</option><option value=""' + selected(state.candidateStatus, '') + '>全部状态</option></select><select id="candidateType"><option value="">全部类型</option><option value="member_profile"' + selected(state.candidateType, 'member_profile') + '>个人画像</option><option value="group_fact"' + selected(state.candidateType, 'group_fact') + '>群整体记忆</option></select>' + memberFilterControl('subjectFilter', state.subjectUserId) + '<select id="candidatePageSize"><option value="10"' + selected(String(state.candidatePageSize), '10') + '>每页 10 条</option><option value="20"' + selected(String(state.candidatePageSize), '20') + '>每页 20 条</option><option value="50"' + selected(String(state.candidatePageSize), '50') + '>每页 50 条</option><option value="100"' + selected(String(state.candidatePageSize), '100') + '>每页 100 条</option></select></div>' + summary + notice + tabs + '<div class="hint-row"><b>' + esc(candidateModeTitle()) + '</b><span>' + esc(candidateModeHint()) + '</span></div>' + candidateSelectionBar() + empty + '<div class="review-list">' + state.currentCandidates.map(rowCandidate).join('') + '</div>' + pagination + '</section>';
  document.querySelector('#candidateSearch').addEventListener('input', debounce(event => { state.candidateQuery = event.target.value; state.candidatePage = 1; syncUrlState({ replace: true }); renderCandidates(); }, 250));
  document.querySelector('#candidateStatus').addEventListener('change', event => { state.candidateStatus = event.target.value; state.candidatePage = 1; syncUrlState(); renderCandidates(); });
  document.querySelector('#candidateType').addEventListener('change', event => { state.candidateType = event.target.value; state.candidatePage = 1; syncUrlState(); renderCandidates(); });
  document.querySelector('#subjectFilter')?.addEventListener('input', debounce(event => { state.subjectUserId = event.target.value.trim(); state.candidatePage = 1; syncUrlState({ replace: true }); renderCandidates(); }, 250));
  document.querySelector('#candidatePageSize').addEventListener('change', event => { state.candidatePageSize = Number(event.target.value) || 20; state.candidatePage = 1; syncUrlState(); renderCandidates(); });
}
function candidateStatusCounts() {
  return state.currentCandidates.reduce((counts, candidate) => {
    counts[candidate.status] = (counts[candidate.status] || 0) + 1;
    return counts;
  }, { pending: 0, approved: 0, rejected: 0 });
}
function averageConfidence(items) {
  if (!items.length) return '-';
  const value = items.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / items.length;
  return Math.round(value * 100) + '%';
}
function candidateTabs(counts) {
  const tabs = [
    { status: 'pending', label: '待处理', count: counts.pending },
    { status: 'approved', label: '已入库', count: counts.approved },
    { status: 'rejected', label: '不采纳', count: counts.rejected },
    { status: '', label: '全部历史', count: state.currentCandidates.length },
  ];
  return '<div class="status-tabs">' + tabs.map(tab => '<button type="button" class="ghost ' + (state.candidateStatus === tab.status ? 'active' : '') + '" data-candidate-status-shortcut="' + esc(tab.status) + '">' + esc(tab.label) + '<span>' + esc(tab.count) + '</span></button>').join('') + '</div>';
}
function candidateModeTitle() {
  if (state.candidateStatus === 'approved') return '已入库历史';
  if (state.candidateStatus === 'rejected') return '不采纳历史';
  if (state.candidateStatus === '') return '全部候选历史';
  return '待处理候选';
}
function candidateModeHint() {
  if (state.candidateStatus === 'approved') return '这些已经写入长期记忆，只用于追溯，不需要再处理。';
  if (state.candidateStatus === 'rejected') return '这些是已经不采纳的候选，保留用于排查模型提取质量。';
  if (state.candidateStatus === '') return '这里包含待处理、已入库和不采纳记录；日常审核建议回到待处理工作台。';
  return '确认归属和内容后入库；处理完成后会自动从当前列表移走。';
}
function candidateEmptyText() {
  if (state.candidateStatus === 'approved') return '当前筛选下没有已入库候选。';
  if (state.candidateStatus === 'rejected') return '当前筛选下没有不采纳记录。';
  if (state.candidateStatus === '') return '当前筛选下没有候选记忆。';
  return '当前没有待处理候选。';
}
function candidateSelectionBar() {
  const selectedCount = state.selectedCandidateIds.size;
  const allSelected = state.currentCandidates.length > 0 && state.currentCandidates.every(candidate => state.selectedCandidateIds.has(candidate.id));
  return '<div class="bulk-bar"><label><input type="checkbox" data-select-all-candidates' + (allSelected ? ' checked' : '') + '>选择当前页</label><span class="meta" data-candidate-selected-count>已选 ' + selectedCount + ' 条</span><button type="button" data-bulk-approve-selected' + (selectedCount === 0 ? ' disabled' : '') + '>批量入长期记忆</button><button type="button" class="ghost" data-clear-candidate-selection' + (selectedCount === 0 ? ' disabled' : '') + '>清空选择</button></div>';
}
function updateCandidateSelectionUi() {
  const selectedCount = state.selectedCandidateIds.size;
  const countNode = document.querySelector('[data-candidate-selected-count]');
  if (countNode) countNode.textContent = '已选 ' + selectedCount + ' 条';
  const approveButton = document.querySelector('[data-bulk-approve-selected]');
  if (approveButton) approveButton.disabled = selectedCount === 0;
  const clearButton = document.querySelector('[data-clear-candidate-selection]');
  if (clearButton) clearButton.disabled = selectedCount === 0;
  document.querySelectorAll('[data-select-candidate]').forEach(input => {
    if (input instanceof HTMLInputElement) input.checked = state.selectedCandidateIds.has(input.dataset.selectCandidate);
  });
  const allInput = document.querySelector('[data-select-all-candidates]');
  if (allInput instanceof HTMLInputElement) {
    const selectedOnPage = state.currentCandidates.filter(candidate => state.selectedCandidateIds.has(candidate.id)).length;
    allInput.checked = state.currentCandidates.length > 0 && selectedOnPage === state.currentCandidates.length;
    allInput.indeterminate = selectedOnPage > 0 && selectedOnPage < state.currentCandidates.length;
  }
}
function rowCandidate(c) {
  const needsOwner = c.type === 'member_profile' && !c.subjectUserId;
  const meta = '<div class="meta">归属：' + esc(ownerLabel(c)) + ' · 类型：' + esc(typeText(c.type)) + ' · 状态：' + esc(statusText(c.status)) + ' · 置信度：' + esc(c.confidence) + (needsOwner ? ' · 这条像个人画像，但模型没确定是谁' : '') + '</div>';
  if (state.editingCandidateId !== c.id) {
    const checked = state.selectedCandidateIds.has(c.id) ? ' checked' : '';
    const expanded = state.expandedCandidateIds.has(c.id);
    const details = expanded ? '<div class="detail-block">' + evidenceHtml(c) + '<div class="actions secondary-actions"><button type="button" data-approve-as-fact="' + esc(c.id) + '" class="ghost">按群整体入库</button><button type="button" data-reject="' + esc(c.id) + '" class="ghost">不采纳</button><button type="button" data-delete-candidate="' + esc(c.id) + '" class="ghost">' + (state.pendingDelete === c.id ? '确认删除' : '删除记录') + '</button></div></div>' : '';
    return '<article class="review-row" data-candidate-id="' + esc(c.id) + '"><label class="row-check"><input type="checkbox" data-select-candidate="' + esc(c.id) + '"' + checked + '></label><div class="row-main"><h3>' + esc(c.title) + '</h3><span>' + esc(shortText(c.content, 150)) + '</span></div><div class="row-meta"><span>归属</span><b>' + esc(ownerLabel(c)) + '</b></div><div class="row-meta"><span>类型</span><b class="badge">' + esc(typeText(c.type)) + '</b></div><div class="row-meta"><span>状态</span><b class="badge ' + (c.status === 'pending' ? 'warn' : '') + '">' + esc(statusText(c.status)) + '</b></div><div class="row-meta"><span>置信度</span><b>' + esc(Math.round(Number(c.confidence || 0) * 100)) + '%</b></div><div class="actions row-actions"><button type="button" data-approve="' + esc(c.id) + '">入长期记忆</button><button type="button" data-edit-candidate="' + esc(c.id) + '" class="ghost">调整后处理</button><button type="button" data-toggle-candidate-details="' + esc(c.id) + '" class="ghost">' + (expanded ? '收起详情' : '查看详情') + '</button></div>' + (needsOwner ? '<p class="message">这条像个人画像，但模型没确定是谁。</p>' : '') + details + '</article>';
  }
  return '<article data-candidate-id="' + esc(c.id) + '"><form class="candidateForm" data-candidate-id="' + esc(c.id) + '"><div class="candidate-form"><select name="type"><option value="member_profile"' + selected(c.type, 'member_profile') + '>个人画像</option><option value="group_fact"' + selected(c.type, 'group_fact') + '>群整体记忆</option></select><input name="title" value="' + esc(c.title) + '" placeholder="记忆标题"><textarea name="content" placeholder="要写入长期记忆的内容">' + esc(c.content) + '</textarea>' + ownerInput('subjectUserId', c.subjectUserId || '', ownerLabel(c)) + '</div><div class="candidate-help"><b>怎么处理：</b><span>入长期记忆：内容和归属都对，写进正式记忆。</span><span>按群整体入库：这不是某个人的画像，而是群规则、群事实或固定梗。</span><span>暂存修改：只保存你的编辑，稍后再决定。</span></div>' + meta + evidenceHtml(c) + '<div class="actions"><button type="button" data-approve="' + esc(c.id) + '">保存并入长期记忆</button><button type="button" data-approve-as-fact="' + esc(c.id) + '" class="ghost">保存为群整体记忆</button><button type="button" data-save-candidate="' + esc(c.id) + '" class="ghost">暂存修改</button><button type="button" data-reject="' + esc(c.id) + '" class="ghost">不采纳</button><button type="button" data-cancel-edit>收起</button><button type="button" data-delete-candidate="' + esc(c.id) + '" class="ghost">' + (state.pendingDelete === c.id ? '确认删除' : '删除记录') + '</button></div></form></article>';
}
async function renderMemories() {
  const token = nextRenderToken();
  setPageLoading('正在更新长期记忆...');
  const query = new URLSearchParams({ groupId: state.groupId });
  if (state.subjectUserId) query.set('subjectUserId', state.subjectUserId);
  if (state.memoryType) query.set('type', state.memoryType);
  if (state.memoryEnabled) query.set('enabled', state.memoryEnabled);
  if (state.memoryQuery.trim()) query.set('q', state.memoryQuery.trim());
  query.set('page', String(state.memoryPage));
  query.set('pageSize', String(state.memoryPageSize));
  query.set('evidence', 'preview');
  const data = await apiForRender('/api/memories?' + query.toString());
  if (!data || !isLatestRender(token)) return;
  const memories = data.memories || [];
  state.currentMemories = memories;
  const currentMemoryIds = new Set(state.currentMemories.map(memory => memory.id));
  state.selectedMemoryIds = new Set([...state.selectedMemoryIds].filter(id => currentMemoryIds.has(id)));
  state.expandedMemoryIds = new Set([...state.expandedMemoryIds].filter(id => currentMemoryIds.has(id)));
  const pageInfo = data.pagination || { page: state.memoryPage, pageSize: state.memoryPageSize, total: memories.length, totalPages: 1 };
  state.memoryPage = pageInfo.page;
  const groups = groupMemories(memories);
  const empty = groups.length ? '' : '<div class="empty-state"><div><b>没有符合筛选条件的长期记忆</b><span>可以清空筛选，或新增一条群事实/成员画像。</span></div></div>';
  const enabledCount = state.currentMemories.filter(memory => memory.enabled).length;
  const memoryStats = pageStatStrip([
    { label: '匹配记忆', value: pageInfo.total },
    { label: '当前页启用', value: enabledCount },
    { label: '当前页成员数', value: groups.length },
    { label: '平均置信度', value: averageConfidence(state.currentMemories) },
  ]);
  const summary = filterSummaryHtml('memory', [
    { label: '归属 QQ', value: state.subjectUserId },
    { label: '类型', value: state.memoryType, text: state.memoryType ? typeText(state.memoryType) : '' },
    { label: '状态', value: state.memoryEnabled, text: state.memoryEnabled === 'true' ? '启用' : state.memoryEnabled === 'false' ? '停用' : '' },
    { label: '搜索', value: state.memoryQuery },
    { label: '每页', value: String(state.memoryPageSize), defaultValue: '20', text: state.memoryPageSize + ' 条' },
  ]);
  content().innerHTML = '<section class="panel">' + ownerMemberOptionsSlotHtml() + '<div class="section-head"><div><h2>长期记忆库</h2><p>按成员和群事实维护已批准记忆，支持停用、批量处理和证据追溯。</p></div></div>' + memoryStats + '<div class="filter-panel"><input id="memorySearch" value="' + esc(state.memoryQuery) + '" placeholder="搜索标题、内容、来源、QQ">' + memberFilterControl('memorySubjectFilter', state.subjectUserId) + '<select id="memoryTypeFilter"><option value="">全部类型</option><option value="member_profile"' + selected(state.memoryType, 'member_profile') + '>成员画像</option><option value="group_fact"' + selected(state.memoryType, 'group_fact') + '>群事实</option></select><select id="memoryEnabledFilter"><option value="">全部状态</option><option value="true"' + selected(state.memoryEnabled, 'true') + '>启用</option><option value="false"' + selected(state.memoryEnabled, 'false') + '>停用</option></select><select id="memoryPageSize"><option value="10"' + selected(String(state.memoryPageSize), '10') + '>每页 10 条</option><option value="20"' + selected(String(state.memoryPageSize), '20') + '>每页 20 条</option><option value="50"' + selected(String(state.memoryPageSize), '50') + '>每页 50 条</option><option value="100"' + selected(String(state.memoryPageSize), '100') + '>每页 100 条</option></select></div>' + summary + '<div class="hint-row memory-hint"><b>按成员分组展示长期记忆</b><span>支持筛选、批量操作与快速查看；完整画像可在成员管理中查看。</span></div>' + memoryForm() + memorySelectionBar() + empty + '<div class="memory-group-list">' + groups.map(memoryGroupBlock).join('') + '</div>' + listPagination('memory', pageInfo, '长期记忆', true) + '</section>';
  document.querySelector('#memorySearch').addEventListener('input', debounce(event => { state.memoryQuery = event.target.value; state.memoryPage = 1; syncUrlState({ replace: true }); renderMemories(); }, 250));
  document.querySelector('#memorySubjectFilter')?.addEventListener('input', debounce(event => { state.subjectUserId = event.target.value.trim(); state.memoryPage = 1; syncUrlState({ replace: true }); renderMemories(); }, 250));
  document.querySelector('#memoryTypeFilter').addEventListener('change', event => { state.memoryType = event.target.value; state.memoryPage = 1; syncUrlState(); renderMemories(); });
  document.querySelector('#memoryEnabledFilter').addEventListener('change', event => { state.memoryEnabled = event.target.value; state.memoryPage = 1; syncUrlState(); renderMemories(); });
  document.querySelector('#memoryPageSize').addEventListener('change', event => { state.memoryPageSize = Number(event.target.value) || 20; state.memoryPage = 1; syncUrlState(); renderMemories(); });
}
function memoryForm() {
  return '<details class="inline-editor memory-create"><summary><span>新增长期记忆</span><em>待归属成员或群事实完整后再添加</em></summary><form id="memoryForm" class="grid-form"><select name="type"><option value="group_fact">群事实</option><option value="member_profile">成员画像</option></select>' + ownerInput('subjectUserId') + '<input name="title" placeholder="标题"><input name="content" placeholder="内容"><button>新增</button></form></details>';
}
function memorySelectionBar() {
  const selectedCount = state.selectedMemoryIds.size;
  const allSelected = state.currentMemories.length > 0 && state.currentMemories.every(memory => state.selectedMemoryIds.has(memory.id));
  return '<div class="bulk-bar"><label><input type="checkbox" data-select-all-memories' + (allSelected ? ' checked' : '') + '>选择当前页</label><span class="meta" data-memory-selected-count>已选 ' + selectedCount + ' 条</span><button type="button" data-bulk-disable-memories' + (selectedCount === 0 ? ' disabled' : '') + '>停用已选</button><button type="button" class="ghost" data-bulk-delete-memories' + (selectedCount === 0 ? ' disabled' : '') + '>' + (state.pendingDelete === 'memories:bulk' ? '确认批量删除' : '批量删除') + '</button><button type="button" class="ghost" data-clear-memory-selection' + (selectedCount === 0 ? ' disabled' : '') + '>清空选择</button></div>';
}
function updateMemorySelectionUi() {
  const selectedCount = state.selectedMemoryIds.size;
  const countNode = document.querySelector('[data-memory-selected-count]');
  if (countNode) countNode.textContent = '已选 ' + selectedCount + ' 条';
  const disableButton = document.querySelector('[data-bulk-disable-memories]');
  if (disableButton) disableButton.disabled = selectedCount === 0;
  const deleteButton = document.querySelector('[data-bulk-delete-memories]');
  if (deleteButton) deleteButton.disabled = selectedCount === 0;
  const clearButton = document.querySelector('[data-clear-memory-selection]');
  if (clearButton) clearButton.disabled = selectedCount === 0;
  document.querySelectorAll('[data-select-memory]').forEach(input => {
    if (input instanceof HTMLInputElement) input.checked = state.selectedMemoryIds.has(input.dataset.selectMemory);
  });
  const allInput = document.querySelector('[data-select-all-memories]');
  if (allInput instanceof HTMLInputElement) {
    const selectedOnPage = state.currentMemories.filter(memory => state.selectedMemoryIds.has(memory.id)).length;
    allInput.checked = state.currentMemories.length > 0 && selectedOnPage === state.currentMemories.length;
    allInput.indeterminate = selectedOnPage > 0 && selectedOnPage < state.currentMemories.length;
  }
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
function memoryGroupBlock(group) {
  const enabled = group.items.filter(item => item.enabled).length;
  return '<div class="memory-group"><div class="memory-group-head"><label><input type="checkbox" disabled></label><div><h3>' + esc(group.label) + '</h3><span>记忆 ' + esc(group.items.length) + ' 条，启用 ' + esc(enabled) + ' 条</span></div></div><div class="memory-rows">' + group.items.map(rowMemory).join('') + '</div></div>';
}
function rowMemory(m) {
  const meta = '<div class="meta">当前归属：' + esc(ownerLabel(m)) + ' · 类型：' + esc(typeText(m.type)) + ' · 状态：' + enabledText(m.enabled) + ' · 置信度：' + esc(m.confidence) + '</div>';
  if (state.editingMemoryId !== m.id) {
    const checked = state.selectedMemoryIds.has(m.id) ? ' checked' : '';
    const expanded = state.expandedMemoryIds.has(m.id);
    const details = expanded ? '<div class="detail-block">' + evidenceHtml(m) + '<div class="actions secondary-actions"><button type="button" data-toggle-memory="' + esc(m.id) + '" data-enabled="' + (!m.enabled) + '" class="ghost">' + (m.enabled ? '停用' : '启用') + '</button><button type="button" data-delete-memory="' + esc(m.id) + '" class="ghost">' + (state.pendingDelete === m.id ? '确认删除' : '删除') + '</button></div></div>' : '';
    return '<article class="memory-row" data-memory-id="' + esc(m.id) + '"><label class="row-check"><input type="checkbox" data-select-memory="' + esc(m.id) + '"' + checked + '></label><div class="memory-icon">' + (m.type === 'member_profile' ? '人' : '群') + '</div><div class="row-main"><h3>' + esc(m.title) + '</h3><span>' + esc(shortText(m.content, 150)) + '</span></div><div class="row-meta"><span>类型</span><b>' + esc(typeText(m.type)) + '</b></div><div class="row-meta"><span>置信度</span><b>' + esc(Math.round(Number(m.confidence || 0) * 100)) + '%</b></div><div class="row-meta"><span>状态</span><b class="badge ' + (m.enabled ? '' : 'warn') + '">' + enabledText(m.enabled) + '</b></div><div class="actions row-actions"><button type="button" data-edit-memory="' + esc(m.id) + '">编辑</button><button type="button" data-toggle-memory-details="' + esc(m.id) + '" class="ghost">' + (expanded ? '收起详情' : '查看详情') + '</button></div>' + details + '</article>';
  }
  return '<article><form class="memoryItemForm" data-memory-id="' + esc(m.id) + '"><div class="memory-form"><select name="type"><option value="member_profile"' + selected(m.type, 'member_profile') + '>成员画像</option><option value="group_fact"' + selected(m.type, 'group_fact') + '>群事实</option></select>' + ownerInput('subjectUserId', m.subjectUserId || '', ownerLabel(m)) + '<input name="title" value="' + esc(m.title) + '" placeholder="标题"><input name="confidence" type="number" min="0" max="1" step="0.01" value="' + esc(m.confidence) + '" placeholder="置信度"><select name="enabled"><option value="true"' + selected(String(m.enabled), 'true') + '>启用</option><option value="false"' + selected(String(m.enabled), 'false') + '>停用</option></select><textarea name="content" placeholder="内容">' + esc(m.content) + '</textarea></div>' + meta + evidenceHtml(m) + '<div class="actions"><button type="button" data-save-memory="' + esc(m.id) + '">保存编辑</button><button type="button" data-toggle-memory="' + esc(m.id) + '" data-enabled="' + (!m.enabled) + '" class="ghost">' + (m.enabled ? '停用' : '启用') + '</button><button type="button" data-cancel-edit>收起</button><button type="button" data-delete-memory="' + esc(m.id) + '" class="ghost">' + (state.pendingDelete === m.id ? '确认删除' : '删除') + '</button></div></form></article>';
}
function listPagination(kind, pageInfo, noun, withJump = false) {
  const start = pageInfo.total === 0 ? 0 : ((pageInfo.page - 1) * pageInfo.pageSize) + 1;
  const end = Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total);
  const label = pageInfo.total === 0 ? '暂无' + noun : '第 ' + start + '-' + end + ' 条，共 ' + pageInfo.total + ' 条';
  const jump = withJump ? '<form data-page-jump="' + kind + '" class="pagination-controls"><input name="page" type="number" min="1" max="' + pageInfo.totalPages + '" value="' + pageInfo.page + '" aria-label="页码" style="width:86px"><button class="ghost">跳转</button></form>' : '';
  return '<div class="pagination"><span>' + esc(label) + '</span><div class="pagination-controls"><button class="ghost" data-page-kind="' + kind + '" data-page-step="prev"' + (pageInfo.page <= 1 ? ' disabled' : '') + '>上一页</button><span>第 ' + pageInfo.page + ' / ' + pageInfo.totalPages + ' 页</span><button class="ghost" data-page-kind="' + kind + '" data-page-step="next"' + (pageInfo.page >= pageInfo.totalPages ? ' disabled' : '') + '>下一页</button>' + jump + '</div></div>';
}
function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
async function changePage(kind, delta) {
  const key = kind + 'Page';
  if (!Object.prototype.hasOwnProperty.call(state, key)) return;
  state[key] = Math.max(1, Number(state[key] || 1) + delta);
  syncUrlState();
  await renderPageKind(kind);
}
async function jumpPage(kind, page) {
  const key = kind + 'Page';
  if (!Object.prototype.hasOwnProperty.call(state, key)) return;
  state[key] = Math.max(1, page);
  syncUrlState();
  await renderPageKind(kind);
}
async function renderPageKind(kind) {
  if (kind === 'member') return renderMembers();
  if (kind === 'candidate') return renderCandidates();
  if (kind === 'memory') return renderMemories();
  if (kind === 'knowledge') return renderKnowledge();
}
async function renderKnowledge() {
  const token = nextRenderToken();
  setPageLoading('正在更新知识库...');
  const query = new URLSearchParams({ groupId: state.groupId, page: String(state.knowledgePage), pageSize: String(state.knowledgePageSize) });
  if (state.knowledgeQuery.trim()) query.set('q', state.knowledgeQuery.trim());
  const data = await apiForRender('/api/knowledge?' + query.toString());
  if (!data || !isLatestRender(token)) return;
  const pageInfo = data.pagination || { page: state.knowledgePage, pageSize: state.knowledgePageSize, total: (data.entries || []).length, totalPages: 1 };
  state.currentKnowledge = data.entries || [];
  state.knowledgePage = pageInfo.page;
  const summary = filterSummaryHtml('knowledge', [
    { label: '搜索', value: state.knowledgeQuery },
    { label: '每页', value: String(state.knowledgePageSize), defaultValue: '20', text: state.knowledgePageSize + ' 条' },
  ]);
  const empty = state.currentKnowledge.length ? '' : '<div class="empty-state"><div><b>当前没有可显示的 FAQ</b><span>可以新增常见问题，机器人后续会在相关提问中优先引用这些答案。</span></div></div>';
  const enabledCount = state.currentKnowledge.filter(entry => entry.enabled).length;
  const knowledgeStats = '<div class="stat-strip"><div><b>' + esc(pageInfo.total) + '</b><span>匹配 FAQ</span></div><div><b>' + esc(enabledCount) + '</b><span>当前页启用</span></div><div><b>' + esc(state.currentKnowledge.reduce((sum, entry) => sum + (entry.keywords || []).length, 0)) + '</b><span>当前页关键词</span></div><div><b>' + esc(state.knowledgePageSize) + '</b><span>每页数量</span></div></div>';
  content().innerHTML = '<section class="panel"><div class="section-head"><div><h2>知识库</h2><p>维护群内 FAQ，适合固定流程、常见链接、规则说明和标准答案。</p></div></div>' + knowledgeStats + '<div class="toolbar"><input id="knowledgeSearch" value="' + esc(state.knowledgeQuery) + '" placeholder="搜索标题、问题、答案、关键词"><select id="knowledgePageSize"><option value="10"' + selected(String(state.knowledgePageSize), '10') + '>每页 10 条</option><option value="20"' + selected(String(state.knowledgePageSize), '20') + '>每页 20 条</option><option value="50"' + selected(String(state.knowledgePageSize), '50') + '>每页 50 条</option></select></div>' + summary + knowledgeForm() + empty + '<div class="list">' + state.currentKnowledge.map(rowKnowledge).join('') + '</div>' + listPagination('knowledge', pageInfo, 'FAQ', true) + '</section>';
  document.querySelector('#knowledgeSearch').addEventListener('input', debounce(event => { state.knowledgeQuery = event.target.value; state.knowledgePage = 1; syncUrlState({ replace: true }); renderKnowledge(); }, 250));
  document.querySelector('#knowledgePageSize').addEventListener('change', event => { state.knowledgePageSize = Number(event.target.value) || 20; state.knowledgePage = 1; syncUrlState(); renderKnowledge(); });
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
  const token = nextRenderToken();
  setPageLoading('正在读取健康状态...');
  const data = await apiForRender('/api/health');
  if (!data || !isLatestRender(token)) return;
  content().innerHTML = '<section class="panel"><div class="section-head"><div><h2>健康状态</h2><p>模型异常时会暂停画像/记忆提炼，但普通群聊回复不受影响。</p></div><button type="button" data-refresh-health>立即检测</button></div><div class="health-grid">' + healthCardHtml('NapCat 连接', data.transportHealth) + healthCardHtml('画像/记忆模型', data.profileAiHealth) + healthCardHtml('Node 运行时', { ok: true, detail: data.nodeVersion + ' · PID ' + data.pid, checkedAt: 'uptime ' + data.uptimeSeconds + 's' }) + healthCardHtml('内存占用', memoryHealthStatus(data.memory)) + '</div><details class="health-diagnostics"><summary>查看原始诊断 JSON</summary><pre>' + esc(JSON.stringify(data, null, 2)) + '</pre></details></section>';
}
function healthCardHtml(title, status) {
  const ok = status?.ok === true;
  return '<div class="health-card ' + (ok ? 'ok' : 'bad') + '"><h3><span class="status-dot ' + (ok ? '' : 'bad') + '"></span>' + esc(title) + '：' + esc(ok ? '正常' : '异常') + '</h3><p>' + esc(status?.detail || '暂无详情') + '</p><p>模型：' + esc(status?.model || 'n/a') + '</p><p>地址：' + esc(status?.baseUrl || 'n/a') + '</p><p>检测：' + esc(status?.checkedAt || 'n/a') + ' · ' + esc(status?.latencyMs ?? 0) + 'ms' + (status?.cached ? ' · 缓存' : '') + '</p></div>';
}
function memoryHealthStatus(memory = {}) {
  const usedMb = Math.round(Number(memory.rss || 0) / 1024 / 1024);
  const heapMb = Math.round(Number(memory.heapUsed || 0) / 1024 / 1024);
  return {
    ok: usedMb < 800,
    detail: 'RSS ' + usedMb + 'MB，堆内存 ' + heapMb + 'MB',
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
  };
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
function groupConfigPayload(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  let manualIdentities;
  try {
    manualIdentities = JSON.parse(String(data.manualIdentities || '[]'));
  } catch {
    throw new Error('人工身份 JSON 格式不正确');
  }
  return {
    currentSkillId: String(data.currentSkillId || '').trim(),
    replyModelMode: data.replyModelMode,
    allowedSkillIds: splitLines(data.allowedSkillIds),
    switcherUserIds: splitLines(data.switcherUserIds),
    liveChatUserIds: splitLines(data.liveChatUserIds),
    manualIdentities,
    liveChatDelaySeconds: Number(data.liveChatDelaySeconds),
    dailyReportEnabled: data.dailyReportEnabled === 'on',
    dailyReportTime: data.dailyReportTime,
    dailyReportTopUserCount: Number(data.dailyReportTopUserCount),
    holidayCountdownEnabled: data.holidayCountdownEnabled === 'on',
    holidayCountdownTime: data.holidayCountdownTime,
    botMuted: data.botMuted === 'on',
    scheduledRemindersEnabled: data.scheduledRemindersEnabled === 'on',
    blacklistedUserIds: splitLines(data.blacklistedUserIds),
    opsAlertsEnabled: data.opsAlertsEnabled === 'on',
  };
}
function splitLines(value) {
  return String(value || '').split(/[\n,，、\s]+/).map(item => item.trim()).filter(Boolean);
}
function replaceGroupConfigArticle(target, group) {
  const article = target.closest('article');
  if (!article) return false;
  article.outerHTML = rowGroupConfig(group);
  const index = state.groups.findIndex(item => item.groupId === group.groupId);
  if (index >= 0) state.groups[index] = group;
  else state.groups.push(group);
  return true;
}
function replaceArticle(target, kind, id) {
  const article = target.closest('article');
  if (!article) return false;
  let html = '';
  if (kind === 'member') {
    const member = state.currentMembers.find(item => item.userId === id);
    if (member) html = rowMember(member);
  }
  if (kind === 'candidate') {
    const candidate = state.currentCandidates.find(item => item.id === id);
    if (candidate) html = rowCandidate(candidate);
  }
  if (kind === 'memory') {
    const memory = state.currentMemories.find(item => item.id === id);
    if (memory) html = rowMemory(memory);
  }
  if (kind === 'knowledge') {
    const entry = state.currentKnowledge.find(item => item.id === id);
    if (entry) html = rowKnowledge(entry);
  }
  if (!html) return false;
  article.outerHTML = html;
  return true;
}
function updateCurrentMember(member) {
  if (!member?.userId) return;
  const index = state.currentMembers.findIndex(item => item.userId === member.userId);
  if (index >= 0) state.currentMembers[index] = member;
  else state.currentMembers.unshift(member);
  const ownerMembers = state.ownerMembersByGroup.get(state.groupId);
  if (!ownerMembers) return;
  const ownerIndex = ownerMembers.findIndex(item => item.userId === member.userId);
  if (ownerIndex >= 0) ownerMembers[ownerIndex] = member;
  else ownerMembers.unshift(member);
}
function updateCurrentItem(listName, id, patch) {
  const list = state[listName];
  if (!Array.isArray(list)) return;
  const index = list.findIndex(item => item.id === id);
  if (index >= 0) list[index] = { ...list[index], ...patch };
}
function removeCurrentItem(listName, id) {
  const list = state[listName];
  if (!Array.isArray(list)) return;
  state[listName] = list.filter(item => item.id !== id);
}
function removeArticle(target) {
  target.closest('article')?.remove();
}
function ensureLocalEmptyState(kind) {
  if (kind === 'candidate') updateCandidateSelectionUi();
  const hasArticle = Boolean(content().querySelector('article'));
  if (hasArticle || content().querySelector('[data-local-empty="' + kind + '"]')) return;
  const text = kind === 'candidate' ? '当前页没有候选记忆。' : kind === 'memory' ? '当前页没有长期记忆。' : '当前页没有 FAQ。';
  const pagination = content().querySelector('.pagination');
  const node = document.createElement('p');
  node.className = 'message';
  node.dataset.localEmpty = kind;
  node.textContent = text;
  if (pagination?.parentNode) pagination.parentNode.insertBefore(node, pagination);
  else content().appendChild(node);
}
function showOrRemoveCandidate(target, candidate) {
  state.selectedCandidateIds.delete(candidate.id);
  updateCurrentItem('currentCandidates', candidate.id, candidate);
  if (shouldRemoveProcessedCandidate(candidate)) {
    removeCurrentItem('currentCandidates', candidate.id);
    removeArticle(target);
    ensureLocalEmptyState('candidate');
  } else {
    replaceArticle(target, 'candidate', candidate.id);
  }
  updateCandidateSelectionUi();
}
function updateCandidateFromBulk(candidate) {
  if (!candidate?.id) return;
  state.selectedCandidateIds.delete(candidate.id);
  state.expandedCandidateIds.delete(candidate.id);
  updateCurrentItem('currentCandidates', candidate.id, candidate);
  const article = content().querySelector('[data-candidate-id="' + CSS.escape(candidate.id) + '"]');
  if (shouldRemoveProcessedCandidate(candidate)) {
    removeCurrentItem('currentCandidates', candidate.id);
    article?.remove();
    return;
  }
  if (article) article.outerHTML = rowCandidate(candidate);
}
function shouldRemoveProcessedCandidate(candidate) {
  if (!candidate || candidate.status === 'pending') return false;
  return state.candidateStatus === 'pending' || state.candidateStatus === '';
}
function updateMemoryFromBulk(memory) {
  if (!memory?.id) return;
  state.selectedMemoryIds.delete(memory.id);
  state.expandedMemoryIds.delete(memory.id);
  updateCurrentItem('currentMemories', memory.id, memory);
  const article = content().querySelector('[data-memory-id="' + CSS.escape(memory.id) + '"]');
  if (!itemMatchesCurrentMemoryFilters(memory)) {
    removeCurrentItem('currentMemories', memory.id);
    article?.remove();
    return;
  }
  if (article) article.outerHTML = rowMemory(memory);
}
function removeMemoryFromBulk(id) {
  state.selectedMemoryIds.delete(id);
  state.expandedMemoryIds.delete(id);
  removeCurrentItem('currentMemories', id);
  content().querySelector('[data-memory-id="' + CSS.escape(id) + '"]')?.remove();
}
function showLocalNotice(kind, message) {
  const previous = content().querySelector('[data-local-notice="' + kind + '"]');
  if (!message) {
    previous?.remove();
    return;
  }
  if (previous) {
    previous.textContent = message;
    return;
  }
  const node = document.createElement('p');
  node.className = 'message';
  node.dataset.localNotice = kind;
  node.textContent = message;
  const anchor = content().querySelector('.quick-actions') || content().querySelector('.list') || content().firstElementChild;
  if (anchor?.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
  else content().appendChild(node);
}
function itemMatchesCurrentMemoryFilters(memory) {
  if (!memory || memory.groupId !== state.groupId) return false;
  if (state.subjectUserId && memory.subjectUserId !== state.subjectUserId) return false;
  if (state.memoryType && memory.type !== state.memoryType) return false;
  if (state.memoryEnabled && String(memory.enabled) !== state.memoryEnabled) return false;
  if (state.memoryQuery.trim()) return false;
  return state.memoryPage === 1;
}
function insertMemoryLocally(memory) {
  if (!itemMatchesCurrentMemoryFilters(memory)) return false;
  state.currentMemories = [memory, ...state.currentMemories.filter(item => item.id !== memory.id)].slice(0, state.memoryPageSize);
  state.editingMemoryId = '';
  const groups = groupMemories(state.currentMemories);
  const section = content().querySelector('section.panel');
  const pagination = content().querySelector('.pagination');
  content().querySelector('[data-local-empty="memory"]')?.remove();
  content().querySelectorAll('.group-block').forEach(node => node.remove());
  const html = groups.map(g => '<div class="group-block"><h3>' + esc(g.label) + '</h3><div class="list">' + g.items.map(rowMemory).join('') + '</div></div>').join('');
  if (pagination) pagination.insertAdjacentHTML('beforebegin', html);
  else section?.insertAdjacentHTML('beforeend', html);
  return true;
}
function knowledgeMatchesCurrentFilters(entry) {
  if (!entry || entry.groupId !== state.groupId) return false;
  if (state.knowledgeQuery.trim()) return false;
  return state.knowledgePage === 1;
}
function insertKnowledgeLocally(entry) {
  if (!knowledgeMatchesCurrentFilters(entry)) return false;
  state.currentKnowledge = [entry, ...state.currentKnowledge.filter(item => item.id !== entry.id)].slice(0, state.knowledgePageSize);
  state.editingKnowledgeId = '';
  const list = content().querySelector('.list');
  if (!list) return false;
  list.innerHTML = state.currentKnowledge.map(rowKnowledge).join('');
  content().querySelector('[data-local-empty="knowledge"]')?.remove();
  return true;
}
async function loadFullEvidence(target) {
  const id = target.dataset.loadEvidence;
  const kind = target.dataset.evidenceKind;
  if (!id || (kind !== 'memory' && kind !== 'candidate')) return;
  const item = await api((kind === 'memory' ? '/api/memories/' : '/api/memory-candidates/') + encodeURIComponent(id));
  if (kind === 'memory') updateCurrentItem('currentMemories', id, item);
  else updateCurrentItem('currentCandidates', id, item);
  const box = content().querySelector('[data-evidence-box="' + CSS.escape(id) + '"]');
  if (box) box.outerHTML = fullEvidenceHtml(item);
}
function replaceEditedArticle(target) {
  const article = target.closest('article');
  if (!article) return false;
  const memberId = article.dataset.memberId || article.querySelector('.memberForm')?.dataset.userId;
  if (memberId) return replaceArticle(target, 'member', memberId);
  const candidateId = article.dataset.candidateId || article.querySelector('.candidateForm')?.dataset.candidateId;
  if (candidateId) return replaceArticle(target, 'candidate', candidateId);
  const memoryId = article.dataset.memoryId || article.querySelector('.memoryItemForm')?.dataset.memoryId;
  if (memoryId) return replaceArticle(target, 'memory', memoryId);
  const knowledgeId = article.dataset.knowledgeId || article.querySelector('.knowledgeItemForm')?.dataset.knowledgeId;
  if (knowledgeId) return replaceArticle(target, 'knowledge', knowledgeId);
  return false;
}
document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.dataset.themeOption) { localStorage.setItem(themeStorageKey, target.dataset.themeOption); applyTheme(target.dataset.themeOption); return; }
  if (target.dataset.view) { await navigateTo(target.dataset.view); }
  if (target.dataset.jumpView) { await navigateTo(target.dataset.jumpView); }
  if (target.dataset.refreshGroups !== undefined) { await runAction(target, async () => { invalidateGroupsCache(); await loadGroups({ refresh: true }); await renderGroups(); }, '群配置已刷新'); }
  if (target.dataset.reloadGroupConfig) { await runAction(target, async () => { const group = await api('/api/groups/' + encodeURIComponent(target.dataset.reloadGroupConfig) + '/config'); replaceGroupConfigArticle(target, group); }, '群配置已重新读取'); }
  if (target.dataset.refreshHealth !== undefined) { await runAction(target, async () => { invalidateRenderCache('/api/health'); const data = await api('/api/health?refresh=1'); renderCache.set('/api/health', { time: Date.now(), data: cloneData(data) }); await renderHealth(); }, '画像/记忆模型已重新检测'); }
  if (target.dataset.refreshMembers !== undefined) { await runAction(target, async () => { invalidateMemberCaches(); state.memberPage = 1; syncUrlState(); await renderMembers(true); }, '群成员已同步'); }
  if (target.dataset.viewMember) { state.view = 'memories'; clearTransientState(); state.subjectUserId = target.dataset.viewMember; state.memoryPage = 1; syncUrlState(); await render(); }
  if (target.dataset.deleteIdentity) { const deleteKey = 'identity:' + target.dataset.deleteIdentity; if (state.pendingDelete !== deleteKey) { state.pendingDelete = deleteKey; replaceArticle(target, 'member', target.dataset.deleteIdentity); return; } await runAction(target, async () => { const result = await api('/api/groups/' + encodeURIComponent(state.groupId) + '/members/' + encodeURIComponent(target.dataset.deleteIdentity) + '/identity', { method: 'DELETE' }); invalidateMemberCaches(); updateCurrentMember(result.member); state.editingMemberId = ''; state.pendingDelete = ''; replaceArticle(target, 'member', target.dataset.deleteIdentity); }, '成员备注已删除'); }
  if (target.dataset.editMember) { state.editingMemberId = target.dataset.editMember; replaceArticle(target, 'member', target.dataset.editMember); }
  if (target.dataset.editCandidate) { state.editingCandidateId = target.dataset.editCandidate; state.expandedCandidateIds.add(target.dataset.editCandidate); replaceArticle(target, 'candidate', target.dataset.editCandidate); preloadOwnerMembers(); }
  if (target.dataset.editMemory) { state.editingMemoryId = target.dataset.editMemory; state.expandedMemoryIds.add(target.dataset.editMemory); replaceArticle(target, 'memory', target.dataset.editMemory); preloadOwnerMembers(); }
  if (target.dataset.editKnowledge) { state.editingKnowledgeId = target.dataset.editKnowledge; replaceArticle(target, 'knowledge', target.dataset.editKnowledge); }
  if (target.dataset.cancelEdit !== undefined) { state.editingMemberId = ''; state.editingCandidateId = ''; state.editingMemoryId = ''; state.editingKnowledgeId = ''; replaceEditedArticle(target); }
  if (target.dataset.loadEvidence) { await runAction(target, async () => { await loadFullEvidence(target); }, '来源证据已展开'); }
  if (target.dataset.loadProfileSummary) { await runAction(target, async () => { await loadProfileSummary(target.dataset.loadProfileSummary, target.dataset.profileType || 'overall'); }, '画像已加载'); }
  if (target.dataset.toggleCandidateDetails) { const id = target.dataset.toggleCandidateDetails; state.pendingDelete = ''; if (state.expandedCandidateIds.has(id)) state.expandedCandidateIds.delete(id); else state.expandedCandidateIds.add(id); replaceArticle(target, 'candidate', id); }
  if (target.dataset.toggleMemoryDetails) { const id = target.dataset.toggleMemoryDetails; state.pendingDelete = ''; if (state.expandedMemoryIds.has(id)) state.expandedMemoryIds.delete(id); else state.expandedMemoryIds.add(id); replaceArticle(target, 'memory', id); }
  if (target.dataset.saveCandidate) { await runAction(target, async () => { const candidate = await api('/api/memory-candidates/' + target.dataset.saveCandidate, { method: 'PUT', body: JSON.stringify(candidatePayload(target.dataset.saveCandidate)) }); invalidateCandidateCaches(); updateCurrentItem('currentCandidates', target.dataset.saveCandidate, candidate); state.editingCandidateId = ''; replaceArticle(target, 'candidate', target.dataset.saveCandidate); }, '候选记忆已保存'); }
  if (target.dataset.approve) { await runAction(target, async () => { const result = await api('/api/memory-candidates/' + target.dataset.approve + '/approve', { method: 'POST', body: JSON.stringify(candidatePayload(target.dataset.approve)) }); invalidateCandidateCaches(); showOrRemoveCandidate(target, result.candidate); }, '候选记忆已批准'); }
  if (target.dataset.approveAsFact) { await runAction(target, async () => { const payload = candidatePayload(target.dataset.approveAsFact); const result = await api('/api/memory-candidates/' + target.dataset.approveAsFact + '/approve', { method: 'POST', body: JSON.stringify({ ...payload, type: 'group_fact', subjectUserId: null }) }); invalidateCandidateCaches(); showOrRemoveCandidate(target, result.candidate); }, '已转为群事实并批准'); }
  if (target.dataset.reject) { await runAction(target, async () => { const candidate = await api('/api/memory-candidates/' + target.dataset.reject + '/reject', { method: 'POST', body: '{}' }); invalidateCandidateCaches(); showOrRemoveCandidate(target, candidate); }, '候选记忆已拒绝'); }
  if (target.dataset.bulkApproveSelected !== undefined) {
    await runAction(target, async () => {
      const selectedIds = state.currentCandidates.filter(candidate => state.selectedCandidateIds.has(candidate.id)).map(candidate => candidate.id);
      const result = await api('/api/memory-candidates/bulk-approve', { method: 'POST', body: JSON.stringify({ ids: selectedIds }) });
      invalidateCandidateCaches();
      (result.approved || []).forEach(item => updateCandidateFromBulk(item.candidate));
      state.selectedCandidateIds = new Set((result.skipped || []).map(item => item.id).filter(id => state.currentCandidates.some(candidate => candidate.id === id)));
      showLocalNotice('candidate', result.skippedCount ? '已批准 ' + result.approvedCount + ' 条，跳过 ' + result.skippedCount + ' 条。成员画像必须先选择归属成员。' : '');
      ensureLocalEmptyState('candidate');
      updateCandidateSelectionUi();
    }, '已处理选中的候选记忆');
  }
  if (target.dataset.clearCandidateSelection !== undefined) { state.selectedCandidateIds = new Set(); updateCandidateSelectionUi(); }
  if (target.dataset.deleteCandidate) { if (state.pendingDelete !== target.dataset.deleteCandidate) { state.pendingDelete = target.dataset.deleteCandidate; state.expandedCandidateIds.add(target.dataset.deleteCandidate); replaceArticle(target, 'candidate', target.dataset.deleteCandidate); return; } await runAction(target, async () => { await api('/api/memory-candidates/' + target.dataset.deleteCandidate, { method: 'DELETE' }); invalidateCandidateCaches(); state.selectedCandidateIds.delete(target.dataset.deleteCandidate); state.expandedCandidateIds.delete(target.dataset.deleteCandidate); removeCurrentItem('currentCandidates', target.dataset.deleteCandidate); state.pendingDelete = ''; removeArticle(target); ensureLocalEmptyState('candidate'); }, '候选记忆已删除'); }
  if (target.dataset.saveMemory) { await runAction(target, async () => { const memory = await api('/api/memories/' + target.dataset.saveMemory, { method: 'PUT', body: JSON.stringify(memoryPayload(target.dataset.saveMemory)) }); invalidateMemoryCaches(); updateCurrentItem('currentMemories', target.dataset.saveMemory, memory); state.editingMemoryId = ''; replaceArticle(target, 'memory', target.dataset.saveMemory); }, '长期记忆已保存'); }
  if (target.dataset.toggleMemory) { await runAction(target, async () => { const enabled = target.dataset.enabled === 'true'; await api('/api/memories/' + target.dataset.toggleMemory, { method: 'PUT', body: JSON.stringify({ enabled }) }); invalidateMemoryCaches(); updateCurrentItem('currentMemories', target.dataset.toggleMemory, { enabled }); replaceArticle(target, 'memory', target.dataset.toggleMemory); }, '长期记忆状态已更新'); }
  if (target.dataset.deleteMemory) { if (state.pendingDelete !== target.dataset.deleteMemory) { state.pendingDelete = target.dataset.deleteMemory; state.expandedMemoryIds.add(target.dataset.deleteMemory); replaceArticle(target, 'memory', target.dataset.deleteMemory); return; } await runAction(target, async () => { await api('/api/memories/' + target.dataset.deleteMemory, { method: 'DELETE' }); invalidateMemoryCaches(); state.selectedMemoryIds.delete(target.dataset.deleteMemory); state.expandedMemoryIds.delete(target.dataset.deleteMemory); removeCurrentItem('currentMemories', target.dataset.deleteMemory); state.pendingDelete = ''; removeArticle(target); ensureLocalEmptyState('memory'); updateMemorySelectionUi(); }, '长期记忆已删除'); }
  if (target.dataset.bulkDisableMemories !== undefined) {
    await runAction(target, async () => {
      const selectedIds = state.currentMemories.filter(memory => state.selectedMemoryIds.has(memory.id)).map(memory => memory.id);
      const result = await api('/api/memories/bulk', { method: 'POST', body: JSON.stringify({ action: 'disable', ids: selectedIds }) });
      invalidateMemoryCaches();
      (result.processed || []).forEach(item => updateMemoryFromBulk(item.memory));
      state.selectedMemoryIds = new Set((result.skipped || []).map(item => item.id).filter(id => state.currentMemories.some(memory => memory.id === id)));
      showLocalNotice('memory', result.skippedCount ? '已停用 ' + result.processedCount + ' 条，跳过 ' + result.skippedCount + ' 条。' : '');
      ensureLocalEmptyState('memory');
      updateMemorySelectionUi();
    }, '已停用选中的长期记忆');
  }
  if (target.dataset.bulkDeleteMemories !== undefined) {
    if (state.pendingDelete !== 'memories:bulk') {
      state.pendingDelete = 'memories:bulk';
      const button = document.querySelector('[data-bulk-delete-memories]');
      if (button) button.textContent = '确认批量删除';
      return;
    }
    await runAction(target, async () => {
      const selectedIds = state.currentMemories.filter(memory => state.selectedMemoryIds.has(memory.id)).map(memory => memory.id);
      const result = await api('/api/memories/bulk', { method: 'POST', body: JSON.stringify({ action: 'delete', ids: selectedIds }) });
      invalidateMemoryCaches();
      (result.processed || []).forEach(item => removeMemoryFromBulk(item.id));
      state.selectedMemoryIds = new Set((result.skipped || []).map(item => item.id).filter(id => state.currentMemories.some(memory => memory.id === id)));
      state.pendingDelete = '';
      showLocalNotice('memory', result.skippedCount ? '已删除 ' + result.processedCount + ' 条，跳过 ' + result.skippedCount + ' 条。' : '');
      ensureLocalEmptyState('memory');
      updateMemorySelectionUi();
    }, '已删除选中的长期记忆');
  }
  if (target.dataset.clearMemorySelection !== undefined) { state.selectedMemoryIds = new Set(); state.pendingDelete = ''; updateMemorySelectionUi(); const button = document.querySelector('[data-bulk-delete-memories]'); if (button) button.textContent = '批量删除'; }
  if (target.dataset.clearMemberFilters !== undefined) { state.memberQuery = ''; state.memberPage = 1; state.memberPageSize = 24; syncUrlState(); await renderMembers(); }
  if (target.dataset.clearCandidateFilters !== undefined) { state.subjectUserId = ''; state.candidateType = ''; state.candidateStatus = 'pending'; state.candidateQuery = ''; state.candidatePage = 1; state.candidatePageSize = 20; state.selectedCandidateIds = new Set(); syncUrlState(); await renderCandidates(); }
  if (target.dataset.clearMemoryFilters !== undefined) { state.subjectUserId = ''; state.memoryType = ''; state.memoryEnabled = ''; state.memoryQuery = ''; state.memoryPage = 1; syncUrlState(); await renderMemories(); }
  if (target.dataset.clearKnowledgeFilters !== undefined) { state.knowledgeQuery = ''; state.knowledgePage = 1; state.knowledgePageSize = 20; syncUrlState(); await renderKnowledge(); }
  if (target.dataset.candidateStatusShortcut !== undefined) { state.candidateStatus = target.dataset.candidateStatusShortcut; state.candidatePage = 1; syncUrlState(); await renderCandidates(); }
  if (target.dataset.pageKind && target.dataset.pageStep) { await changePage(target.dataset.pageKind, target.dataset.pageStep === 'next' ? 1 : -1); }
  if (target.dataset.saveKnowledge) { await runAction(target, async () => { const entry = await api('/api/knowledge/' + target.dataset.saveKnowledge, { method: 'PUT', body: JSON.stringify(knowledgePayload(target.dataset.saveKnowledge)) }); invalidateKnowledgeCaches(); updateCurrentItem('currentKnowledge', target.dataset.saveKnowledge, entry); state.editingKnowledgeId = ''; replaceArticle(target, 'knowledge', target.dataset.saveKnowledge); }, 'FAQ 已保存'); }
  if (target.dataset.toggleKnowledge) { await runAction(target, async () => { const enabled = target.dataset.enabled === 'true'; await api('/api/knowledge/' + target.dataset.toggleKnowledge, { method: 'PUT', body: JSON.stringify({ enabled }) }); invalidateKnowledgeCaches(); updateCurrentItem('currentKnowledge', target.dataset.toggleKnowledge, { enabled }); replaceArticle(target, 'knowledge', target.dataset.toggleKnowledge); }, 'FAQ 状态已更新'); }
  if (target.dataset.deleteKnowledge) { if (state.pendingDelete !== target.dataset.deleteKnowledge) { state.pendingDelete = target.dataset.deleteKnowledge; replaceArticle(target, 'knowledge', target.dataset.deleteKnowledge); return; } await runAction(target, async () => { await api('/api/knowledge/' + target.dataset.deleteKnowledge, { method: 'DELETE' }); invalidateKnowledgeCaches(); removeCurrentItem('currentKnowledge', target.dataset.deleteKnowledge); state.pendingDelete = ''; removeArticle(target); ensureLocalEmptyState('knowledge'); }, 'FAQ 已删除'); }
});
document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.getAttribute('list') === 'ownerMemberOptions') {
    scheduleOwnerMemberSearch(target.value);
  }
});
document.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.getAttribute('list') === 'ownerMemberOptions') {
    scheduleOwnerMemberSearch(target.value);
  }
});
document.addEventListener('change', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.selectCandidate) {
    if (target.checked) state.selectedCandidateIds.add(target.dataset.selectCandidate);
    else state.selectedCandidateIds.delete(target.dataset.selectCandidate);
    updateCandidateSelectionUi();
  }
  if (target.dataset.selectAllCandidates !== undefined) {
    state.selectedCandidateIds = target.checked
      ? new Set(state.currentCandidates.map(candidate => candidate.id))
      : new Set();
    updateCandidateSelectionUi();
  }
  if (target.dataset.selectMemory) {
    if (target.checked) state.selectedMemoryIds.add(target.dataset.selectMemory);
    else state.selectedMemoryIds.delete(target.dataset.selectMemory);
    state.pendingDelete = '';
    updateMemorySelectionUi();
  }
  if (target.dataset.selectAllMemories !== undefined) {
    state.selectedMemoryIds = target.checked
      ? new Set(state.currentMemories.map(memory => memory.id))
      : new Set();
    state.pendingDelete = '';
    updateMemorySelectionUi();
  }
});
document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.classList.contains('groupConfigForm')) {
    await runAction(form.querySelector('button'), async () => {
      const group = await api('/api/groups/' + encodeURIComponent(form.dataset.groupId) + '/config', { method: 'PUT', body: JSON.stringify(groupConfigPayload(form)) });
      invalidateGroupsCache();
      invalidateMemberCaches();
      invalidateMemoryCaches();
      replaceGroupConfigArticle(form, group);
    }, '群配置已保存');
    return;
  }
  if (form.classList.contains('memberForm')) {
    await runAction(form.querySelector('button'), async () => {
      const result = await api('/api/groups/' + encodeURIComponent(state.groupId) + '/members/' + encodeURIComponent(form.dataset.userId) + '/identity', { method: 'PUT', body: JSON.stringify({ names: String(data.names || '').split(/[,，、]+/), note: data.note }) });
      invalidateMemberCaches();
      updateCurrentMember(result.member);
      state.editingMemberId = '';
      replaceArticle(form, 'member', form.dataset.userId);
    }, '成员备注已保存');
    return;
  }
  if (form.id === 'memoryForm') {
    await runAction(form.querySelector('button'), async () => {
      const memory = await api('/api/memories', { method: 'POST', body: JSON.stringify({ ...data, groupId: state.groupId, subjectUserId: data.subjectUserId || null }) });
      invalidateMemoryCaches();
      form.reset();
      if (!insertMemoryLocally(memory)) showLocalNotice('memory', '长期记忆已新增。当前筛选下不显示，可清空筛选或回到第一页查看。');
    }, '长期记忆已新增');
  }
  if (form.id === 'knowledgeForm') {
    await runAction(form.querySelector('button'), async () => {
      const entry = await api('/api/knowledge', { method: 'POST', body: JSON.stringify({ ...data, groupId: state.groupId, keywords: String(data.keywords || '').split(/[,，、]+/) }) });
      invalidateKnowledgeCaches();
      form.reset();
      if (!insertKnowledgeLocally(entry)) showLocalNotice('knowledge', 'FAQ 已新增。当前搜索下不显示，可清空搜索或回到第一页查看。');
    }, 'FAQ 已新增');
  }
  if (form.dataset.pageJump) {
    await jumpPage(form.dataset.pageJump, Number(data.page) || 1);
  }
});
document.querySelector('#groupFilter').addEventListener('change', async (event) => { state.groupId = event.target.value; resetGroupScopedState(); syncUrlState(); await render(); });
document.querySelector('#refreshCurrent')?.addEventListener('click', async (event) => {
  await runAction(event.currentTarget, async () => { await refreshCurrentView(); }, '当前页面已刷新');
});
document.querySelector('#globalSearch')?.addEventListener('input', debounce(async (event) => {
  await applyGlobalSearch(event.target.value);
}, 260));
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('#globalSearch')?.focus();
  }
});
document.querySelector('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem(themeStorageKey) || 'system') === 'system') applyTheme('system');
});
window.addEventListener('popstate', async () => {
  isApplyingHistoryState = true;
  readStateFromUrl();
  clearTransientState();
  isApplyingHistoryState = false;
  await render();
});
applyTheme();
readStateFromUrl();
loadGroups().then(() => {
  syncUrlState({ replace: true });
  return render();
});
`.trimStart();

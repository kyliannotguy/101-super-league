const STORAGE_KEY = "oneZeroOneLeagueState.v2";
const AUTH_KEY = "oneZeroOneLeagueAdmin.v2";
const TAB_KEY = "oneZeroOneLeagueTab.v2";
const DEFAULT_ADMIN_PASSWORD_HASH = "22b06d157c7eeb10c0d52ca2f297cf8ade84d9675bbc8199a1b284aa8113f772";
const SUPABASE_URL = "https://wfezklbuehsldvxlylzv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_w9baPO5oBw8_EVISvXSr9w_pdMTY1bl";
const REMOTE_STATE_ENDPOINT = `${SUPABASE_URL}/rest/v1/league_state`;

const DEFAULT_SEASON_ID = "season-26-27-1";

const TEAM_PRESETS = [
  { id: "team-101fc", name: "101fc", color: "#d63f3f" },
  { id: "team-101jj", name: "101竞技", color: "#246bfe" },
  { id: "team-gediao", name: "格调", color: "#14a06f" },
  { id: "team-poi", name: "poi", color: "#8b5cf6" },
  { id: "team-chasing", name: "chasing", color: "#f08a24" },
];

const ROSTER_IMPORT_COLUMNS = {
  name: ["姓名", "球员", "球员姓名", "名字", "name", "player", "playername"],
  team: ["球队", "所属球队", "归属球队", "队伍", "team", "club"],
  position: ["位置", "场上位置", "position", "pos"],
  goalkeeper: ["门将", "守门员", "gk", "goalkeeper", "keeper"],
  tier: ["档位", "身份", "球员档位", "级别", "tier", "level", "class"],
  captain: ["队长", "是否队长", "captain"],
};

const state = loadState();
const remote = {
  status: "connecting",
  message: "正在连接线上数据库",
  lastSavedAt: "",
  saveTimer: null,
};
const ui = {
  tab: localStorage.getItem(TAB_KEY) || "overview",
  editingPlayerId: null,
  loginOpen: false,
  toast: "",
};

const app = document.getElementById("app");

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("change", handleChange);

render();
hydrateRemoteState();

function defaultState() {
  const teams = TEAM_PRESETS.map((team, index) => ({
    ...team,
    order: index,
    active: true,
    initialFundsBySeason: { [DEFAULT_SEASON_ID]: 900 },
  }));

  return {
    version: 1,
    adminName: "rxnb",
    adminPasswordHash: DEFAULT_ADMIN_PASSWORD_HASH,
    activeSeasonId: DEFAULT_SEASON_ID,
    seasons: [
      {
        id: DEFAULT_SEASON_ID,
        name: "26-27学年第一学期赛季",
        archived: false,
        createdAt: nowIso(),
      },
    ],
    teams,
    players: [],
    matches: [],
    transfers: [],
    financeAdjustments: [],
    actionLog: [
      {
        id: makeId("log"),
        at: nowIso(),
        type: "系统初始化",
        title: "创建五支初始球队",
        detail: "101fc、101竞技、格调、poi、chasing",
      },
    ],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : defaultState();
    return normalizeState(parsed);
  } catch {
    return defaultState();
  }
}

function normalizeState(data) {
  const base = defaultState();
  const next = { ...base, ...data };
  next.seasons = Array.isArray(data.seasons) && data.seasons.length ? data.seasons : base.seasons;
  next.activeSeasonId = data.activeSeasonId || next.seasons[0].id;
  next.teams = Array.isArray(data.teams) && data.teams.length ? data.teams : base.teams;
  next.players = Array.isArray(data.players) ? data.players : [];
  next.matches = Array.isArray(data.matches) ? data.matches : [];
  next.transfers = Array.isArray(data.transfers) ? data.transfers : [];
  next.financeAdjustments = Array.isArray(data.financeAdjustments) ? data.financeAdjustments : [];
  next.actionLog = Array.isArray(data.actionLog) ? data.actionLog : [];
  next.adminName = data.adminName || "rxnb";
  next.adminPasswordHash = data.adminPasswordHash || base.adminPasswordHash;

  next.players.forEach((player) => {
    player.active = player.active !== false;
    if (player.loan && player.loan.active === false) player.loan = null;
  });

  next.transfers.forEach((transfer) => {
    if (transfer.type === "loan" && !transfer.loanStatus) {
      transfer.loanStatus = transfer.returnedByMatchId ? "returned" : "active";
    }
  });

  next.teams.forEach((team, index) => {
    team.active = team.active !== false;
    team.order = Number.isFinite(Number(team.order)) ? Number(team.order) : index;
    team.initialFundsBySeason = team.initialFundsBySeason || {};
    for (const season of next.seasons) {
      if (team.initialFundsBySeason[season.id] === undefined) {
        team.initialFundsBySeason[season.id] = Number(team.initialFunds || 900);
      }
    }
  });

  return next;
}

function saveState(options = {}) {
  const { syncRemote = true } = options;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (syncRemote) queueRemoteSave();
}

async function hydrateRemoteState() {
  try {
    const response = await fetch(`${REMOTE_STATE_ENDPOINT}?id=eq.main&select=data`, {
      headers: supabaseHeaders(),
    });
    if (!response.ok) throw new Error(`读取失败：${response.status}`);

    const rows = await response.json();
    const remoteData = rows?.[0]?.data;
    if (remoteData && Object.keys(remoteData).length) {
      replaceState(remoteData);
      saveState({ syncRemote: false });
      remote.status = "connected";
      remote.message = "线上数据已载入";
    } else {
      remote.status = "saving";
      remote.message = "正在初始化线上数据";
      await saveRemoteStateNow(false);
    }
  } catch (error) {
    remote.status = "error";
    remote.message = "线上数据库未连接，正在使用本地缓存";
    console.warn(error);
  }
  render();
}

function replaceState(nextState) {
  const normalized = normalizeState(nextState);
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, normalized);
}

function queueRemoteSave() {
  window.clearTimeout(remote.saveTimer);
  remote.status = "saving";
  remote.message = "正在保存到线上";
  remote.saveTimer = window.setTimeout(() => {
    saveRemoteStateNow(true);
  }, 350);
}

async function saveRemoteStateNow(shouldRender = true) {
  try {
    const response = await fetch(REMOTE_STATE_ENDPOINT, {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        id: "main",
        data: state,
        updated_at: nowIso(),
      }),
    });
    if (!response.ok) throw new Error(`保存失败：${response.status}`);
    remote.status = "connected";
    remote.lastSavedAt = nowIso();
    remote.message = "线上数据已同步";
  } catch (error) {
    remote.status = "error";
    remote.message = "线上保存失败，已保留本地缓存";
    console.warn(error);
  }
  if (shouldRender) render();
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
  };
}

function render() {
  const admin = isAdmin();
  const season = getActiveSeason();
  const stats = collectStats();

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand-block">
            <h1>一零一超级联赛</h1>
            <div class="season-line">${esc(season.name)} · 开发者：任翔</div>
          </div>
          <div class="top-actions">
            <span class="mode-pill ${admin ? "admin" : ""}">${admin ? "管理员模式" : "公开展示模式"}</span>
            ${renderSyncPill()}
            ${admin ? renderAdminTopActions() : renderLoginForm()}
          </div>
        </div>
      </header>
      <main class="container">
        ${renderTabs()}
        ${renderCurrentTab(stats)}
      </main>
      <footer class="footer">
        <span>开发者：任翔</span>
        <span>一零一超级联赛管理与展示系统</span>
      </footer>
      ${ui.toast ? `<div class="toast">${esc(ui.toast)}</div>` : ""}
    </div>
  `;
}

function renderAdminTopActions() {
  return `
    <button class="btn ghost small" data-action="export-data">导出数据</button>
    <button class="btn small" data-action="logout">退出管理</button>
  `;
}

function renderSyncPill() {
  const statusClass = remote.status === "connected" ? "admin" : remote.status === "error" ? "warn" : "";
  return `<span class="mode-pill ${statusClass}" title="${escAttr(remote.message)}">${esc(syncStatusLabel())}</span>`;
}

function syncStatusLabel() {
  if (remote.status === "connected") return "线上已同步";
  if (remote.status === "saving") return "线上保存中";
  if (remote.status === "error") return "线上未连接";
  return "线上连接中";
}

function renderLoginForm() {
  if (!ui.loginOpen) {
    return `<button class="btn small" type="button" data-action="toggle-login">管理员登录</button>`;
  }

  return `
    <form id="loginForm" class="login-form">
      <input name="username" autocomplete="username" placeholder="管理员账号" aria-label="管理员账号" />
      <input name="password" type="password" autocomplete="current-password" placeholder="管理员密码" aria-label="管理员密码" />
      <button class="btn primary" type="submit">进入管理</button>
      <button class="btn ghost" type="button" data-action="toggle-login">收起</button>
    </form>
  `;
}

function renderTabs() {
  const tabs = [
    ["overview", "总览"],
    ["standings", "积分榜"],
    ["finance", "财政"],
    ["teams", "球队球员"],
    ["matches", "比赛"],
    ["transfers", "转会租借"],
    ["scorers", "射手榜"],
    ["season", "赛季管理"],
  ];

  return `
    <nav class="tabs" aria-label="页面导航">
      ${tabs
        .map(
          ([id, label]) => `
            <button class="tab-button ${ui.tab === id ? "active" : ""}" data-tab="${id}">
              ${label}
            </button>
          `,
        )
        .join("")}
    </nav>
  `;
}

function renderCurrentTab(stats) {
  if (ui.tab === "standings") return renderStandingsView(stats);
  if (ui.tab === "finance") return renderFinanceView(stats);
  if (ui.tab === "teams") return renderTeamsView(stats);
  if (ui.tab === "matches") return renderMatchesView(stats);
  if (ui.tab === "transfers") return renderTransfersView(stats);
  if (ui.tab === "scorers") return renderScorersView(stats);
  if (ui.tab === "season") return renderSeasonView(stats);
  return renderOverview(stats);
}

function renderOverview(stats) {
  const leader = stats.standings.find((row) => row.played > 0);
  const richest = [...stats.financeSummary].sort((a, b) => b.balance - a.balance)[0];
  const scorer = stats.scorers[0];

  return `
    <section class="grid cols-4">
      ${renderStatCard("当前赛季", getActiveSeason().name)}
      ${renderStatCard("联赛第一", leader ? leader.team.name : "暂无")}
      ${renderStatCard("财政最高", richest ? `${richest.team.name} ${richest.balance}丸` : "暂无")}
      ${renderStatCard("射手榜第一", scorer ? `${scorer.name} ${scorer.goals}球` : "暂无")}
    </section>
    <section class="grid cols-2" style="margin-top:14px">
      <div class="panel">
        <div class="section-title">
          <h2>积分榜</h2>
          <span class="hint">联赛比赛自动统计</span>
        </div>
        ${renderStandingsTable(stats.standings, 5)}
      </div>
      <div class="panel">
        <div class="section-title">
          <h2>财政透明榜</h2>
          <span class="hint">余额来自流水计算</span>
        </div>
        ${renderFinanceTable(stats.financeSummary, 5)}
      </div>
      <div class="panel">
        <div class="section-title">
          <h2>最近比赛</h2>
          <span class="hint">已赛与待定都会显示</span>
        </div>
        ${renderMatchList(stats.recentMatches, false, 5)}
      </div>
      <div class="panel">
        <div class="section-title">
          <h2>近期转会</h2>
          <span class="hint">包含租借与解约金</span>
        </div>
        ${renderTransferList(stats.recentTransfers, false, 5)}
      </div>
    </section>
  `;
}

function renderStatCard(label, value) {
  return `
    <div class="panel stat-card">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
    </div>
  `;
}

function renderStandingsView(stats) {
  return `
    <section class="panel">
      <div class="section-title">
        <h2>联赛积分榜</h2>
        <span class="hint">排名规则：积分、净胜球、进球数</span>
      </div>
      ${renderStandingsTable(stats.standings)}
    </section>
  `;
}

function renderStandingsTable(rows, limit) {
  const list = limit ? rows.slice(0, limit) : rows;
  if (!list.length) return `<div class="empty">还没有可统计的联赛比赛。</div>`;

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>排名</th>
            <th>球队</th>
            <th>场次</th>
            <th>胜</th>
            <th>平</th>
            <th>负</th>
            <th>进球</th>
            <th>失球</th>
            <th>净胜球</th>
            <th>积分</th>
          </tr>
        </thead>
        <tbody>
          ${list
            .map(
              (row, index) => `
                <tr>
                  <td><span class="rank">${index + 1}</span></td>
                  <td>${teamChip(row.team)}</td>
                  <td>${row.played}</td>
                  <td>${row.won}</td>
                  <td>${row.drawn}</td>
                  <td>${row.lost}</td>
                  <td>${row.gf}</td>
                  <td>${row.ga}</td>
                  <td>${row.gd}</td>
                  <td><strong>${row.points}</strong></td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderFinanceView(stats) {
  return `
    ${isAdmin() ? renderFinanceAdmin() : ""}
    <section class="panel">
      <div class="section-title">
        <h2>财政透明榜</h2>
        <span class="hint">初始丸数 + 收入 - 支出 = 当前余额</span>
      </div>
      ${renderFinanceTable(stats.financeSummary)}
    </section>
    <section class="grid cols-2" style="margin-top:14px">
      ${stats.financeSummary.map((row) => renderTeamLedger(row, stats.ledgerByTeam[row.team.id] || [])).join("")}
    </section>
  `;
}

function renderFinanceAdmin() {
  return `
    <section class="panel admin-panel">
      <div class="section-title">
        <h2>手动财政调整</h2>
        <span class="hint">用于奖金、罚款、补助、特殊扣款</span>
      </div>
      <form id="financeForm" class="form-grid">
        <div class="field">
          <label>球队</label>
          <select name="teamId" required>${teamOptions()}</select>
        </div>
        <div class="field">
          <label>日期</label>
          <input name="date" type="date" value="${today()}" />
        </div>
        <div class="field">
          <label>类型</label>
          <select name="category">
            <option value="bonus">奖金/收入</option>
            <option value="fine">罚款/支出</option>
            <option value="subsidy">补助</option>
            <option value="manual">特殊调整</option>
          </select>
        </div>
        <div class="field">
          <label>金额（收入为正，支出为负）</label>
          <input name="amount" type="number" step="1" required placeholder="例如 100 或 -25" />
        </div>
        <div class="field full">
          <label>原因备注</label>
          <textarea name="note" placeholder="例如：杯赛冠军奖金、未按时提交记录罚款"></textarea>
        </div>
        <div class="field">
          <button class="btn primary" type="submit">添加财政流水</button>
        </div>
      </form>
    </section>
  `;
}

function renderFinanceTable(rows, limit) {
  const list = limit ? rows.slice(0, limit) : rows;
  if (!list.length) return `<div class="empty">暂无财政数据。</div>`;

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>球队</th>
            <th>初始丸数</th>
            <th>收入</th>
            <th>支出</th>
            <th>当前余额</th>
          </tr>
        </thead>
        <tbody>
          ${list
            .map(
              (row) => `
                <tr>
                  <td>${teamChip(row.team)}</td>
                  <td>${row.initial}丸</td>
                  <td class="money-pos">+${row.income}丸</td>
                  <td class="money-neg">-${row.expense}丸</td>
                  <td class="${row.balance >= 0 ? "money-pos" : "money-neg"}">${row.balance}丸</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTeamLedger(summary, entries) {
  const items = entries
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 12);

  return `
    <div class="panel">
      <div class="section-title">
        <h3>${teamChip(summary.team)} 财政流水</h3>
        <span class="hint">余额 ${summary.balance}丸</span>
      </div>
      ${
        items.length
          ? `<div class="list-stack">
              ${items
                .map(
                  (entry) => `
                    <div class="item-row ${entry.voided ? "voided" : ""}">
                      <div>
                        <div class="item-title">
                          <span class="${entry.amount >= 0 ? "money-pos" : "money-neg"}">
                            ${entry.amount >= 0 ? "+" : ""}${entry.amount}丸
                          </span>
                          ${esc(entry.type)}
                          ${entry.voided ? `<span class="tag voided">已撤回</span>` : ""}
                        </div>
                        <div class="item-meta">${esc(entry.date || "未填日期")} · ${esc(entry.note || "")}</div>
                      </div>
                      ${
                        isAdmin() && entry.sourceType === "finance"
                          ? `<button class="btn small danger" data-action="void-finance" data-id="${entry.sourceId}">撤回</button>`
                          : ""
                      }
                    </div>
                  `,
                )
                .join("")}
            </div>`
          : `<div class="empty">暂无流水。</div>`
      }
    </div>
  `;
}

function renderTeamsView(stats) {
  return `
    ${isAdmin() ? renderTeamSettingsAdmin() : ""}
    ${isAdmin() ? renderRosterImportAdmin() : ""}
    ${isAdmin() ? renderPlayerAdmin() : ""}
    <section class="roster-grid">
      ${state.teams.filter((team) => team.active).map((team) => renderTeamCard(team, stats.playersByTeam[team.id] || [])).join("")}
    </section>
    ${renderFreeAgents(stats.freePlayers)}
  `;
}

function renderTeamSettingsAdmin() {
  return `
    <section class="panel admin-panel">
      <div class="section-title">
        <h2>球队基础设置</h2>
        <span class="hint">可改队名、颜色、当前赛季初始丸数</span>
      </div>
      <form id="teamSettingsForm">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>球队</th>
                <th>队名</th>
                <th>颜色</th>
                <th>初始丸数</th>
              </tr>
            </thead>
            <tbody>
              ${state.teams
                .filter((team) => team.active)
                .map(
                  (team) => `
                    <tr>
                      <td>${teamChip(team)}</td>
                      <td><input name="name_${team.id}" value="${escAttr(team.name)}" /></td>
                      <td><input name="color_${team.id}" type="color" value="${escAttr(team.color)}" /></td>
                      <td><input name="funds_${team.id}" type="number" step="1" value="${getTeamInitial(team.id)}" /></td>
                    </tr>
                  `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
        <div style="margin-top:12px">
          <button class="btn primary" type="submit">保存球队设置</button>
        </div>
      </form>
    </section>
  `;
}

function renderPlayerAdmin() {
  const editing = ui.editingPlayerId ? getPlayer(ui.editingPlayerId) : null;
  return `
    <section class="panel admin-panel">
      <div class="section-title">
        <h2>${editing ? "编辑球员" : "添加球员"}</h2>
        <span class="hint">门将和档位会在展示端用标签标出</span>
      </div>
      <form id="playerForm" class="form-grid">
        <input type="hidden" name="playerId" value="${editing ? escAttr(editing.id) : ""}" />
        <div class="field">
          <label>球员姓名</label>
          <input name="name" required value="${editing ? escAttr(editing.name) : ""}" />
        </div>
        <div class="field">
          <label>所属球队</label>
          <select name="teamId">${teamOptions(editing?.teamId || "", true, "自由球员/未分配")}</select>
        </div>
        <div class="field">
          <label>场上位置</label>
          <select name="position">
            ${option("unknown", "未定", editing?.position)}
            ${option("GK", "门将 GK", editing?.position)}
            ${option("field", "非门将", editing?.position)}
          </select>
        </div>
        <div class="field">
          <label>球员档位</label>
          <select name="tier">
            ${option("top", "顶星档", editing?.tier)}
            ${option("base", "基础档", editing?.tier)}
            ${option("ordinary", "普通档", editing?.tier || "ordinary")}
            ${option("free", "自由球员", editing?.tier)}
            ${option("loan", "租借球员", editing?.tier)}
          </select>
        </div>
        <label class="checkbox-line">
          <input name="captain" type="checkbox" ${editing?.captain ? "checked" : ""} />
          队长
        </label>
        <div class="field">
          <button class="btn primary" type="submit">${editing ? "保存球员" : "添加球员"}</button>
        </div>
        ${
          editing
            ? `<div class="field"><button class="btn" type="button" data-action="cancel-edit-player">取消编辑</button></div>`
            : ""
        }
      </form>
      <div style="margin-top:14px">
        ${renderPlayersTable()}
      </div>
    </section>
  `;
}

function renderRosterImportAdmin() {
  return `
    <section class="panel admin-panel import-panel">
      <div class="section-title">
        <h2>导入球员名单</h2>
        <span class="hint">支持 Excel / CSV，重复姓名会自动更新</span>
      </div>
      <div class="import-layout">
        <label class="field">
          <span>选择名单文件</span>
          <input id="rosterImportInput" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" />
        </label>
        <div class="notice">
          表头可用：姓名、球队、位置、档位、队长。球队请填 101fc、101竞技、格调、poi、chasing；如果工作表名称就是队名，也可以不填球队列。
        </div>
      </div>
      <div class="import-example">
        <strong>示例：</strong>
        <span>姓名 | 球队 | 位置 | 档位 | 队长</span>
        <span>张三 | 101fc | GK | 顶星档 | 否</span>
      </div>
    </section>
  `;
}

function renderPlayersTable() {
  const players = activePlayers().slice().sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (!players.length) return `<div class="empty">暂无球员。管理员可以从上方手动添加。</div>`;

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>球员</th>
            <th>球队</th>
            <th>身份</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${players
            .map(
              (player) => `
                <tr>
                  <td><strong>${esc(player.name)}</strong></td>
                  <td>${player.teamId ? teamChip(getTeam(player.teamId)) : `<span class="tag free">自由球员</span>`}</td>
                  <td>${playerTags(player)}</td>
                  <td>
                    <button class="btn small" data-action="edit-player" data-id="${player.id}">编辑</button>
                    <button class="btn small danger" data-action="archive-player" data-id="${player.id}">移出名单</button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTeamCard(team, players) {
  const keepers = players.filter((player) => player.position === "GK").length;
  return `
    <article class="panel team-card" style="--team-color:${escAttr(team.color)}">
      <div class="section-title">
        <h3>${esc(team.name)}</h3>
        <span class="hint">${players.length}人 · GK ${keepers}</span>
      </div>
      <div class="player-list">
        ${
          players.length
            ? players
                .map(
                  (player) => `
                    <div class="player-card">
                      <div class="player-name">
                        <span>${esc(player.name)}</span>
                        ${player.position === "GK" ? `<span class="tag gk">GK</span>` : ""}
                      </div>
                      <div class="player-tags">${playerTags(player)}</div>
                      ${getActiveLoan(player) ? `<div class="item-meta">租借自：${teamChip(getTeam(getActiveLoan(player).fromTeamId))}</div>` : ""}
                    </div>
                  `,
                )
                .join("")
            : `<div class="empty">暂无球员</div>`
        }
      </div>
    </article>
  `;
}

function renderFreeAgents(players) {
  if (!players.length) return "";
  return `
    <section class="panel" style="margin-top:14px">
      <div class="section-title">
        <h2>自由球员/未分配球员</h2>
        <span class="hint">${players.length}人</span>
      </div>
      <div class="player-list">
        ${players
          .map(
            (player) => `
              <div class="player-card">
                <div class="player-name"><span>${esc(player.name)}</span></div>
                <div class="player-tags">${playerTags(player)}<span class="tag free">自由球员</span></div>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderMatchesView(stats) {
  return `
    ${isAdmin() ? renderMatchAdmin() : ""}
    <section class="panel">
      <div class="section-title">
        <h2>比赛记录与赛程</h2>
        <span class="hint">未来赛程可以先录为“预计/未赛”</span>
      </div>
      ${renderMatchList(stats.matches, true)}
    </section>
  `;
}

function renderMatchAdmin() {
  return `
    <section class="panel admin-panel">
      <div class="section-title">
        <h2>录入比赛</h2>
        <span class="hint">进球记录格式：球队名|球员名|数量，每行一条</span>
      </div>
      <form id="matchForm" class="form-grid">
        <div class="field">
          <label>比赛类型</label>
          <select name="competition">
            <option value="league">联赛</option>
            <option value="cup">杯赛</option>
            <option value="qualifier">杯赛资格赛</option>
            <option value="final">决赛/三四名</option>
            <option value="friendly">特殊/友谊赛</option>
          </select>
        </div>
        <div class="field">
          <label>日期</label>
          <input name="date" type="date" value="${today()}" />
        </div>
        <div class="field">
          <label>状态</label>
          <select name="status">
            <option value="scheduled">预计/未赛</option>
            <option value="completed">已完赛</option>
            <option value="home_forfeit">主队弃权</option>
            <option value="away_forfeit">客队弃权</option>
          </select>
        </div>
        <div class="field">
          <label>主队</label>
          <select name="homeTeamId" required>${teamOptions()}</select>
        </div>
        <div class="field">
          <label>客队</label>
          <select name="awayTeamId" required>${teamOptions()}</select>
        </div>
        <div class="field">
          <label>主队比分</label>
          <input name="homeScore" type="number" min="0" step="1" placeholder="未赛可留空" />
        </div>
        <div class="field">
          <label>客队比分</label>
          <input name="awayScore" type="number" min="0" step="1" placeholder="未赛可留空" />
        </div>
        <div class="field">
          <label>点球结果（可选）</label>
          <input name="penalties" placeholder="例如 5-4" />
        </div>
        <div class="field">
          <label>主队首发人数</label>
          <input name="homeStarters" type="number" min="0" max="12" step="1" value="7" />
        </div>
        <div class="field">
          <label>主队替补上场</label>
          <input name="homeSubs" type="number" min="0" max="12" step="1" value="0" />
        </div>
        <div class="field">
          <label>客队首发人数</label>
          <input name="awayStarters" type="number" min="0" max="12" step="1" value="7" />
        </div>
        <div class="field">
          <label>客队替补上场</label>
          <input name="awaySubs" type="number" min="0" max="12" step="1" value="0" />
        </div>
        <div class="field full">
          <label>进球记录</label>
          <textarea name="goalsText" placeholder="101fc|张三|2&#10;格调|李四|1"></textarea>
        </div>
        <div class="field full">
          <label>备注</label>
          <textarea name="note" placeholder="裁判、特殊情况、申诉状态等"></textarea>
        </div>
        <div class="field">
          <button class="btn primary" type="submit">保存比赛</button>
        </div>
      </form>
    </section>
  `;
}

function renderMatchList(matches, showAll, limit) {
  const list = (limit ? matches.slice(0, limit) : matches).filter((match) => {
    if (!isAdmin()) return !match.voided;
    return showAll || !match.voided;
  });
  if (!list.length) return `<div class="empty">暂无比赛信息。</div>`;

  return `
    <div class="list-stack">
      ${list
        .map((match) => {
          const home = getTeam(match.homeTeamId);
          const away = getTeam(match.awayTeamId);
          return `
            <div class="item-row ${match.voided ? "voided" : ""}">
              <div>
                <div class="item-title">
                  ${teamChip(home)} vs ${teamChip(away)}
                  ${match.voided ? `<span class="tag voided">已撤回</span>` : ""}
                </div>
                <div class="item-meta">
                  ${esc(match.date || "未填日期")} · ${competitionLabel(match.competition)} · ${statusLabel(match.status)}
                </div>
                <div style="margin-top:6px">
                  <strong>${scoreText(match)}</strong>
                  ${match.penalties ? ` · 点球 ${esc(match.penalties)}` : ""}
                </div>
                ${match.goals?.length ? `<div class="item-meta">进球：${formatGoals(match.goals)}</div>` : ""}
                ${match.note ? `<div class="item-meta">备注：${esc(match.note)}</div>` : ""}
              </div>
              ${
                isAdmin() && !match.voided
                  ? `<button class="btn small danger" data-action="void-match" data-id="${match.id}">撤回</button>`
                  : ""
              }
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderTransfersView(stats) {
  return `
    <section class="panel">
      <div class="section-title">
        <h2>近期转会、解约金与租借</h2>
        <span class="hint">租借固定扣 8 丸，出租队收入 4 丸，借入队踢完一场后自动归还</span>
      </div>
      ${renderTransferList(stats.transfers, true)}
    </section>
    <section class="grid cols-2 transfer-tool-grid">
      ${renderTransferRuleGuide()}
      ${isAdmin() ? renderTransferAdmin() : ""}
    </section>
  `;
}

function renderTransferRuleGuide() {
  return `
    <aside class="panel rule-guide">
      <div class="section-title">
        <h2>转会规则速查</h2>
        <span class="hint">来自规则策划书，租借按现行调整</span>
      </div>
      <div class="rule-grid">
        <div class="rule-block">
          <div class="rule-title">正常转会</div>
          <div class="rule-line"><span>普通档</span><strong>≤ 80-110 丸</strong></div>
          <div class="rule-line"><span>顶星档</span><strong>≤ 150-200 丸</strong></div>
          <p>不限制下限；需要转出队、转入队和球员三方同意。</p>
        </div>
        <div class="rule-block">
          <div class="rule-title">解约金</div>
          <div class="rule-line"><span>基础档</span><strong>150-160 丸</strong></div>
          <div class="rule-line"><span>顶星档</span><strong>245-260 丸</strong></div>
          <p>支付解约金后，在球员同意的情况下可直接带走，不需要与原球队谈判。</p>
        </div>
        <div class="rule-block">
          <div class="rule-title">临时租借</div>
          <div class="rule-line"><span>借入队支出</span><strong>8 丸</strong></div>
          <div class="rule-line"><span>出租队收入</span><strong>4 丸</strong></div>
          <p>剩余 4 丸直接扣除；租借只限一场，借入队踢完一场后自动归还。</p>
        </div>
        <div class="rule-block">
          <div class="rule-title">窗口与人数</div>
          <p>转会窗：1月1日-2月15日、8月1日-10月1日。第一年夏窗为6月1日-10月1日。</p>
          <p>正常转会窗下，球队剩余球员不得低于 8 人；每队注册人数不得超过 12 人。</p>
        </div>
      </div>
    </aside>
  `;
}

function renderTransferAdmin() {
  return `
    <section class="panel admin-panel">
      <div class="section-title">
        <h2>录入转会/租借</h2>
        <span class="hint">选择临时租借时价格会自动变为 8 丸，其中 4 丸给出租队</span>
      </div>
      <form id="transferForm" class="form-grid">
        <div class="field">
          <label>类型</label>
          <select name="type">
            <option value="normal">正常转会</option>
            <option value="release_clause">解约金转会</option>
            <option value="free_signup">自由球员签约</option>
            <option value="loan">临时租借</option>
            <option value="manual_move">手动调整归属</option>
          </select>
        </div>
        <div class="field">
          <label>日期</label>
          <input name="date" type="date" value="${today()}" />
        </div>
        <div class="field">
          <label>球员</label>
          <select name="playerId" required>${playerOptions()}</select>
        </div>
        <div class="field">
          <label>转出/出租队</label>
          <select name="fromTeamId">${teamOptions("", true, "无/自由球员")}</select>
        </div>
        <div class="field">
          <label>转入/借入队</label>
          <select name="toTeamId" required>${teamOptions()}</select>
        </div>
        <div class="field">
          <label>价格</label>
          <input name="amount" type="number" min="0" step="1" value="0" />
          <span class="hint">租借费固定为 8 丸，出租队只收入 4 丸</span>
        </div>
        <div class="field full">
          <label>备注</label>
          <textarea name="note" placeholder="例如：顶星档解约金、普通档租借费、组委会特批"></textarea>
        </div>
        <div class="field">
          <button class="btn primary" type="submit">保存转会记录</button>
        </div>
      </form>
    </section>
  `;
}

function renderTransferList(transfers, showAll, limit) {
  const list = (limit ? transfers.slice(0, limit) : transfers).filter((transfer) => showAll || !transfer.voided);
  if (!list.length) return `<div class="empty">暂无转会或租借信息。</div>`;

  return `
    <div class="list-stack">
      ${list
        .map((transfer) => {
          const player = getPlayer(transfer.playerId);
          const from = getTeam(transfer.fromTeamId);
          const to = getTeam(transfer.toTeamId);
          return `
            <div class="item-row ${transfer.voided ? "voided" : ""}">
              <div>
                <div class="item-title">
                  ${esc(player?.name || transfer.playerName || "未知球员")}
                  <span class="tag ${transfer.type === "loan" ? "loan" : "base"}">${transferTypeLabel(transfer.type)}</span>
                  ${transfer.type === "loan" ? renderLoanStatusTag(transfer) : ""}
                  ${transfer.voided ? `<span class="tag voided">已撤回</span>` : ""}
                </div>
                <div class="item-meta">
                  ${esc(transfer.date || "未填日期")} ·
                  ${from ? teamChip(from) : `<span class="tag free">自由/无</span>`}
                  →
                  ${to ? teamChip(to) : `<span class="tag free">未分配</span>`}
                  · ${transfer.amount || 0}丸
                </div>
                ${transfer.note ? `<div class="item-meta">备注：${esc(transfer.note)}</div>` : ""}
              </div>
              ${
                isAdmin() && !transfer.voided
                  ? `<button class="btn small danger" data-action="void-transfer" data-id="${transfer.id}">撤回</button>`
                  : ""
              }
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderScorersView(stats) {
  return `
    <section class="panel">
      <div class="section-title">
        <h2>射手榜</h2>
        <span class="hint">助攻榜已预留，后续可加入</span>
      </div>
      ${
        stats.scorers.length
          ? `<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>排名</th>
                    <th>球员</th>
                    <th>球队</th>
                    <th>身份</th>
                    <th>进球</th>
                  </tr>
                </thead>
                <tbody>
                  ${stats.scorers
                    .map(
                      (row, index) => `
                        <tr>
                          <td><span class="rank">${index + 1}</span></td>
                          <td><strong>${esc(row.name)}</strong></td>
                          <td>${row.team ? teamChip(row.team) : `<span class="tag free">未知</span>`}</td>
                          <td>${row.player ? playerTags(row.player) : `<span class="tag free">未登记</span>`}</td>
                          <td><strong>${row.goals}</strong></td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
          : `<div class="empty">暂无进球记录。</div>`
      }
    </section>
  `;
}

function renderSeasonView(stats) {
  if (!isAdmin()) return renderAdminLocked();

  return `
    ${renderSeasonAdmin(stats)}
    <section class="panel">
      <div class="section-title">
        <h2>管理日志</h2>
        <span class="hint">最近 30 条操作</span>
      </div>
      ${renderActionLog()}
    </section>
  `;
}

function renderAdminLocked() {
  return `
    <section class="panel admin-panel admin-locked">
      <div class="section-title">
        <h2>赛季管理</h2>
      </div>
      <div class="notice">赛季重开、数据导入导出、管理员交接需要进入管理员模式。</div>
    </section>
  `;
}

function renderSeasonAdmin(stats) {
  return `
    <section class="grid cols-2">
      <div class="panel admin-panel">
        <div class="section-title">
          <h2>当前赛季</h2>
          <span class="hint">${esc(getActiveSeason().id)}</span>
        </div>
        <form id="seasonNameForm" class="form-grid two">
          <div class="field">
            <label>赛季名称</label>
            <input name="seasonName" required value="${escAttr(getActiveSeason().name)}" />
          </div>
          <div class="field">
            <button class="btn primary" type="submit">保存赛季名称</button>
          </div>
        </form>
        <div class="notice" style="margin-top:12px">
          新赛季功能会归档当前赛季的比赛、转会、财政统计；球队和球员可以选择保留。
        </div>
      </div>
      <div class="panel admin-panel">
        <div class="section-title">
          <h2>开启新赛季</h2>
        </div>
        <form id="newSeasonForm" class="form-grid two">
          <div class="field">
            <label>新赛季名称</label>
            <input name="seasonName" required placeholder="例如 26-27学年第二学期赛季" />
          </div>
          <div class="field">
            <label>默认初始丸数</label>
            <input name="initialFunds" type="number" step="1" value="900" />
          </div>
          <label class="checkbox-line">
            <input name="keepPlayers" type="checkbox" checked />
            保留当前球员归属
          </label>
          <div class="field">
            <button class="btn primary" type="submit">归档并开启</button>
          </div>
        </form>
      </div>
      <div class="panel admin-panel">
        <div class="section-title">
          <h2>管理员交接</h2>
          <span class="hint">当前账号：${esc(state.adminName)}</span>
        </div>
        <form id="adminSettingsForm" class="form-grid two">
          <div class="field">
            <label>管理员账号</label>
            <input name="adminName" required value="${escAttr(state.adminName)}" />
          </div>
          <div class="field">
            <label>新管理员密码</label>
            <input name="adminPassword" type="password" placeholder="留空则不修改密码" />
          </div>
          <div class="field">
            <button class="btn primary" type="submit">保存管理员信息</button>
          </div>
        </form>
        <div class="notice" style="margin-top:12px">
          当前是轻量线上同步版，适合校内联赛快速使用；未来可再升级成服务端权限保护。
        </div>
      </div>
      <div class="panel admin-panel">
        <div class="section-title">
          <h2>数据备份</h2>
        </div>
        <div class="grid">
          <button class="btn primary" data-action="export-data">导出全部数据</button>
          <label class="field">
            <span>导入 JSON 备份</span>
            <input id="importDataInput" type="file" accept="application/json,.json" />
          </label>
          <button class="btn danger" data-action="reset-data">清空并恢复初始设置</button>
        </div>
      </div>
    </section>
  `;
}

function renderActionLog() {
  const logs = state.actionLog.slice().reverse().slice(0, 30);
  if (!logs.length) return `<div class="empty">暂无操作记录。</div>`;
  return `
    <div class="list-stack">
      ${logs
        .map(
          (log) => `
            <div class="item-row">
              <div>
                <div class="item-title">${esc(log.type)} · ${esc(log.title)}</div>
                <div class="item-meta">${formatDateTime(log.at)}${log.detail ? ` · ${esc(log.detail)}` : ""}</div>
              </div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function handleClick(event) {
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    ui.tab = tabButton.dataset.tab;
    localStorage.setItem(TAB_KEY, ui.tab);
    render();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  const id = actionButton.dataset.id;

  if (action === "logout") {
    localStorage.removeItem(AUTH_KEY);
    toast("已退出管理员模式");
    return;
  }

  if (action === "export-data") {
    exportData();
    return;
  }

  if (action === "toggle-login") {
    ui.loginOpen = !ui.loginOpen;
    render();
    return;
  }

  if (!isAdmin()) {
    toast("请先进入管理员模式");
    return;
  }

  if (action === "edit-player") {
    ui.editingPlayerId = id;
    ui.tab = "teams";
    render();
    return;
  }

  if (action === "cancel-edit-player") {
    ui.editingPlayerId = null;
    render();
    return;
  }

  if (action === "archive-player") {
    archivePlayer(id);
    return;
  }

  if (action === "void-match") {
    voidMatch(id);
    return;
  }

  if (action === "void-transfer") {
    voidTransfer(id);
    return;
  }

  if (action === "void-finance") {
    voidFinance(id);
    return;
  }

  if (action === "reset-data") {
    resetData();
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!form || !form.id) return;
  event.preventDefault();

  if (form.id === "loginForm") {
    await login(form);
    return;
  }

  if (!isAdmin()) {
    toast("请先进入管理员模式");
    return;
  }

  if (form.id === "playerForm") savePlayer(form);
  if (form.id === "matchForm") saveMatch(form);
  if (form.id === "transferForm") saveTransfer(form);
  if (form.id === "financeForm") saveFinance(form);
  if (form.id === "teamSettingsForm") saveTeamSettings(form);
  if (form.id === "seasonNameForm") saveSeasonName(form);
  if (form.id === "newSeasonForm") createNewSeason(form);
  if (form.id === "adminSettingsForm") await saveAdminSettings(form);
}

function handleChange(event) {
  if (event.target?.id === "importDataInput") {
    importData(event.target.files?.[0]);
    event.target.value = "";
    return;
  }

  if (event.target?.id === "rosterImportInput") {
    importRosterFile(event.target.files?.[0]);
    event.target.value = "";
    return;
  }

  if (event.target?.name === "playerId") {
    const form = event.target.closest("#transferForm");
    if (!form) return;
    const player = getPlayer(event.target.value);
    if (player) form.elements.fromTeamId.value = player.teamId || "";
  }

  if (event.target?.name === "type") {
    const form = event.target.closest("#transferForm");
    if (!form) return;
    const amountInput = form.elements.amount;
    if (event.target.value === "loan") {
      amountInput.value = "8";
      amountInput.readOnly = true;
    } else {
      amountInput.readOnly = false;
      if (amountInput.value === "8") amountInput.value = "0";
    }
  }
}

async function login(form) {
  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  const password = String(data.get("password") || "");
  if (username === state.adminName && (await verifyPassword(password))) {
    localStorage.setItem(AUTH_KEY, "true");
    ui.loginOpen = false;
    if (state.adminPassword) {
      state.adminPasswordHash = await digestPassword(password);
      delete state.adminPassword;
      saveState();
    }
    toast("已进入管理员模式");
  } else {
    ui.loginOpen = true;
    toast("管理员账号或密码不正确");
  }
}

async function verifyPassword(password) {
  if (state.adminPassword && password === state.adminPassword) return true;
  return (await digestPassword(password)) === state.adminPasswordHash;
}

async function digestPassword(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function savePlayer(form) {
  const data = new FormData(form);
  const id = String(data.get("playerId") || "");
  const name = String(data.get("name") || "").trim();
  if (!name) return toast("请填写球员姓名");

  const payload = {
    name,
    teamId: String(data.get("teamId") || ""),
    position: String(data.get("position") || "unknown"),
    tier: String(data.get("tier") || "ordinary"),
    captain: data.get("captain") === "on",
  };

  if (id) {
    const player = getPlayer(id);
    if (!player) return toast("找不到要编辑的球员");
    Object.assign(player, payload, { updatedAt: nowIso() });
    logAction("编辑球员", name, teamName(payload.teamId));
    ui.editingPlayerId = null;
    toast("球员信息已保存");
  } else {
    const player = {
      id: makeId("player"),
      active: true,
      createdAt: nowIso(),
      ...payload,
    };
    state.players.push(player);
    logAction("添加球员", name, teamName(payload.teamId));
    toast("球员已添加");
  }

  saveState();
  render();
}

function archivePlayer(id) {
  const player = getPlayer(id);
  if (!player) return;
  if (!confirm(`确认将 ${player.name} 移出当前名单？历史记录会保留。`)) return;
  player.active = false;
  player.updatedAt = nowIso();
  logAction("移出球员", player.name, teamName(player.teamId));
  saveState();
  toast("球员已移出名单");
}

function saveTeamSettings(form) {
  for (const team of state.teams) {
    team.name = String(form.elements[`name_${team.id}`]?.value || team.name).trim() || team.name;
    team.color = String(form.elements[`color_${team.id}`]?.value || team.color);
    const funds = Number(form.elements[`funds_${team.id}`]?.value || 0);
    team.initialFundsBySeason[getActiveSeason().id] = Number.isFinite(funds) ? funds : getTeamInitial(team.id);
  }
  logAction("编辑球队设置", getActiveSeason().name, "更新队名、颜色或初始丸数");
  saveState();
  toast("球队设置已保存");
}

function saveMatch(form) {
  const data = new FormData(form);
  const homeTeamId = String(data.get("homeTeamId") || "");
  const awayTeamId = String(data.get("awayTeamId") || "");
  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) return toast("请选择两支不同球队");

  let status = String(data.get("status") || "scheduled");
  let homeScore = numberOrNull(data.get("homeScore"));
  let awayScore = numberOrNull(data.get("awayScore"));
  if (status === "home_forfeit") {
    homeScore = homeScore ?? 0;
    awayScore = awayScore ?? 3;
  }
  if (status === "away_forfeit") {
    homeScore = homeScore ?? 3;
    awayScore = awayScore ?? 0;
  }

  const goals = parseGoals(String(data.get("goalsText") || ""));
  const match = {
    id: makeId("match"),
    seasonId: getActiveSeason().id,
    createdAt: nowIso(),
    voided: false,
    competition: String(data.get("competition") || "league"),
    date: String(data.get("date") || today()),
    status,
    homeTeamId,
    awayTeamId,
    homeScore,
    awayScore,
    penalties: String(data.get("penalties") || "").trim(),
    homeStarters: numberOrZero(data.get("homeStarters")),
    homeSubs: numberOrZero(data.get("homeSubs")),
    awayStarters: numberOrZero(data.get("awayStarters")),
    awaySubs: numberOrZero(data.get("awaySubs")),
    goals,
    note: String(data.get("note") || "").trim(),
  };

  state.matches.push(match);
  logAction("录入比赛", `${teamName(homeTeamId)} vs ${teamName(awayTeamId)}`, scoreText(match));
  if (isPlayed(match)) returnLoansAfterMatch(match);
  saveState();
  toast("比赛已保存，积分、射手和财政已自动更新");
}

function parseGoals(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
      const teamText = parts[0] || "";
      const playerText = parts[1] || "";
      const countText = parts[2] || "1";
      const team = findTeamByName(teamText);
      const player = findPlayerByName(playerText);
      return {
        teamId: team?.id || player?.teamId || "",
        playerId: player?.id || "",
        playerName: player?.name || playerText || "未知球员",
        count: Math.max(1, numberOrZero(countText) || 1),
      };
    });
}

function saveTransfer(form) {
  const data = new FormData(form);
  const player = getPlayer(String(data.get("playerId") || ""));
  if (!player) return toast("请选择球员");

  const type = String(data.get("type") || "normal");
  let fromTeamId = String(data.get("fromTeamId") || "");
  const toTeamId = String(data.get("toTeamId") || "");
  if (!toTeamId) return toast("请选择转入/借入队");
  if (fromTeamId && fromTeamId === toTeamId && type !== "manual_move") return toast("转出队和转入队不能相同");
  if (type === "loan") {
    if (getActiveLoan(player)) return toast("该球员已经处于租借状态，需归还后才能再次租借");
    fromTeamId = fromTeamId || player.teamId || "";
    if (!fromTeamId) return toast("租借必须选择出租队");
    if (fromTeamId === toTeamId) return toast("出租队和借入队不能相同");
  }

  const amount = type === "loan" ? 8 : Math.max(0, numberOrZero(data.get("amount")));

  const transfer = {
    id: makeId("transfer"),
    seasonId: getActiveSeason().id,
    createdAt: nowIso(),
    voided: false,
    type,
    date: String(data.get("date") || today()),
    playerId: player.id,
    playerName: player.name,
    fromTeamId,
    toTeamId,
    beforeTeamId: player.teamId || "",
    amount,
    loanStatus: type === "loan" ? "active" : "",
    returnedAt: "",
    returnedByMatchId: "",
    note: String(data.get("note") || "").trim(),
  };

  if (type === "loan") {
    player.teamId = toTeamId;
    player.loan = {
      active: true,
      transferId: transfer.id,
      fromTeamId,
      toTeamId,
      seasonId: getActiveSeason().id,
      startedAt: transfer.createdAt,
    };
    player.updatedAt = nowIso();
  } else {
    player.teamId = toTeamId;
    if (type === "free_signup") player.tier = player.tier === "free" ? "ordinary" : player.tier;
    player.loan = null;
    player.updatedAt = nowIso();
  }

  state.transfers.push(transfer);
  logAction("录入转会", `${player.name} ${transferTypeLabel(type)}`, `${teamName(fromTeamId)} → ${teamName(toTeamId)} · ${transfer.amount}丸`);
  saveState();
  toast(type === "loan" ? "租借已记录，财政已更新" : "转会已记录，球员归属和财政已更新");
}

function returnLoansAfterMatch(match) {
  const playingTeams = new Set([match.homeTeamId, match.awayTeamId]);
  const activeLoans = state.transfers.filter(
    (transfer) =>
      transfer.type === "loan" &&
      !transfer.voided &&
      transfer.loanStatus === "active" &&
      playingTeams.has(transfer.toTeamId),
  );

  for (const loan of activeLoans) {
    const player = getPlayer(loan.playerId);
    loan.loanStatus = "returned";
    loan.returnedAt = nowIso();
    loan.returnedByMatchId = match.id;
    if (player && player.teamId === loan.toTeamId) {
      player.teamId = loan.fromTeamId;
      player.loan = null;
      player.updatedAt = nowIso();
    }
    logAction("租借自动归还", loan.playerName || player?.name || "未知球员", `${teamName(loan.toTeamId)} 已完成一场比赛，归还至 ${teamName(loan.fromTeamId)}`);
  }
}

function reactivateLoansReturnedByMatch(match) {
  const loans = state.transfers.filter(
    (transfer) =>
      transfer.type === "loan" &&
      !transfer.voided &&
      transfer.loanStatus === "returned" &&
      transfer.returnedByMatchId === match.id,
  );

  for (const loan of loans) {
    const player = getPlayer(loan.playerId);
    loan.loanStatus = "active";
    loan.returnedAt = "";
    loan.returnedByMatchId = "";
    if (player && (!player.teamId || player.teamId === loan.fromTeamId)) {
      player.teamId = loan.toTeamId;
      player.loan = {
        active: true,
        transferId: loan.id,
        fromTeamId: loan.fromTeamId,
        toTeamId: loan.toTeamId,
        seasonId: loan.seasonId,
        startedAt: loan.createdAt,
      };
      player.updatedAt = nowIso();
    }
    logAction("撤回租借归还", loan.playerName || player?.name || "未知球员", `因比赛撤回，恢复至 ${teamName(loan.toTeamId)} 租借状态`);
  }
}

function saveFinance(form) {
  const data = new FormData(form);
  const teamId = String(data.get("teamId") || "");
  const amount = numberOrZero(data.get("amount"));
  if (!teamId || !amount) return toast("请选择球队并填写非零金额");

  const item = {
    id: makeId("finance"),
    seasonId: getActiveSeason().id,
    createdAt: nowIso(),
    voided: false,
    teamId,
    date: String(data.get("date") || today()),
    category: String(data.get("category") || "manual"),
    amount,
    note: String(data.get("note") || "").trim(),
  };

  state.financeAdjustments.push(item);
  logAction("财政调整", teamName(teamId), `${amount > 0 ? "+" : ""}${amount}丸 · ${item.note || financeCategoryLabel(item.category)}`);
  saveState();
  toast("财政流水已添加");
}

function saveSeasonName(form) {
  const name = String(new FormData(form).get("seasonName") || "").trim();
  if (!name) return toast("请填写赛季名称");
  getActiveSeason().name = name;
  logAction("修改赛季名称", name, "");
  saveState();
  toast("赛季名称已保存");
}

function createNewSeason(form) {
  const data = new FormData(form);
  const name = String(data.get("seasonName") || "").trim();
  if (!name) return toast("请填写新赛季名称");
  if (!confirm(`确认归档当前赛季并开启「${name}」？`)) return;

  const current = getActiveSeason();
  current.archived = true;
  current.archivedAt = nowIso();

  const id = makeId("season");
  const initialFunds = numberOrZero(data.get("initialFunds")) || 900;
  const keepPlayers = data.get("keepPlayers") === "on";

  state.seasons.push({ id, name, archived: false, createdAt: nowIso() });
  state.activeSeasonId = id;
  for (const team of state.teams) {
    team.initialFundsBySeason[id] = initialFunds;
  }
  if (!keepPlayers) {
    for (const player of state.players) player.teamId = "";
  }

  logAction("开启新赛季", name, keepPlayers ? "保留球员归属" : "球员归属已清空");
  saveState();
  ui.tab = "overview";
  toast("新赛季已开启");
}

async function saveAdminSettings(form) {
  const data = new FormData(form);
  const adminName = String(data.get("adminName") || "").trim();
  const adminPassword = String(data.get("adminPassword") || "");
  if (!adminName) return toast("管理员账号不能为空");
  state.adminName = adminName;
  if (adminPassword) {
    state.adminPasswordHash = await digestPassword(adminPassword);
    delete state.adminPassword;
  }
  logAction("管理员交接设置", adminName, "更新管理员账号或密码");
  saveState();
  toast("管理员信息已保存");
}

function voidMatch(id) {
  const match = state.matches.find((item) => item.id === id);
  if (!match || match.voided) return;
  if (!confirm("确认撤回这场比赛？相关积分、进球和出场成本会从统计中移除。")) return;
  reactivateLoansReturnedByMatch(match);
  match.voided = true;
  match.voidedAt = nowIso();
  logAction("撤回比赛", `${teamName(match.homeTeamId)} vs ${teamName(match.awayTeamId)}`, scoreText(match));
  saveState();
  toast("比赛已撤回");
}

function voidTransfer(id) {
  const transfer = state.transfers.find((item) => item.id === id);
  if (!transfer || transfer.voided) return;
  if (!confirm("确认撤回这条转会/租借？相关财政会从统计中移除。")) return;
  transfer.voided = true;
  transfer.voidedAt = nowIso();

  const player = getPlayer(transfer.playerId);
  if (player) {
    if (transfer.type === "loan") {
      if (player.loan?.transferId === transfer.id) player.loan = null;
      if (player.teamId === transfer.toTeamId) player.teamId = transfer.fromTeamId || transfer.beforeTeamId || "";
      player.updatedAt = nowIso();
    } else if (player.teamId === transfer.toTeamId) {
      player.teamId = transfer.beforeTeamId || transfer.fromTeamId || "";
      player.updatedAt = nowIso();
    }
  }

  logAction("撤回转会", transfer.playerName || "未知球员", `${teamName(transfer.fromTeamId)} → ${teamName(transfer.toTeamId)}`);
  saveState();
  toast("转会已撤回");
}

function voidFinance(id) {
  const item = state.financeAdjustments.find((entry) => entry.id === id);
  if (!item || item.voided) return;
  if (!confirm("确认撤回这笔手动财政流水？")) return;
  item.voided = true;
  item.voidedAt = nowIso();
  logAction("撤回财政", teamName(item.teamId), `${item.amount > 0 ? "+" : ""}${item.amount}丸`);
  saveState();
  toast("财政流水已撤回");
}

function resetData() {
  if (!confirm("确认清空本地数据并恢复初始设置？此操作建议先导出备份。")) return;
  const fresh = defaultState();
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, fresh);
  saveState();
  localStorage.removeItem(AUTH_KEY);
  ui.tab = "overview";
  ui.editingPlayerId = null;
  toast("已恢复初始设置");
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `101-super-league-${today()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importData(file) {
  if (!file || !isAdmin()) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = normalizeState(JSON.parse(String(reader.result || "{}")));
      Object.keys(state).forEach((key) => delete state[key]);
      Object.assign(state, imported);
      logAction("导入数据", file.name, "从 JSON 备份恢复");
      saveState();
      toast("数据已导入");
    } catch {
      toast("导入失败，请确认 JSON 文件格式");
    }
  };
  reader.readAsText(file);
}

async function importRosterFile(file) {
  if (!file || !isAdmin()) return;
  if (!window.XLSX) return toast("Excel 导入组件未加载，请刷新页面后重试");

  try {
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array" });
    const rows = workbook.SheetNames.flatMap((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return window.XLSX.utils.sheet_to_json(sheet, { defval: "" }).map((row) => ({
        ...row,
        __sheetName: sheetName,
      }));
    });
    if (!rows.length) return toast("名单为空，请确认第一行是表头");

    const result = importRosterRows(rows);
    if (!result.added && !result.updated) {
      return toast(`没有导入球员，已跳过 ${result.skipped} 行`);
    }

    const detail = [
      `新增 ${result.added}`,
      `更新 ${result.updated}`,
      result.skipped ? `跳过 ${result.skipped}` : "",
      result.unknownTeams.length ? `未知球队：${result.unknownTeams.join("、")}` : "",
    ]
      .filter(Boolean)
      .join("；");

    logAction("导入球员名单", file.name, detail);
    saveState();
    toast(`球员名单已导入：${detail}`);
  } catch (error) {
    console.warn(error);
    toast("导入失败，请确认 Excel/CSV 文件格式");
  }
}

function importRosterRows(rows) {
  const result = {
    added: 0,
    updated: 0,
    skipped: 0,
    unknownTeams: [],
  };
  const unknownTeamSet = new Set();

  for (const row of rows) {
    const name = pickRosterValue(row, ROSTER_IMPORT_COLUMNS.name).trim();
    if (!name) {
      result.skipped += 1;
      continue;
    }

    const teamText = pickRosterValue(row, ROSTER_IMPORT_COLUMNS.team).trim();
    const sheetTeamId = parseRosterTeamId(row.__sheetName);
    let teamId = teamText ? parseRosterTeamId(teamText) : sheetTeamId;
    if (!teamText && !teamId) teamId = "";
    if (teamText && !teamId && !isFreeTeamText(teamText)) {
      unknownTeamSet.add(teamText);
      result.skipped += 1;
      continue;
    }

    const payload = {
      name,
      teamId,
      position: parseRosterPosition(
        pickRosterValue(row, ROSTER_IMPORT_COLUMNS.position),
        pickRosterValue(row, ROSTER_IMPORT_COLUMNS.goalkeeper),
      ),
      tier: parseRosterTier(pickRosterValue(row, ROSTER_IMPORT_COLUMNS.tier)),
      captain: parseRosterCaptain(pickRosterValue(row, ROSTER_IMPORT_COLUMNS.captain)),
    };

    const existing = findPlayerByName(name);
    if (existing) {
      Object.assign(existing, payload, { active: true, updatedAt: nowIso() });
      result.updated += 1;
    } else {
      state.players.push({
        id: makeId("player"),
        active: true,
        createdAt: nowIso(),
        ...payload,
      });
      result.added += 1;
    }
  }

  result.unknownTeams = [...unknownTeamSet];
  return result;
}

function pickRosterValue(row, candidates) {
  const entries = Object.entries(row);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeRosterKey(candidate);
    const match = entries.find(([key]) => normalizeRosterKey(key) === normalizedCandidate);
    if (match) return String(match[1] ?? "");
  }
  return "";
}

function normalizeRosterKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()_\-]/g, "");
}

function normalizeRosterText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function parseRosterTeamId(value) {
  const text = normalizeRosterText(value);
  if (!text || isFreeTeamText(text)) return "";
  const aliases = {
    "101fc": "team-101fc",
    "101竞技": "team-101jj",
    "101jj": "team-101jj",
    "竞技": "team-101jj",
    "格调": "team-gediao",
    gediao: "team-gediao",
    poi: "team-poi",
    chasing: "team-chasing",
  };
  const team = state.teams.find((item) => normalizeRosterText(item.name) === text || normalizeRosterText(item.id) === text);
  return team?.id || aliases[text] || "";
}

function isFreeTeamText(value) {
  const text = normalizeRosterText(value);
  return ["自由", "自由球员", "无", "未分配", "free", "none", "na", "n/a"].includes(text);
}

function parseRosterPosition(positionValue, goalkeeperValue) {
  const goalkeeperText = normalizeRosterText(goalkeeperValue);
  const positionText = normalizeRosterText(positionValue);
  const goalkeeperTexts = ["gk", "门将", "守门员", "goalkeeper", "keeper"];
  if (isTruthyRosterValue(goalkeeperText) || goalkeeperTexts.includes(goalkeeperText) || goalkeeperTexts.includes(positionText)) return "GK";
  if (!positionText) return "unknown";
  if (["未定", "未知", "unknown", "na", "n/a"].includes(positionText)) return "unknown";
  return "field";
}

function parseRosterTier(value) {
  const text = normalizeRosterText(value);
  if (!text) return "ordinary";
  if (["顶星", "顶星档", "top", "star", "明星", "明星档"].includes(text)) return "top";
  if (["基础", "基础档", "base"].includes(text)) return "base";
  if (["自由", "自由球员", "free"].includes(text)) return "free";
  if (["租借", "租借球员", "loan"].includes(text)) return "loan";
  return "ordinary";
}

function parseRosterCaptain(value) {
  return isTruthyRosterValue(value);
}

function isTruthyRosterValue(value) {
  const text = normalizeRosterText(value);
  return ["是", "对", "真", "yes", "y", "true", "1", "队长", "captain", "c"].includes(text);
}

function collectStats() {
  const seasonId = getActiveSeason().id;
  const activeTeams = state.teams.filter((team) => team.active);
  const players = activePlayers();
  const playersByTeam = Object.fromEntries(activeTeams.map((team) => [team.id, []]));
  const freePlayers = [];
  for (const player of players) {
    if (player.teamId && playersByTeam[player.teamId]) playersByTeam[player.teamId].push(player);
    else freePlayers.push(player);
  }
  for (const list of Object.values(playersByTeam)) {
    list.sort(playerSort);
  }

  const matches = state.matches
    .filter((match) => match.seasonId === seasonId)
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt.localeCompare(a.createdAt));
  const transfers = state.transfers
    .filter((transfer) => transfer.seasonId === seasonId)
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt.localeCompare(a.createdAt));

  const standings = computeStandings(activeTeams, matches);
  const scorers = computeScorers(matches);
  const { financeSummary, ledgerByTeam } = computeFinance(activeTeams, matches, transfers);

  return {
    teams: activeTeams,
    players,
    playersByTeam,
    freePlayers,
    matches,
    recentMatches: matches.filter((match) => !match.voided),
    transfers,
    recentTransfers: transfers.filter((transfer) => !transfer.voided),
    standings,
    scorers,
    financeSummary,
    ledgerByTeam,
  };
}

function computeStandings(teams, matches) {
  const rows = Object.fromEntries(
    teams.map((team) => [
      team.id,
      {
        team,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        gf: 0,
        ga: 0,
        gd: 0,
        points: 0,
      },
    ]),
  );

  for (const match of matches) {
    if (match.voided || match.competition !== "league" || !isPlayed(match)) continue;
    const home = rows[match.homeTeamId];
    const away = rows[match.awayTeamId];
    if (!home || !away) continue;

    const hs = Number(match.homeScore || 0);
    const as = Number(match.awayScore || 0);
    home.played += 1;
    away.played += 1;
    home.gf += hs;
    home.ga += as;
    away.gf += as;
    away.ga += hs;

    if (hs > as) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (as > hs) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  return Object.values(rows)
    .map((row) => ({ ...row, gd: row.gf - row.ga }))
    .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || (a.team.order ?? 0) - (b.team.order ?? 0));
}

function computeScorers(matches) {
  const map = new Map();
  for (const match of matches) {
    if (match.voided || !isPlayed(match)) continue;
    for (const goal of match.goals || []) {
      const key = goal.playerId || `${goal.teamId}-${goal.playerName}`;
      const current = map.get(key) || {
        playerId: goal.playerId,
        name: goal.playerName,
        teamId: goal.teamId,
        goals: 0,
      };
      current.goals += Number(goal.count || 1);
      map.set(key, current);
    }
  }

  return [...map.values()]
    .map((row) => {
      const player = getPlayer(row.playerId);
      return {
        ...row,
        player,
        name: player?.name || row.name,
        team: getTeam(row.teamId || player?.teamId),
      };
    })
    .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "zh-CN"));
}

function computeFinance(teams, matches, transfers) {
  const seasonId = getActiveSeason().id;
  const ledgerByTeam = Object.fromEntries(teams.map((team) => [team.id, []]));

  for (const team of teams) {
    ledgerByTeam[team.id].push({
      teamId: team.id,
      date: getActiveSeason().createdAt?.slice(0, 10) || "",
      createdAt: getActiveSeason().createdAt || nowIso(),
      amount: getTeamInitial(team.id),
      type: "初始资金",
      note: getActiveSeason().name,
      sourceType: "initial",
      sourceId: getActiveSeason().id,
    });
  }

  for (const match of matches) {
    if (match.voided || !isPlayed(match)) continue;
    addMatchCost(ledgerByTeam, match, "home");
    addMatchCost(ledgerByTeam, match, "away");
  }

  for (const transfer of transfers) {
    if (transfer.voided) continue;
    addTransferLedger(ledgerByTeam, transfer);
  }

  for (const item of state.financeAdjustments.filter((entry) => entry.seasonId === seasonId)) {
    if (!ledgerByTeam[item.teamId]) continue;
    ledgerByTeam[item.teamId].push({
      teamId: item.teamId,
      date: item.date,
      createdAt: item.createdAt,
      amount: item.voided ? 0 : Number(item.amount || 0),
      type: financeCategoryLabel(item.category),
      note: item.note,
      sourceType: "finance",
      sourceId: item.id,
      voided: item.voided,
    });
  }

  const financeSummary = teams.map((team) => {
    const entries = ledgerByTeam[team.id] || [];
    const initial = getTeamInitial(team.id);
    const income = entries
      .filter((entry) => entry.type !== "初始资金" && entry.amount > 0)
      .reduce((sum, entry) => sum + entry.amount, 0);
    const expense = Math.abs(
      entries
        .filter((entry) => entry.amount < 0)
        .reduce((sum, entry) => sum + entry.amount, 0),
    );
    return {
      team,
      initial,
      income,
      expense,
      balance: initial + income - expense,
    };
  });

  return { ledgerByTeam, financeSummary };
}

function addMatchCost(ledgerByTeam, match, side) {
  const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
  const starters = Number(match[`${side}Starters`] || 0);
  const subs = Number(match[`${side}Subs`] || 0);
  const cost = starters * 4 + subs * 2;
  if (!cost || !ledgerByTeam[teamId]) return;

  ledgerByTeam[teamId].push({
    teamId,
    date: match.date,
    createdAt: match.createdAt,
    amount: -cost,
    type: "出场成本",
    note: `${teamName(match.homeTeamId)} vs ${teamName(match.awayTeamId)} · 首发${starters}人 替补${subs}人`,
    sourceType: "match",
    sourceId: match.id,
  });
}

function addTransferLedger(ledgerByTeam, transfer) {
  const amount = Number(transfer.amount || 0);
  if (!amount) return;

  if (transfer.type === "manual_move") return;

  const type = transferTypeLabel(transfer.type);
  if (transfer.toTeamId && ledgerByTeam[transfer.toTeamId]) {
    ledgerByTeam[transfer.toTeamId].push({
      teamId: transfer.toTeamId,
      date: transfer.date,
      createdAt: transfer.createdAt,
      amount: -amount,
      type,
      note: `${transfer.playerName} · 支出`,
      sourceType: "transfer",
      sourceId: transfer.id,
    });
  }

  if (transfer.fromTeamId && ledgerByTeam[transfer.fromTeamId] && transfer.type !== "free_signup") {
    const incomeAmount = transfer.type === "loan" ? Math.min(4, amount) : amount;
    ledgerByTeam[transfer.fromTeamId].push({
      teamId: transfer.fromTeamId,
      date: transfer.date,
      createdAt: transfer.createdAt,
      amount: incomeAmount,
      type,
      note: transfer.type === "loan" ? `${transfer.playerName} · 租借收入（另4丸扣除）` : `${transfer.playerName} · 收入`,
      sourceType: "transfer",
      sourceId: transfer.id,
    });
  }
}

function isPlayed(match) {
  return ["completed", "home_forfeit", "away_forfeit"].includes(match.status);
}

function activePlayers() {
  return state.players.filter((player) => player.active !== false);
}

function getActiveSeason() {
  return state.seasons.find((season) => season.id === state.activeSeasonId) || state.seasons[0];
}

function getTeam(id) {
  return state.teams.find((team) => team.id === id);
}

function getPlayer(id) {
  return state.players.find((player) => player.id === id);
}

function findTeamByName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return state.teams.find((team) => team.name.toLowerCase() === normalized);
}

function findPlayerByName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return activePlayers().find((player) => player.name.toLowerCase() === normalized);
}

function getTeamInitial(teamId) {
  const team = getTeam(teamId);
  if (!team) return 0;
  return Number(team.initialFundsBySeason?.[getActiveSeason().id] ?? team.initialFunds ?? 900);
}

function teamName(teamId) {
  return getTeam(teamId)?.name || "无/未分配";
}

function teamChip(team) {
  if (!team) return `<span class="tag free">未知球队</span>`;
  return `<span class="team-chip" style="background:${escAttr(team.color)}">${esc(team.name)}</span>`;
}

function playerTags(player) {
  const tags = [];
  if (player.captain) tags.push(`<span class="tag captain">队长</span>`);
  if (player.position === "GK") tags.push(`<span class="tag gk">GK</span>`);
  if (getActiveLoan(player)) tags.push(`<span class="tag loan">租借</span>`);
  const tierClass = player.tier === "top" ? "top" : player.tier === "base" ? "base" : player.tier === "free" ? "free" : player.tier === "loan" ? "loan" : "ordinary";
  tags.push(`<span class="tag ${tierClass}">${playerTierLabel(player.tier)}</span>`);
  return tags.join("");
}

function getActiveLoan(player) {
  if (!player?.loan?.active) return null;
  const transfer = state.transfers.find((item) => item.id === player.loan.transferId);
  if (!transfer || transfer.voided || transfer.loanStatus !== "active") return null;
  return transfer;
}

function renderLoanStatusTag(transfer) {
  if (transfer.loanStatus === "returned") return `<span class="tag ordinary">已归还</span>`;
  return `<span class="tag loan">租借中</span>`;
}

function teamOptions(selected = "", includeEmpty = false, emptyLabel = "无") {
  return `
    ${includeEmpty ? `<option value="" ${selected ? "" : "selected"}>${esc(emptyLabel)}</option>` : ""}
    ${state.teams
      .filter((team) => team.active)
      .map((team) => `<option value="${team.id}" ${team.id === selected ? "selected" : ""}>${esc(team.name)}</option>`)
      .join("")}
  `;
}

function playerOptions(selected = "") {
  const players = activePlayers().slice().sort(playerSort);
  return players
    .map((player) => `<option value="${player.id}" ${player.id === selected ? "selected" : ""}>${esc(player.name)} · ${esc(teamName(player.teamId))}</option>`)
    .join("");
}

function option(value, label, selected) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
}

function playerSort(a, b) {
  const tierWeight = { top: 0, base: 1, ordinary: 2, loan: 3, free: 4 };
  return (tierWeight[a.tier] ?? 5) - (tierWeight[b.tier] ?? 5) || Number(b.captain) - Number(a.captain) || a.name.localeCompare(b.name, "zh-CN");
}

function formatGoals(goals) {
  return goals
    .map((goal) => `${esc(goal.playerName)}${goal.count > 1 ? ` x${goal.count}` : ""}`)
    .join("、");
}

function scoreText(match) {
  if (!isPlayed(match) || match.homeScore === null || match.awayScore === null) return "未赛/待定";
  return `${match.homeScore} - ${match.awayScore}`;
}

function competitionLabel(value) {
  return {
    league: "联赛",
    cup: "杯赛",
    qualifier: "杯赛资格赛",
    final: "决赛/三四名",
    friendly: "特殊/友谊赛",
  }[value] || value;
}

function statusLabel(value) {
  return {
    scheduled: "预计/未赛",
    completed: "已完赛",
    home_forfeit: "主队弃权",
    away_forfeit: "客队弃权",
  }[value] || value;
}

function transferTypeLabel(value) {
  return {
    normal: "正常转会",
    release_clause: "解约金",
    free_signup: "自由签约",
    loan: "临时租借",
    manual_move: "手动调整",
  }[value] || value;
}

function playerTierLabel(value) {
  return {
    top: "顶星档",
    base: "基础档",
    ordinary: "普通档",
    free: "自由球员",
    loan: "租借球员",
  }[value] || "普通档";
}

function financeCategoryLabel(value) {
  return {
    bonus: "奖金/收入",
    fine: "罚款/支出",
    subsidy: "补助",
    manual: "特殊调整",
  }[value] || "特殊调整";
}

function logAction(type, title, detail) {
  state.actionLog.push({
    id: makeId("log"),
    at: nowIso(),
    type,
    title,
    detail,
  });
}

function isAdmin() {
  return localStorage.getItem(AUTH_KEY) === "true";
}

function toast(message) {
  ui.toast = message;
  render();
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    ui.toast = "";
    render();
  }, 2400);
}

function exportNameSafe(value) {
  return String(value || "").replace(/[^\w.-]+/g, "-");
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function formatDateTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function makeId(prefix) {
  if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escAttr(value) {
  return esc(value);
}

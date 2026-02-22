/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Hedge Fund Management UI
   Funds Tab, Fund Details, Strategy Management
   ═══════════════════════════════════════════════════════════════════════════════ */

const Funds = {
  myFunds: [],
  currentFund: null,
  currentTab: 'overview',
  members: [],
  strategies: [],
  customStrategies: [],
  capitalTransactions: [],
  navData: null,
  investorLedger: [],
  reconciliation: null,
  riskSettings: null,
  riskUtilization: null,
  riskBreaches: [],
  dashboardData: null,
  dashboardInterval: null,

  // Pre-built strategy types
  STRATEGY_TYPES: {
    'mean_reversion': { name: 'Mean Reversion', icon: '🔄', desc: 'Buy oversold, sell overbought assets' },
    'momentum': { name: 'Momentum', icon: '🚀', desc: 'Follow market trends and momentum' },
    'grid': { name: 'Grid Trading', icon: '📊', desc: 'Place buy/sell orders at fixed intervals' },
    'pairs': { name: 'Pairs Trading', icon: '🔗', desc: 'Trade correlated asset pairs' },
    'custom': { name: 'Custom Strategy', icon: '⚙️', desc: 'Write your own trading logic' }
  },
  CUSTOM_STRATEGY_TEMPLATES: {
    momentum_breakout: {
      name: 'Momentum Breakout',
      code: `function run(context) {
  const { ticker, parameters, state } = context;
  const symbol = String(parameters.ticker || 'OGLD').toUpperCase();
  const px = ticker(symbol);
  if (!px || !Number.isFinite(px.price)) return { action: 'hold', ticker: symbol, reason: 'no_price' };

  const lookback = Math.max(3, Number(parameters.lookback || 12));
  const thresholdPct = Math.max(0.05, Number(parameters.thresholdPct || 0.35));

  const history = Array.isArray(state.prices) ? state.prices : [];
  history.push(px.price);
  if (history.length > lookback + 2) history.shift();
  state.prices = history;

  if (history.length < lookback + 1) return { action: 'hold', ticker: symbol, reason: 'warming_up' };

  const anchor = history[history.length - lookback - 1];
  const movePct = ((px.price - anchor) / anchor) * 100;

  if (movePct >= thresholdPct) return { action: 'buy', ticker: symbol, reason: 'breakout' };
  if (movePct <= -thresholdPct) return { action: 'sell', ticker: symbol, reason: 'breakdown' };
  return { action: 'hold', ticker: symbol, reason: 'inside_band' };
}`
    },
    mean_reversion_band: {
      name: 'Mean Reversion Band',
      code: `function run(context) {
  const { ticker, parameters, state } = context;
  const symbol = String(parameters.ticker || 'EURUSD').toUpperCase();
  const px = ticker(symbol);
  if (!px || !Number.isFinite(px.price)) return { action: 'hold', ticker: symbol, reason: 'no_price' };

  const windowSize = Math.max(5, Number(parameters.window || 20));
  const bandPct = Math.max(0.05, Number(parameters.bandPct || 0.4));

  const history = Array.isArray(state.prices) ? state.prices : [];
  history.push(px.price);
  if (history.length > windowSize) history.shift();
  state.prices = history;

  if (history.length < windowSize) return { action: 'hold', ticker: symbol, reason: 'warming_up' };

  const mean = history.reduce((sum, n) => sum + n, 0) / history.length;
  const deviationPct = ((px.price - mean) / mean) * 100;

  if (deviationPct <= -bandPct) return { action: 'buy', ticker: symbol, reason: 'below_mean_band' };
  if (deviationPct >= bandPct) return { action: 'sell', ticker: symbol, reason: 'above_mean_band' };
  return { action: 'hold', ticker: symbol, reason: 'near_mean' };
}`
    }
  },

  // ─── Main Render ────────────────────────────────────────────────────────────
  async render(container) {
    await this.loadMyFunds();

    container.innerHTML = `
      <div class="terminal-layout">
        ${Terminal.renderHeader()}
        <div class="funds-page">
          ${this.renderContent()}
        </div>
      </div>
    `;

    Terminal.startClock();
    this.bindEvents();
  },

  renderContent() {
    // If viewing a specific fund
    if (this.currentFund) {
      return this.renderFundDetails();
    }

    // Otherwise show funds list
    return this.renderFundsList();
  },

  isManagerRole(role) {
    return role === 'owner' || role === 'analyst';
  },

  getManageableFunds() {
    return this.myFunds.filter(fund => this.isManagerRole(fund.role));
  },

  // ─── Funds List ──────────────────────────────────────────────────────────────
  renderFundsList() {
    const manageableFunds = this.getManageableFunds();
    const hasClientOnlyFunds = this.myFunds.length > 0 && manageableFunds.length === 0;

    if (hasClientOnlyFunds) {
      return this.renderRestrictedState();
    }

    return `
      <div class="funds-header">
        <h1>🏦 Hedge Funds</h1>
        <p class="page-subtitle">Create and manage collaborative trading funds</p>
      </div>

      ${manageableFunds.length > 0 ? `
      <div class="funds-actions">
        <button class="btn-primary" onclick="Funds.showCreateFundModal()">
          + Create New Fund
        </button>
      </div>
      ` : ''}

      ${manageableFunds.length === 0 ? this.renderEmptyState() : this.renderFundsGrid(manageableFunds)}
    `;
  },

  renderRestrictedState() {
    return `
      <div class="funds-empty-state">
        <div class="empty-icon">🔒</div>
        <h3>Manager Access Required</h3>
        <p>You need an analyst or owner role to access hedge fund management.</p>
        <button class="btn-secondary" onclick="window.location.hash='#/client-portal'">Go to My Portal</button>
      </div>
    `;
  },

  renderEmptyState() {
    return `
      <div class="funds-empty-state">
        <div class="empty-icon">🏦</div>
        <h3>No Funds Yet</h3>
        <p>Create your first hedge fund to start collaborative trading with strategies.</p>
        <button class="btn-primary" onclick="Funds.showCreateFundModal()">Create Your First Fund</button>
      </div>
    `;
  },

  renderFundsGrid(funds = this.myFunds) {
    return `
      <div class="funds-grid">
        ${funds.map(fund => this.renderFundCard(fund)).join('')}
      </div>
    `;
  },

  renderFundCard(fund) {
    const roleClass = fund.role === 'owner' ? 'role-owner' : (fund.role === 'analyst' ? 'role-analyst' : 'role-client');
    const roleLabel = fund.role.charAt(0).toUpperCase() + fund.role.slice(1);

    return `
      <div class="fund-card" onclick="Funds.viewFund('${fund.id}')">
        <div class="fund-card-header">
          <span class="fund-name">${fund.name}</span>
          <span class="fund-role ${roleClass}">${roleLabel}</span>
        </div>
        <div class="fund-strategy-type">
          <span class="strategy-type-badge">${this.STRATEGY_TYPES[fund.strategy_type]?.icon || '📈'} ${fund.strategy_type.replace('_', ' ')}</span>
        </div>
        ${fund.description ? `<p class="fund-description">${fund.description}</p>` : ''}
        <div class="fund-meta">
          <span class="fund-meta-item">
            <span class="meta-label">Min Investment</span>
            <span class="meta-value">${Utils.money(fund.min_investment)}</span>
          </span>
          <span class="fund-meta-item">
            <span class="meta-label">Mgmt Fee</span>
            <span class="meta-value">${(fund.management_fee * 100).toFixed(1)}%</span>
          </span>
        </div>
      </div>
    `;
  },

  // ─── Fund Details ────────────────────────────────────────────────────────────
  renderFundDetails() {
    const fund = this.currentFund;
    const isOwner = fund.role === 'owner';
    const isAnalyst = fund.role === 'analyst' || isOwner;

    return `
      <div class="fund-details">
        <div class="fund-details-header">
          <button class="back-btn" onclick="Funds.backToList()">← Back to Funds</button>
          <div class="fund-title-section">
            <h1>${fund.name}</h1>
            <span class="fund-role ${fund.role === 'owner' ? 'role-owner' : (fund.role === 'analyst' ? 'role-analyst' : 'role-client')}">${fund.role.toUpperCase()}</span>
          </div>
          ${isOwner ? `
            <button class="btn-secondary" onclick="Funds.showEditFundModal()">Edit Fund</button>
            <button class="btn-danger" onclick="Funds.deleteFund()">Delete Fund</button>
          ` : ''}
        </div>

        <div class="fund-tabs">
          <button class="fund-tab ${this.currentTab === 'overview' ? 'active' : ''}" data-tab="overview">Overview</button>
          ${isAnalyst ? `
          <button class="fund-tab ${this.currentTab === 'members' ? 'active' : ''}" data-tab="members">Members</button>
          <button class="fund-tab ${this.currentTab === 'capital' ? 'active' : ''}" data-tab="capital">Capital</button>
          <button class="fund-tab ${this.currentTab === 'risk' ? 'active' : ''}" data-tab="risk">Risk</button>
          <button class="fund-tab ${this.currentTab === 'strategies' ? 'active' : ''}" data-tab="strategies">Strategies</button>
          <button class="fund-tab ${this.currentTab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">📊 Dashboard</button>
          ` : ''}
        </div>

        <div class="fund-tab-content">
          ${this.renderTabContent()}
        </div>
      </div>
    `;
  },

  renderTabContent() {
    const isAnalyst = this.currentFund?.role === 'owner' || this.currentFund?.role === 'analyst';
    if (!isAnalyst && this.currentTab !== 'overview') {
      return `
        <div class="empty-state">
          <span class="empty-icon">🔒</span>
          <span class="empty-text">Analyst or owner access is required for this section.</span>
        </div>
      `;
    }

    switch (this.currentTab) {
      case 'overview': return this.renderOverviewTab();
      case 'members': return this.renderMembersTab();
      case 'capital': return this.renderCapitalTab();
      case 'risk': return this.renderRiskTab();
      case 'strategies': return this.renderStrategiesTab();
      case 'dashboard': return this.renderDashboardTab();
      default: return this.renderOverviewTab();
    }
  },

  // ─── Overview Tab ────────────────────────────────────────────────────────────
  renderOverviewTab() {
    const fund = this.currentFund;

    return `
      <div class="overview-grid">
        <div class="overview-card">
          <div class="card-label">Strategy Type</div>
          <div class="card-value">
            <span class="strategy-icon">${this.STRATEGY_TYPES[fund.strategy_type]?.icon || '📈'}</span>
            ${this.STRATEGY_TYPES[fund.strategy_type]?.name || fund.strategy_type}
          </div>
        </div>
        <div class="overview-card">
          <div class="card-label">Min Investment</div>
          <div class="card-value">${Utils.money(fund.min_investment)}</div>
        </div>
        <div class="overview-card">
          <div class="card-label">Management Fee</div>
          <div class="card-value">${(fund.management_fee * 100).toFixed(1)}%</div>
        </div>
        <div class="overview-card">
          <div class="card-label">Performance Fee</div>
          <div class="card-value">${(fund.performance_fee * 100).toFixed(1)}%</div>
        </div>
      </div>

      ${fund.description ? `
      <div class="overview-description">
        <h3>Description</h3>
        <p>${fund.description}</p>
      </div>
      ` : ''}

      <div class="overview-stats">
        <div class="overview-card">
          <div class="card-label">Members</div>
          <div class="card-value">${this.members.length}</div>
        </div>
        <div class="overview-card">
          <div class="card-label">Active Strategies</div>
          <div class="card-value">${this.strategies.filter(s => s.is_active).length}</div>
        </div>
      </div>
    `;
  },

  // ─── Members Tab ─────────────────────────────────────────────────────────────
  renderMembersTab() {
    const isOwner = this.currentFund.role === 'owner';

    return `
      <div class="members-section">
        ${isOwner ? `
        <div class="section-actions">
          <button class="btn-primary" onclick="Funds.showAddMemberModal()">+ Add Member</button>
        </div>
        ` : ''}

        ${this.members.length === 0 ? `
        <div class="empty-state">
          <span class="empty-icon">👥</span>
          <span class="empty-text">No members yet</span>
        </div>
        ` : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Joined</th>
              ${isOwner ? '<th>Actions</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${this.members.map(m => this.renderMemberRow(m, isOwner)).join('')}
          </tbody>
        </table>
        `}
      </div>
    `;
  },

  renderMemberRow(member, isOwner) {
    const roleClass = member.role === 'owner' ? 'role-owner' : (member.role === 'analyst' ? 'role-analyst' : 'role-client');

    return `
      <tr>
        <td style="font-weight:600">${member.username}</td>
        <td><span class="fund-role ${roleClass}">${member.role}</span></td>
        <td class="text-muted">${Utils.formatDate(member.joined_at)}</td>
        ${isOwner ? `
        <td>
          ${member.role !== 'owner' ? `
          <button class="action-btn" onclick="Funds.showEditMemberModal('${member.user_id}', '${member.role}')">Edit</button>
          <button class="action-btn danger" onclick="Funds.removeMember('${member.user_id}')">Remove</button>
          ` : '<span class="text-muted">—</span>'}
        </td>
        ` : ''}
      </tr>
    `;
  },

  // ─── Capital Tab ─────────────────────────────────────────────────────────────
  renderCapitalTab() {
    const nav = this.navData || {};
    const userInvestor = nav.user || this.getUserInvestor();
    const investors = this.investorLedger || [];
    const snapshots = nav.snapshots || [];
    const reconciliation = this.reconciliation || {};
    const checks = reconciliation.checks || {};
    const totalUnits = Number(nav.totalUnits || reconciliation.totalUnitsByTransactions || 0);

    return `
      <div class="capital-section">
        <div class="capital-actions">
          <button class="btn-primary" onclick="Funds.showDepositModal()">+ Deposit</button>
          <button class="btn-secondary" onclick="Funds.showWithdrawModal()">Withdraw</button>
        </div>

        <div class="capital-summary capital-summary-grid">
          <div class="overview-card">
            <div class="card-label">Fund NAV</div>
            <div class="card-value">${Utils.money(nav.nav || 0)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">NAV / Unit</div>
            <div class="card-value">${Utils.money(nav.navPerUnit || 1, 4)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Your Units</div>
            <div class="card-value">${Utils.num(userInvestor.units || 0, 4)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Your Ownership</div>
            <div class="card-value">${Utils.num(userInvestor.ownershipPct || 0, 2)}%</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Your Investor Value</div>
            <div class="card-value">${Utils.money(userInvestor.value || 0)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Your Net Capital</div>
            <div class="card-value">${Utils.money(userInvestor.netCapital || 0)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Your Unrealized P&L</div>
            <div class="card-value ${Utils.colorClass(userInvestor.pnl || 0)}">${Utils.money(userInvestor.pnl || 0)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Fund Units Outstanding</div>
            <div class="card-value">${Utils.num(nav.totalUnits || 0, 4)}</div>
          </div>
        </div>

        ${reconciliation && Object.keys(reconciliation).length > 0 ? `
        <h3 style="margin-top:8px;margin-bottom:12px">Ledger Reconciliation</h3>
        <div class="capital-summary capital-summary-grid">
          <div class="overview-card">
            <div class="card-label">NAV Formula Check</div>
            <div class="card-value ${checks.isNavBalanced ? 'price-up' : 'price-down'}">${checks.isNavBalanced ? 'PASS' : 'FAIL'}</div>
            <div class="card-subtitle">${Utils.num(checks.navResidual || 0, 4)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Investor Ledger Check</div>
            <div class="card-value ${checks.isInvestorLedgerBalanced ? 'price-up' : 'price-down'}">${checks.isInvestorLedgerBalanced ? 'PASS' : 'FAIL'}</div>
            <div class="card-subtitle">${Utils.num(checks.investorResidual || 0, 4)}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Units x NAV Check</div>
            <div class="card-value ${checks.isUnitsBalanced ? 'price-up' : 'price-down'}">${checks.isUnitsBalanced ? 'PASS' : 'FAIL'}</div>
            <div class="card-subtitle">${Utils.num(checks.unitsResidual || 0, 4)}</div>
          </div>
        </div>
        ` : ''}

        <h3 style="margin-top:8px;margin-bottom:12px">Investor Ledger</h3>
        ${investors.length === 0 ? `
        <div class="empty-state">
          <span class="empty-icon">📘</span>
          <span class="empty-text">No investor units yet</span>
        </div>
        ` : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Investor</th>
              <th>Units</th>
              <th>Ownership %</th>
              <th>Net Capital</th>
              <th>Value</th>
              <th>P&L</th>
            </tr>
          </thead>
          <tbody>
            ${investors.map(inv => {
              const ownershipPct = totalUnits > 0
                ? (Number(inv.units || 0) / totalUnits) * 100
                : Number(inv.ownershipPct || 0);
              return `
            <tr>
              <td style="font-weight:600">${inv.username}</td>
              <td>${Utils.num(inv.units || 0, 4)}</td>
              <td>${Utils.num(ownershipPct, 2)}%</td>
              <td>${Utils.money(inv.netCapital || 0)}</td>
              <td>${Utils.money(inv.value || 0)}</td>
              <td class="${Utils.colorClass(inv.pnl || 0)}">${Utils.money(inv.pnl || 0)}</td>
            </tr>
            `;
            }).join('')}
          </tbody>
        </table>
        `}

        <h3 style="margin-top:24px;margin-bottom:12px">NAV Snapshots</h3>
        ${snapshots.length === 0 ? `
        <div class="empty-state">
          <span class="empty-icon">📉</span>
          <span class="empty-text">No NAV snapshots yet</span>
        </div>
        ` : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>NAV</th>
              <th>NAV / Unit</th>
              <th>Capital</th>
              <th>P&L</th>
            </tr>
          </thead>
          <tbody>
            ${snapshots.slice(-12).reverse().map(s => `
            <tr>
              <td>${Utils.formatDate(s.snapshotAt)}</td>
              <td>${Utils.money(s.nav || 0)}</td>
              <td>${Utils.money(s.navPerUnit || 1, 4)}</td>
              <td>${Utils.money(s.capital || 0)}</td>
              <td class="${Utils.colorClass(s.pnl || 0)}">${Utils.money(s.pnl || 0)}</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
        `}

        ${this.capitalTransactions.length === 0 ? `
        <div class="empty-state">
          <span class="empty-icon">💰</span>
          <span class="empty-text">No capital transactions yet</span>
        </div>
        ` : `
        <h3 style="margin-top:24px;margin-bottom:12px">Transaction History</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Units Δ</th>
              <th>NAV / Unit</th>
              <th>User</th>
            </tr>
          </thead>
          <tbody>
            ${this.capitalTransactions.map(t => `
            <tr>
              <td>${Utils.formatDate(t.created_at)}</td>
              <td class="${t.type === 'deposit' ? 'price-up' : 'price-down'}">${t.type.toUpperCase()}</td>
              <td class="mono">${Utils.money(t.amount)}</td>
              <td class="${(t.units_delta || 0) >= 0 ? 'price-up' : 'price-down'}">${Utils.num(t.units_delta || 0, 4)}</td>
              <td class="mono">${Utils.money(t.nav_per_unit || 1, 4)}</td>
              <td>${t.username}</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
        `}
      </div>
    `;
  },

  getUserCapital() {
    // Calculate user's net capital in the fund
    const userTxns = this.capitalTransactions.filter(t => t.user_id === App.user.id);
    let total = 0;
    for (const t of userTxns) {
      total += t.type === 'deposit' ? t.amount : -t.amount;
    }
    return total;
  },

  getUserInvestor() {
    const userId = App.user?.id;
    if (!userId) {
      return { units: 0, netCapital: 0, value: 0, ownershipPct: 0, pnl: 0 };
    }
    const investor = (this.investorLedger || []).find(i => i.user_id === userId);
    if (!investor) {
      return { units: 0, netCapital: this.getUserCapital(), value: 0, ownershipPct: 0, pnl: 0 };
    }
    return investor;
  },

  // ─── Risk Tab ────────────────────────────────────────────────────────────────
  renderRiskTab() {
    const fund = this.currentFund;
    const isOwner = fund?.role === 'owner';
    const settings = this.riskSettings || {
      max_position_pct: 25,
      max_strategy_allocation_pct: 50,
      max_daily_drawdown_pct: 8,
      is_enabled: true
    };
    const u = this.riskUtilization || {};
    const breaches = this.riskBreaches || [];

    return `
      <div class="risk-section">
        <div class="risk-overview-grid">
          <div class="overview-card">
            <div class="card-label">Risk Engine</div>
            <div class="card-value ${settings.is_enabled ? 'price-up' : 'text-muted'}">${settings.is_enabled ? 'Enabled' : 'Disabled'}</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Daily Drawdown</div>
            <div class="card-value ${Utils.colorClass(-(u.dailyDrawdownPct || 0))}">${(u.dailyDrawdownPct || 0).toFixed(2)}%</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Gross Exposure</div>
            <div class="card-value">${(u.grossExposurePct || 0).toFixed(2)}%</div>
          </div>
          <div class="overview-card">
            <div class="card-label">Fund Capital</div>
            <div class="card-value">${Utils.money(u.capital || 0)}</div>
          </div>
        </div>

        <div class="risk-limit-grid">
          <div class="overview-card">
            <div class="card-label">Max Position %</div>
            ${isOwner ? `<input type="number" id="risk-max-position-pct" min="1" max="100" step="0.1" value="${settings.max_position_pct}">` : `<div class="card-value">${settings.max_position_pct.toFixed(2)}%</div>`}
          </div>
          <div class="overview-card">
            <div class="card-label">Max Strategy Allocation %</div>
            ${isOwner ? `<input type="number" id="risk-max-strategy-pct" min="1" max="100" step="0.1" value="${settings.max_strategy_allocation_pct}">` : `<div class="card-value">${settings.max_strategy_allocation_pct.toFixed(2)}%</div>`}
          </div>
          <div class="overview-card">
            <div class="card-label">Max Daily Drawdown %</div>
            ${isOwner ? `<input type="number" id="risk-max-drawdown-pct" min="0.1" max="100" step="0.1" value="${settings.max_daily_drawdown_pct}">` : `<div class="card-value">${settings.max_daily_drawdown_pct.toFixed(2)}%</div>`}
          </div>
          <div class="overview-card">
            <div class="card-label">Status</div>
            ${isOwner ? `
              <label class="risk-toggle">
                <input type="checkbox" id="risk-enabled" ${settings.is_enabled ? 'checked' : ''}>
                <span>${settings.is_enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            ` : `<div class="card-value">${settings.is_enabled ? 'Enabled' : 'Disabled'}</div>`}
          </div>
        </div>

        ${isOwner ? `
          <div class="risk-actions">
            <button class="btn-primary" onclick="Funds.saveRiskSettings()">Save Risk Settings</button>
          </div>
        ` : ''}

        <h3 style="margin-top:16px;margin-bottom:10px">Top Exposures by Ticker</h3>
        ${u.byTicker && u.byTicker.length ? `
          <table class="data-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Exposure</th>
                <th>Exposure % of Capital</th>
              </tr>
            </thead>
            <tbody>
              ${u.byTicker.map(row => `
                <tr>
                  <td style="font-weight:700">${row.ticker}</td>
                  <td>${Utils.money(row.exposure)}</td>
                  <td>${row.exposurePct.toFixed(2)}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : `
          <div class="empty-state" style="padding:20px">
            <span class="empty-icon">🧮</span>
            <span class="empty-text">No open strategy exposure yet.</span>
          </div>
        `}

        <h3 style="margin-top:20px;margin-bottom:10px">Risk Breach History</h3>
        ${breaches.length ? `
          <table class="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Rule</th>
                <th>Message</th>
                <th>Trade</th>
              </tr>
            </thead>
            <tbody>
              ${breaches.map(b => this.renderRiskBreachRow(b)).join('')}
            </tbody>
          </table>
        ` : `
          <div class="empty-state" style="padding:20px">
            <span class="empty-icon">✅</span>
            <span class="empty-text">No risk breaches recorded.</span>
          </div>
        `}
      </div>
    `;
  },

  renderRiskBreachRow(breach) {
    let blockedTrade = breach.blocked_trade || {};
    if (typeof blockedTrade === 'string') {
      try {
        blockedTrade = JSON.parse(blockedTrade || '{}');
      } catch {
        blockedTrade = {};
      }
    }
    const tradeLabel = blockedTrade.ticker
      ? `${String(blockedTrade.side || '').toUpperCase()} ${blockedTrade.quantity || 0} ${blockedTrade.ticker} @ ${Utils.num(blockedTrade.price || 0)}`
      : '—';
    return `
      <tr>
        <td>${Utils.formatDate(breach.created_at)}</td>
        <td style="font-weight:700">${breach.rule}</td>
        <td>${breach.message}</td>
        <td>${tradeLabel}</td>
      </tr>
    `;
  },

  async saveRiskSettings() {
    const fundId = this.currentFund?.id;
    if (!fundId) return;

    const payload = {
      max_position_pct: parseFloat(document.getElementById('risk-max-position-pct')?.value),
      max_strategy_allocation_pct: parseFloat(document.getElementById('risk-max-strategy-pct')?.value),
      max_daily_drawdown_pct: parseFloat(document.getElementById('risk-max-drawdown-pct')?.value),
      is_enabled: document.getElementById('risk-enabled')?.checked ?? true
    };

    try {
      const result = await Utils.put('/funds/' + fundId + '/risk', payload);
      this.riskSettings = result.settings;
      this.riskUtilization = result.utilization;
      Utils.showToast('info', 'Risk Updated', 'Fund risk settings saved');
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Risk Update Failed', e.message);
    }
  },

  // ─── Strategies Tab ──────────────────────────────────────────────────────────
  renderStrategiesTab() {
    const canManage = this.currentFund.role === 'owner' || this.currentFund.role === 'analyst';
    const allStrategies = [...this.strategies, ...this.customStrategies];

    return `
      <div class="strategies-section">
        ${canManage ? `
        <div class="section-actions">
          <button class="btn-primary" onclick="Funds.showCreateStrategyModal()">+ Create Strategy</button>
        </div>
        ` : ''}

        ${allStrategies.length === 0 ? `
        <div class="empty-state">
          <span class="empty-icon">📈</span>
          <span class="empty-text">No strategies configured</span>
        </div>
        ` : `
        <div class="strategies-grid">
          ${this.strategies.map(s => this.renderStrategyCard(s, false)).join('')}
          ${this.customStrategies.map(s => this.renderStrategyCard(s, true)).join('')}
        </div>
        `}
      </div>
    `;
  },

  renderStrategyCard(strategy, isCustom) {
    const typeInfo = this.STRATEGY_TYPES[strategy.type] || { name: strategy.type, icon: '📈' };
    const statusClass = strategy.is_active ? 'status-active' : 'status-stopped';
    const statusText = strategy.is_active ? 'Active' : 'Stopped';
    const latestBacktest = !isCustom ? strategy.latest_backtest : null;
    const backtestBadge = !isCustom
      ? this.renderBacktestBadge(latestBacktest)
      : '';
    const backtestSummary = (!isCustom && latestBacktest?.metrics)
      ? `<span>BT: ${latestBacktest.passed ? 'PASS' : 'FAIL'} · Trades ${latestBacktest.metrics.totalTrades || 0} · Win ${Utils.num(latestBacktest.metrics.winRate || 0, 1)}% · DD ${Utils.num(latestBacktest.metrics.maxDrawdownPct || 0, 1)}%</span>`
      : (!isCustom ? '<span>BT: Not run</span>' : '');

    return `
      <div class="strategy-card ${strategy.is_active ? '' : 'inactive'}">
        <div class="strategy-card-header">
          <span class="strategy-icon">${typeInfo.icon}</span>
          <span class="strategy-name">${strategy.name}</span>
          <span class="strategy-status ${statusClass}">${statusText}</span>
        </div>
        <div class="strategy-type">${isCustom ? 'Custom Code' : typeInfo.name}</div>
        <div class="strategy-meta">
          <span>Created: ${Utils.formatDate(strategy.created_at)}</span>
          ${backtestSummary}
        </div>
        ${backtestBadge}
        <div class="strategy-actions">
          ${strategy.is_active ? `
          <button class="action-btn" onclick="Funds.stopStrategy('${strategy.id}', ${isCustom})">Stop</button>
          ` : `
          <button class="action-btn success" onclick="Funds.startStrategy('${strategy.id}', ${isCustom})">Start</button>
          `}
          ${!isCustom ? `
          <button class="action-btn" onclick="Funds.backtestStrategy('${strategy.id}')">Backtest</button>
          ` : ''}
          ${isCustom ? `
          <button class="action-btn" onclick="Funds.viewCustomStrategy('${strategy.id}')">View Code</button>
          ` : ''}
          <button class="action-btn" onclick="Funds.showEditStrategyModal('${strategy.id}', ${isCustom})">Edit</button>
          <button class="action-btn danger" onclick="Funds.deleteStrategy('${strategy.id}', ${isCustom})">Delete</button>
        </div>
      </div>
    `;
  },

  renderBacktestBadge(backtest) {
    if (!backtest) {
      return `<div class="strategy-backtest-badge backtest-missing">Backtest required</div>`;
    }
    const cls = backtest.passed ? 'backtest-pass' : 'backtest-fail';
    const label = backtest.passed ? 'Backtest PASS' : 'Backtest FAIL';
    const ranAt = backtest.ran_at ? Utils.timeAgo(backtest.ran_at) : 'unknown';
    return `<div class="strategy-backtest-badge ${cls}">${label} · ${ranAt}</div>`;
  },

  // ─── Data Loading ────────────────────────────────────────────────────────────
  async loadMyFunds() {
    try {
      this.myFunds = await Utils.get('/funds/my');
    } catch (e) {
      console.error('Failed to load funds:', e);
      this.myFunds = [];
    }
  },

  async loadFundDetails(fundId) {
    try {
      const [fund, members, strategies, customStrategies, capital, navData, investors, riskData, reconciliation] = await Promise.all([
        Utils.get('/funds/' + fundId),
        Utils.get('/funds/' + fundId + '/members'),
        Utils.get('/funds/' + fundId + '/strategies'),
        Utils.get('/funds/' + fundId + '/custom-strategies'),
        Utils.get('/funds/' + fundId + '/capital'),
        Utils.get('/funds/' + fundId + '/nav').catch(() => null),
        Utils.get('/funds/' + fundId + '/investors').catch(() => ({ investors: [] })),
        Utils.get('/funds/' + fundId + '/risk').catch(() => null),
        Utils.get('/funds/' + fundId + '/reconciliation').catch(() => null),
      ]);

      // Get role from myFunds
      const myFund = this.myFunds.find(f => f.id === fundId);
      this.currentFund = { ...fund, role: myFund?.role || 'client' };
      this.members = members;
      this.strategies = strategies;
      this.customStrategies = customStrategies;
      this.capitalTransactions = capital;
      this.navData = navData;
      this.investorLedger = investors?.investors || [];
      this.reconciliation = reconciliation;
      this.riskSettings = riskData?.settings || null;
      this.riskUtilization = riskData?.utilization || null;
      this.riskBreaches = riskData?.breaches || [];
    } catch (e) {
      console.error('Failed to load fund details:', e);
      Utils.showToast('error', 'Load Failed', e.message);
    }
  },

  // ─── Navigation ──────────────────────────────────────────────────────────────
  async viewFund(fundId) {
    const myFund = this.myFunds.find(f => f.id === fundId);
    if (!myFund || !this.isManagerRole(myFund.role)) {
      Utils.showToast('error', 'Access Denied', 'Only analysts and owners can open fund management.');
      window.location.hash = '#/client-portal';
      return;
    }
    await this.loadFundDetails(fundId);
    this.currentTab = 'overview';
    this.updateContent();
  },

  backToList() {
    this.currentFund = null;
    this.members = [];
    this.strategies = [];
    this.customStrategies = [];
    this.capitalTransactions = [];
    this.navData = null;
    this.investorLedger = [];
    this.reconciliation = null;
    this.riskSettings = null;
    this.riskUtilization = null;
    this.riskBreaches = [];
    this.updateContent();
  },

  switchTab(tab) {
    const isAnalyst = this.currentFund?.role === 'owner' || this.currentFund?.role === 'analyst';
    if (!isAnalyst && tab !== 'overview') {
      Utils.showToast('error', 'Access Denied', 'Analyst or owner access required.');
      this.currentTab = 'overview';
      this.updateContent();
      return;
    }

    // Clean up dashboard refresh if leaving dashboard
    if (this.currentTab === 'dashboard' && tab !== 'dashboard') {
      if (this.dashboardInterval) {
        clearInterval(this.dashboardInterval);
        this.dashboardInterval = null;
      }
    }
    this.currentTab = tab;
    if (tab === 'dashboard') {
      this.loadDashboard();
    }
    if (tab === 'capital') {
      this.loadCapitalData();
    }
    if (tab === 'risk') {
      this.loadRiskData();
    }
    this.updateContent();
  },

  async loadCapitalData() {
    const fundId = this.currentFund?.id;
    if (!fundId) return;
    try {
      const [capital, navData, investors, reconciliation] = await Promise.all([
        Utils.get('/funds/' + fundId + '/capital'),
        Utils.get('/funds/' + fundId + '/nav').catch(() => this.navData),
        Utils.get('/funds/' + fundId + '/investors').catch(() => ({ investors: this.investorLedger })),
        Utils.get('/funds/' + fundId + '/reconciliation').catch(() => this.reconciliation),
      ]);
      this.capitalTransactions = capital || this.capitalTransactions;
      this.navData = navData || this.navData;
      this.investorLedger = investors?.investors || this.investorLedger;
      this.reconciliation = reconciliation || this.reconciliation;
      if (this.currentTab === 'capital') {
        this.updateContent();
      }
    } catch (e) {
      // Keep existing data if refresh fails
    }
  },

  async loadRiskData() {
    const fundId = this.currentFund?.id;
    if (!fundId) return;
    try {
      const riskData = await Utils.get('/funds/' + fundId + '/risk');
      this.riskSettings = riskData?.settings || this.riskSettings;
      this.riskUtilization = riskData?.utilization || this.riskUtilization;
      this.riskBreaches = riskData?.breaches || this.riskBreaches;
      if (this.currentTab === 'risk') {
        this.updateContent();
      }
    } catch (e) {
      // Keep existing risk data if live refresh fails
    }
  },

  updateContent() {
    const container = document.querySelector('.funds-page');
    if (container) {
      container.innerHTML = this.renderContent();
      this.bindEvents();
    }
  },

  // ─── Create Fund Modal ───────────────────────────────────────────────────────
  showCreateFundModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'create-fund-modal';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>Create New Fund</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Fund Name</label>
            <input type="text" id="fund-name" placeholder="My Hedge Fund">
          </div>
          <div class="form-group">
            <label>Strategy Type</label>
            <select id="fund-strategy-type">
              ${Object.entries(this.STRATEGY_TYPES).map(([key, val]) => `
              <option value="${key}">${val.icon} ${val.name}</option>
              `).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Description (optional)</label>
            <textarea id="fund-description" placeholder="Describe your fund's investment strategy..."></textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Min Investment ($)</label>
              <input type="number" id="fund-min-investment" value="10000" min="0">
            </div>
            <div class="form-group">
              <label>Management Fee (%)</label>
              <input type="number" id="fund-management-fee" value="2" min="0" max="100" step="0.1">
            </div>
            <div class="form-group">
              <label>Performance Fee (%)</label>
              <input type="number" id="fund-performance-fee" value="20" min="0" max="100" step="0.1">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" onclick="Funds.createFund()">Create Fund</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async createFund() {
    const name = document.getElementById('fund-name')?.value?.trim();
    const strategyType = document.getElementById('fund-strategy-type')?.value;
    const description = document.getElementById('fund-description')?.value?.trim();
    const minInvestment = parseFloat(document.getElementById('fund-min-investment')?.value) || 0;
    const managementFee = (parseFloat(document.getElementById('fund-management-fee')?.value) || 0) / 100;
    const performanceFee = (parseFloat(document.getElementById('fund-performance-fee')?.value) || 0) / 100;

    if (!name) {
      Utils.showToast('error', 'Validation Error', 'Fund name is required');
      return;
    }

    try {
      const result = await Utils.post('/funds', {
        name,
        strategy_type: strategyType,
        description,
        min_investment: minInvestment,
        management_fee: managementFee,
        performance_fee: performanceFee
      });

      Utils.showToast('info', 'Fund Created', `"${name}" has been created`);
      document.getElementById('create-fund-modal')?.remove();
      await this.loadMyFunds();
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Create Failed', e.message);
    }
  },

  // ─── Edit Fund Modal ─────────────────────────────────────────────────────────
  showEditFundModal() {
    const fund = this.currentFund;
    if (!fund) return;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'edit-fund-modal';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>Edit Fund</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Fund Name</label>
            <input type="text" id="fund-name" value="${fund.name}">
          </div>
          <div class="form-group">
            <label>Strategy Type</label>
            <select id="fund-strategy-type">
              ${Object.entries(this.STRATEGY_TYPES).map(([key, val]) => `
              <option value="${key}" ${key === fund.strategy_type ? 'selected' : ''}>${val.icon} ${val.name}</option>
              `).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="fund-description">${fund.description || ''}</textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Min Investment ($)</label>
              <input type="number" id="fund-min-investment" value="${fund.min_investment}" min="0">
            </div>
            <div class="form-group">
              <label>Management Fee (%)</label>
              <input type="number" id="fund-management-fee" value="${(fund.management_fee * 100).toFixed(1)}" min="0" max="100" step="0.1">
            </div>
            <div class="form-group">
              <label>Performance Fee (%)</label>
              <input type="number" id="fund-performance-fee" value="${(fund.performance_fee * 100).toFixed(1)}" min="0" max="100" step="0.1">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary danger" onclick="Funds.deleteFund()">Delete Fund</button>
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" onclick="Funds.updateFund()">Save Changes</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async updateFund() {
    const fundId = this.currentFund?.id;
    if (!fundId) return;

    const name = document.getElementById('fund-name')?.value?.trim();
    const strategyType = document.getElementById('fund-strategy-type')?.value;
    const description = document.getElementById('fund-description')?.value?.trim();
    const minInvestment = parseFloat(document.getElementById('fund-min-investment')?.value) || 0;
    const managementFee = (parseFloat(document.getElementById('fund-management-fee')?.value) || 0) / 100;
    const performanceFee = (parseFloat(document.getElementById('fund-performance-fee')?.value) || 0) / 100;

    try {
      await Utils.put('/funds/' + fundId, {
        name,
        strategy_type: strategyType,
        description,
        min_investment: minInvestment,
        management_fee: managementFee,
        performance_fee: performanceFee
      });

      Utils.showToast('info', 'Fund Updated', 'Changes saved successfully');
      document.getElementById('edit-fund-modal')?.remove();
      await this.loadFundDetails(fundId);
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Update Failed', e.message);
    }
  },

  async deleteFund() {
    const fundId = this.currentFund?.id;
    const fundName = this.currentFund?.name;
    if (!fundId) return;

    if (!confirm(`Are you sure you want to delete "${fundName}"? This action cannot be undone.`)) {
      return;
    }

    try {
      await Utils.del('/funds/' + fundId);
      Utils.showToast('info', 'Fund Deleted', `"${fundName}" has been deleted`);
      document.getElementById('edit-fund-modal')?.remove();
      this.backToList();
      await this.loadMyFunds();
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Delete Failed', e.message);
    }
  },

  // ─── Add Member Modal ────────────────────────────────────────────────────────
  showAddMemberModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'add-member-modal';
    modal.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">
          <h2>Add Member</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="member-username" placeholder="Enter username">
          </div>
          <div class="form-group">
            <label>Role</label>
            <select id="member-role">
              <option value="analyst">Analyst</option>
              <option value="client">Client</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" onclick="Funds.addMember()">Add Member</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async addMember() {
    const fundId = this.currentFund?.id;
    const username = document.getElementById('member-username')?.value?.trim();
    const role = document.getElementById('member-role')?.value;

    if (!username) {
      Utils.showToast('error', 'Validation Error', 'Username is required');
      return;
    }

    try {
      await Utils.post('/funds/' + fundId + '/members', { username, role });
      Utils.showToast('info', 'Member Added', 'New member has been added to the fund');
      document.getElementById('add-member-modal')?.remove();
      this.members = await Utils.get('/funds/' + fundId + '/members');
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Add Failed', e.message);
    }
  },

  showEditMemberModal(userId, currentRole) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'edit-member-modal';
    modal.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">
          <h2>Edit Member Role</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Role</label>
            <select id="member-role">
              <option value="analyst" ${currentRole === 'analyst' ? 'selected' : ''}>Analyst</option>
              <option value="client" ${currentRole === 'client' ? 'selected' : ''}>Client</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" onclick="Funds.updateMember('${userId}')">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async updateMember(userId) {
    const fundId = this.currentFund?.id;
    const role = document.getElementById('member-role')?.value;

    try {
      await Utils.put('/funds/' + fundId + '/members/' + userId, { role });
      Utils.showToast('info', 'Member Updated', 'Role has been updated');
      document.getElementById('edit-member-modal')?.remove();
      this.members = await Utils.get('/funds/' + fundId + '/members');
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Update Failed', e.message);
    }
  },

  async removeMember(userId) {
    const fundId = this.currentFund?.id;
    if (!confirm('Are you sure you want to remove this member from the fund?')) return;

    try {
      await Utils.del('/funds/' + fundId + '/members/' + userId);
      Utils.showToast('info', 'Member Removed', 'Member has been removed from the fund');
      this.members = await Utils.get('/funds/' + fundId + '/members');
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Remove Failed', e.message);
    }
  },

  // ─── Deposit/Withdraw Modals ─────────────────────────────────────────────────
  showDepositModal() {
    const userCash = Utils.toNumber(App.user?.cash, 0);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'deposit-modal';
    modal.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">
          <h2>Deposit Capital</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Available Cash</label>
            <div class="form-value">${Utils.money(userCash)}</div>
          </div>
          <div class="form-group">
            <label>Amount to Deposit</label>
            <input type="number" id="deposit-amount" placeholder="0.00" min="0" max="${userCash}" step="0.01">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" onclick="Funds.depositCapital()">Deposit</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async depositCapital() {
    const fundId = this.currentFund?.id;
    const amount = parseFloat(document.getElementById('deposit-amount')?.value);
    const availableCash = Utils.toNumber(App.user?.cash, 0);

    if (!fundId) return;

    if (!amount || amount <= 0) {
      Utils.showToast('error', 'Invalid Amount', 'Please enter a valid amount');
      return;
    }
    if (amount > availableCash) {
      Utils.showToast('error', 'Insufficient Cash', `You only have ${Utils.money(availableCash)} available`);
      return;
    }

    try {
      await Utils.post('/funds/' + fundId + '/capital', { amount, type: 'deposit' });
      Utils.showToast('info', 'Deposit Successful', `${Utils.money(amount)} has been deposited`);
      document.getElementById('deposit-modal')?.remove();

      // Refresh data
      const [capital, user, navData, investors, reconciliation] = await Promise.all([
        Utils.get('/funds/' + fundId + '/capital'),
        Utils.get('/me'),
        Utils.get('/funds/' + fundId + '/nav').catch(() => this.navData),
        Utils.get('/funds/' + fundId + '/investors').catch(() => ({ investors: this.investorLedger })),
        Utils.get('/funds/' + fundId + '/reconciliation').catch(() => this.reconciliation),
      ]);
      this.capitalTransactions = capital;
      App.user = user;
      this.navData = navData || this.navData;
      this.investorLedger = investors?.investors || this.investorLedger;
      this.reconciliation = reconciliation || this.reconciliation;
      Utils.syncHeaderBalance(user.cash);
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Deposit Failed', e.message);
    }
  },

  showWithdrawModal() {
    const userInvestor = this.navData?.user || this.getUserInvestor();
    const withdrawable = Utils.toNumber(userInvestor.value, 0);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'withdraw-modal';
    modal.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">
          <h2>Withdraw Capital</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Your Investor Value</label>
            <div class="form-value">${Utils.money(withdrawable)}</div>
          </div>
          <div class="form-group">
            <label>Amount to Withdraw</label>
            <input type="number" id="withdraw-amount" placeholder="0.00" min="0" max="${withdrawable}" step="0.01">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" onclick="Funds.withdrawCapital()">Withdraw</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async withdrawCapital() {
    const fundId = this.currentFund?.id;
    const amount = parseFloat(document.getElementById('withdraw-amount')?.value);
    const userInvestor = this.navData?.user || this.getUserInvestor();
    const availableCapital = Utils.toNumber(userInvestor.value, 0);

    if (!fundId) return;

    if (!amount || amount <= 0) {
      Utils.showToast('error', 'Invalid Amount', 'Please enter a valid amount');
      return;
    }
    if (amount > availableCapital) {
      Utils.showToast('error', 'Insufficient Capital', `You only have ${Utils.money(availableCapital)} in this fund`);
      return;
    }

    try {
      await Utils.post('/funds/' + fundId + '/capital', { amount, type: 'withdrawal' });
      Utils.showToast('info', 'Withdrawal Successful', `${Utils.money(amount)} has been withdrawn`);
      document.getElementById('withdraw-modal')?.remove();

      // Refresh data
      const [capital, user, navData, investors, reconciliation] = await Promise.all([
        Utils.get('/funds/' + fundId + '/capital'),
        Utils.get('/me'),
        Utils.get('/funds/' + fundId + '/nav').catch(() => this.navData),
        Utils.get('/funds/' + fundId + '/investors').catch(() => ({ investors: this.investorLedger })),
        Utils.get('/funds/' + fundId + '/reconciliation').catch(() => this.reconciliation),
      ]);
      this.capitalTransactions = capital;
      App.user = user;
      this.navData = navData || this.navData;
      this.investorLedger = investors?.investors || this.investorLedger;
      this.reconciliation = reconciliation || this.reconciliation;
      Utils.syncHeaderBalance(user.cash);
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Withdrawal Failed', e.message);
    }
  },

  // ─── Strategy Management ─────────────────────────────────────────────────────
  showCreateStrategyModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'create-strategy-modal';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>Create Strategy</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="strategy-type-selector">
            <label>Choose Strategy Type</label>
            <div class="strategy-type-grid">
              ${Object.entries(this.STRATEGY_TYPES).map(([key, val]) => `
              <div class="strategy-type-option" data-type="${key}" onclick="Funds.selectStrategyType('${key}')">
                <span class="strategy-icon">${val.icon}</span>
                <span class="strategy-name">${val.name}</span>
                <span class="strategy-desc">${val.desc}</span>
              </div>
              `).join('')}
            </div>
          </div>

          <div id="strategy-config-section" style="display:none;margin-top:20px">
            <div class="form-group">
              <label>Strategy Name</label>
              <input type="text" id="strategy-name" placeholder="My Strategy">
            </div>

            <div id="prebuilt-config">
              <div class="form-group">
                <label>Target Ticker</label>
                <select id="strategy-ticker">${this.tickerOptionsHtml()}</select>
              </div>
              <div class="form-group" id="pairs-ticker-group" style="display:none">
                <label>Pair Ticker</label>
                <select id="strategy-ticker2">${this.tickerOptionsHtml('MSFT')}</select>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>Allocation % of Fund NAV</label>
                  <input type="number" id="strategy-allocation-pct" value="10" min="0.1" step="0.1">
                  <small class="form-hint">No max cap. Quantity is price-aware: qty = (NAV x %)/price</small>
                </div>
                <div class="form-group">
                  <label>Fixed Notional USD (Optional)</label>
                  <input type="number" id="strategy-fixed-notional" placeholder="Leave blank to use allocation % (e.g. 10000)" min="0" step="1">
                </div>
              </div>
            </div>

            <div id="custom-code-section" style="display:none">
              <div class="form-row">
                <div class="form-group">
                  <label>Template</label>
                  <select id="custom-template-select">${this.customTemplateOptionsHtml()}</select>
                </div>
                <div class="form-group" style="align-self:end">
                  <button type="button" class="btn-secondary" onclick="Funds.applyCustomTemplate()">Load Template</button>
                </div>
              </div>
              <div class="form-group">
                <label>Strategy Code (JavaScript)</label>
                <textarea id="strategy-code" rows="10" placeholder="// function run(context) {
//   const { prices, ticker } = context;
//   const aapl = ticker('AAPL');
//   return { action: 'buy', ticker: 'AAPL', qty: 10 };
// }"></textarea>
                <small class="form-hint">Available: prices, ticker(symbol), getPrice(symbol), state (persistent), parameters, log()</small>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" id="create-strategy-btn" style="display:none" onclick="Funds.createStrategy()">Create Strategy</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.selectedStrategyType = null;
  },

  selectStrategyType(type) {
    this.selectedStrategyType = type;

    // Update UI
    document.querySelectorAll('.strategy-type-option').forEach(el => {
      el.classList.toggle('selected', el.dataset.type === type);
    });

    document.getElementById('strategy-config-section').style.display = '';
    document.getElementById('create-strategy-btn').style.display = '';

    const isCustom = type === 'custom';
    const isPairs = type === 'pairs';
    document.getElementById('prebuilt-config').style.display = isCustom ? 'none' : '';
    document.getElementById('custom-code-section').style.display = isCustom ? '' : 'none';
    document.getElementById('pairs-ticker-group').style.display = isPairs ? '' : 'none';
    if (isCustom) {
      this.applyCustomTemplate();
    }
  },

  customTemplateOptionsHtml() {
    return Object.entries(this.CUSTOM_STRATEGY_TEMPLATES)
      .map(([key, template]) => `<option value="${key}">${template.name}</option>`)
      .join('');
  },

  applyCustomTemplate() {
    const select = document.getElementById('custom-template-select');
    const textarea = document.getElementById('strategy-code');
    if (!select || !textarea) return;
    const template = this.CUSTOM_STRATEGY_TEMPLATES[select.value];
    if (!template) return;
    textarea.value = template.code;
  },

  async createStrategy() {
    const fundId = this.currentFund?.id;
    const name = document.getElementById('strategy-name')?.value?.trim();
    const type = this.selectedStrategyType;

    if (!name) {
      Utils.showToast('error', 'Validation Error', 'Strategy name is required');
      return;
    }

    if (!type) {
      Utils.showToast('error', 'Validation Error', 'Please select a strategy type');
      return;
    }

    try {
      if (type === 'custom') {
        const code = document.getElementById('strategy-code')?.value;
        if (!code) {
          Utils.showToast('error', 'Validation Error', 'Strategy code is required');
          return;
        }

        await Utils.post('/custom-strategies', {
          fund_id: fundId,
          name,
          code,
          parameters: {}
        });
      } else {
        const ticker = document.getElementById('strategy-ticker')?.value;
        const allocationPctRaw = parseFloat(document.getElementById('strategy-allocation-pct')?.value);
        const fixedNotionalRaw = parseFloat(document.getElementById('strategy-fixed-notional')?.value);

        const config = {
          ticker,
          allocationPct: Number.isFinite(allocationPctRaw) && allocationPctRaw > 0 ? allocationPctRaw : 10
        };
        if (Number.isFinite(fixedNotionalRaw) && fixedNotionalRaw > 0) {
          config.fixedNotionalUsd = fixedNotionalRaw;
        }

        if (type === 'pairs') {
          const ticker2 = document.getElementById('strategy-ticker2')?.value;
          if (ticker === ticker2) {
            Utils.showToast('error', 'Validation Error', 'Pair tickers must be different');
            return;
          }
          config.ticker2 = ticker2;
        }

        await Utils.post('/funds/' + fundId + '/strategies', {
          name,
          type,
          config
        });
      }

      Utils.showToast('info', 'Strategy Created', `"${name}" created. Run backtest, then start.`);
      document.getElementById('create-strategy-modal')?.remove();

      // Refresh strategies
      const [strategies, customStrategies] = await Promise.all([
        Utils.get('/funds/' + fundId + '/strategies'),
        Utils.get('/funds/' + fundId + '/custom-strategies')
      ]);
      this.strategies = strategies;
      this.customStrategies = customStrategies;
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Create Failed', e.message);
    }
  },

  showEditStrategyModal(strategyId, isCustom) {
    const strategy = isCustom
      ? this.customStrategies.find(s => s.id === strategyId)
      : this.strategies.find(s => s.id === strategyId);

    if (!strategy) return;

    const config = typeof strategy.config === 'string' ? JSON.parse(strategy.config) : (strategy.config || {});
    const isPairs = strategy.type === 'pairs';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'edit-strategy-modal';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>Edit Strategy</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Strategy Name</label>
            <input type="text" id="strategy-name" value="${strategy.name}">
          </div>
          ${isCustom ? `
          <div class="form-group">
            <label>Strategy Code</label>
            <textarea id="strategy-code" rows="10">${strategy.code || ''}</textarea>
          </div>
          ` : `
          <div class="form-group">
            <label>Target Ticker</label>
            <select id="strategy-ticker">
              ${this.tickerOptionsHtml(config.ticker || 'AAPL')}
            </select>
          </div>
          ${isPairs ? `
          <div class="form-group">
            <label>Pair Ticker</label>
            <select id="strategy-ticker2">${this.tickerOptionsHtml(config.ticker2 || 'MSFT')}</select>
          </div>
          ` : ''}
          <div class="form-row">
            <div class="form-group">
              <label>Allocation % of Fund NAV</label>
              <input type="number" id="strategy-allocation-pct" value="${(Number(config.allocationPct) > 0 ? Number(config.allocationPct) : 10)}" min="0.1" step="0.1">
            </div>
            <div class="form-group">
              <label>Fixed Notional USD (Optional)</label>
              <input type="number" id="strategy-fixed-notional" value="${Number(config.fixedNotionalUsd) > 0 ? Number(config.fixedNotionalUsd) : ''}" min="0" step="1">
            </div>
          </div>
          `}
          <div class="form-group">
            <label>
              <input type="checkbox" id="strategy-active" ${strategy.is_active ? 'checked' : ''}>
              Active
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn-primary" onclick="Funds.updateStrategy('${strategyId}', ${isCustom})">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async updateStrategy(strategyId, isCustom) {
    const fundId = this.currentFund?.id;
    const name = document.getElementById('strategy-name')?.value?.trim();
    const isActive = document.getElementById('strategy-active')?.checked;

    try {
      if (isCustom) {
        const code = document.getElementById('strategy-code')?.value;
        await Utils.put('/custom-strategies/' + strategyId, {
          name,
          code,
          is_active: isActive
        });
      } else {
        const existing = this.strategies.find(s => s.id === strategyId);
        const existingConfig = existing
          ? (typeof existing.config === 'string' ? JSON.parse(existing.config || '{}') : (existing.config || {}))
          : {};
        const ticker = document.getElementById('strategy-ticker')?.value;
        const ticker2 = document.getElementById('strategy-ticker2')?.value;
        const allocationPctRaw = parseFloat(document.getElementById('strategy-allocation-pct')?.value);
        const fixedNotionalRaw = parseFloat(document.getElementById('strategy-fixed-notional')?.value);

        const nextConfig = {
          ...existingConfig,
          ticker,
          allocationPct: Number.isFinite(allocationPctRaw) && allocationPctRaw > 0 ? allocationPctRaw : 10
        };
        if (ticker2) {
          nextConfig.ticker2 = ticker2;
        }
        if (Number.isFinite(fixedNotionalRaw) && fixedNotionalRaw > 0) {
          nextConfig.fixedNotionalUsd = fixedNotionalRaw;
        } else {
          delete nextConfig.fixedNotionalUsd;
        }

        await Utils.put('/strategies/' + strategyId, {
          name,
          config: nextConfig
        });
      }

      Utils.showToast('info', 'Strategy Updated', 'Changes saved successfully');
      document.getElementById('edit-strategy-modal')?.remove();

      // Refresh
      const [strategies, customStrategies] = await Promise.all([
        Utils.get('/funds/' + fundId + '/strategies'),
        Utils.get('/funds/' + fundId + '/custom-strategies')
      ]);
      this.strategies = strategies;
      this.customStrategies = customStrategies;
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Update Failed', e.message);
    }
  },

  async startStrategy(strategyId, isCustom) {
    try {
      if (isCustom) {
        await Utils.put('/custom-strategies/' + strategyId, { is_active: true });
      } else {
        await Utils.post('/strategies/' + strategyId + '/start');
      }
      Utils.showToast('info', 'Strategy Started', 'Strategy is now active');

      await this.refreshStrategies();
    } catch (e) {
      Utils.showToast('error', 'Start Failed', e.message);
    }
  },

  async backtestStrategy(strategyId) {
    try {
      const result = await Utils.post('/strategies/' + strategyId + '/backtest', {});
      const bt = result?.backtest;
      const summary = bt?.metrics
        ? `Trades ${bt.metrics.totalTrades || 0}, Win ${Utils.num(bt.metrics.winRate || 0, 1)}%, DD ${Utils.num(bt.metrics.maxDrawdownPct || 0, 1)}%, Sharpe ${Utils.num(bt.metrics.sharpe || 0, 2)}`
        : 'Backtest completed';
      Utils.showToast(
        bt?.passed ? 'info' : 'error',
        bt?.passed ? 'Backtest Passed' : 'Backtest Failed',
        summary
      );
      await this.refreshStrategies();
    } catch (e) {
      Utils.showToast('error', 'Backtest Failed', e.message);
    }
  },

  async stopStrategy(strategyId, isCustom) {
    try {
      if (isCustom) {
        await Utils.put('/custom-strategies/' + strategyId, { is_active: false });
      } else {
        await Utils.post('/strategies/' + strategyId + '/stop');
      }
      Utils.showToast('info', 'Strategy Stopped', 'Strategy has been stopped');

      await this.refreshStrategies();
    } catch (e) {
      Utils.showToast('error', 'Stop Failed', e.message);
    }
  },

  async deleteStrategy(strategyId, isCustom) {
    if (!confirm('Are you sure you want to delete this strategy?')) return;

    try {
      if (isCustom) {
        await Utils.del('/custom-strategies/' + strategyId);
      } else {
        await Utils.del('/strategies/' + strategyId);
      }
      Utils.showToast('info', 'Strategy Deleted', 'Strategy has been removed');

      await this.refreshStrategies();
    } catch (e) {
      Utils.showToast('error', 'Delete Failed', e.message);
    }
  },

  viewCustomStrategy(strategyId) {
    const strategy = this.customStrategies.find(s => s.id === strategyId);
    if (!strategy) return;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'view-strategy-modal';
    modal.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-header">
          <h2>${strategy.name} - Code</h2>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          <pre class="code-preview"><code>${this.escapeHtml(strategy.code || '')}</code></pre>
        </div>
        <div class="modal-footer">
          <button class="btn-primary" onclick="Funds.testStrategy('${strategyId}')">Test Run</button>
          <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  },

  async testStrategy(strategyId) {
    try {
      const result = await Utils.post('/custom-strategies/' + strategyId + '/test', { test_data: {} });
      Utils.showToast('info', 'Test Complete', 'Check console for results');
      console.log('Strategy test result:', result);
    } catch (e) {
      Utils.showToast('error', 'Test Failed', e.message);
    }
  },

  async refreshStrategies() {
    const fundId = this.currentFund?.id;
    const [strategies, customStrategies] = await Promise.all([
      Utils.get('/funds/' + fundId + '/strategies'),
      Utils.get('/funds/' + fundId + '/custom-strategies')
    ]);
    this.strategies = strategies;
    this.customStrategies = customStrategies;
    this.updateContent();
  },

  // ─── Event Binding ───────────────────────────────────────────────────────────
  bindEvents() {
    // Tab clicks
    document.querySelectorAll('.fund-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchTab(tab.dataset.tab);
      });
    });
  },

  // ─── Utilities ───────────────────────────────────────────────────────────────
  escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  async deleteFund() {
    if (!this.currentFund) return;
    const fundName = this.currentFund.name;
    if (!confirm(`Are you sure you want to permanently delete "${fundName}"? This cannot be undone.`)) return;

    try {
      await Utils.del('/funds/' + this.currentFund.id);
      Utils.showToast('info', 'Fund Deleted', `"${fundName}" has been deleted`);
      this.backToList();
      await this.loadMyFunds();
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Delete Failed', e.message);
    }
  },

  tickerOptionsHtml(selected = 'AAPL') {
    const tickers = {
      'Stocks — Large Cap': [
        ['AAPL', 'Apricot Corp'], ['MSFT', 'MegaSoft'], ['NVDA', 'NeuraVolt'],
        ['AMZN', 'AmazoNet'], ['GOOG', 'GooglTech'], ['META', 'MetaVerse Inc'], ['TSLA', 'VoltMotors']
      ],
      'Stocks — Growth / Speculative': [
        ['MOON', 'LunarTech'], ['BIOT', 'BioTera'], ['QNTM', 'QuantumLeap']
      ],
      'Commodities': [
        ['OGLD', 'OmniGold'], ['SLVR', 'SilverEdge'], ['CRUD', 'CrudeFlow'],
        ['NATG', 'NatGas Plus'], ['COPR', 'CopperLine']
      ],
      'Futures / Indices': [
        ['SPXF', 'S&P Futures'], ['NQFT', 'NQ Futures'], ['DOWF', 'Dow Futures'], ['VIXF', 'Fear Index']
      ],
      'ETFs': [
        ['SAFE', 'Treasury ETF'], ['BNKX', 'BankEx ETF'], ['NRGY', 'Energy ETF'],
        ['MEDS', 'HealthCare ETF'], ['SEMX', 'SemiConductor ETF'], ['REIT', 'RealtyFund ETF']
      ],
      'Crypto': [
        ['BTCX', 'Bitcoin Index'], ['ETHX', 'Ethereum Index'], ['SOLX', 'Solana Index']
      ],
      'Forex': [
        ['EURUSD', 'Euro/Dollar'], ['GBPUSD', 'Pound/Dollar'], ['USDJPY', 'Dollar/Yen']
      ]
    };
    let html = '';
    for (const [group, items] of Object.entries(tickers)) {
      html += `<optgroup label="${group}">`;
      for (const [sym, name] of items) {
        html += `<option value="${sym}"${sym === selected ? ' selected' : ''}>${sym} — ${name}</option>`;
      }
      html += '</optgroup>';
    }
    return html;
  },

  // ─── Dashboard (Bloomberg Terminal) ────────────────────────────────────────
  async loadDashboard() {
    if (!this.currentFund) return;
    try {
      this.dashboardData = await Utils.get('/funds/' + this.currentFund.id + '/dashboard');
    } catch (e) {
      this.dashboardData = null;
    }
    // Only re-render the dashboard content area to avoid full page refresh
    const el = document.getElementById('bloomberg-dashboard');
    if (el) {
      el.innerHTML = this.renderDashboardInner();
    }
    // Set up auto-refresh
    if (!this.dashboardInterval) {
      this.dashboardInterval = setInterval(() => this.loadDashboard(), 10000);
    }
  },

  renderDashboardTab() {
    return `
      <div id="bloomberg-dashboard" class="bloomberg-dashboard">
        ${this.dashboardData ? this.renderDashboardInner() : `
          <div class="bb-loading">
            <div class="bb-loading-spinner"></div>
            <div>LOADING TERMINAL DATA...</div>
          </div>
        `}
      </div>
    `;
  },

  renderDashboardInner() {
    const d = this.dashboardData;
    if (!d) return '<div class="bb-loading">No data available</div>';

    const s = d.summary;
    const closedTrades = Number(s.closedTrades ?? s.totalTrades ?? 0);
    const totalFills = Number(s.totalFills ?? s.totalTrades ?? 0);
    const nonClosingFills = Number(s.nonClosingFills ?? Math.max(0, totalFills - closedTrades));
    const pnlClass = s.totalPnl >= 0 ? 'bb-green' : 'bb-red';
    const grossPnl = Number(s.gross_pnl ?? s.grossPnl ?? (s.totalPnl || 0));
    const netPnl = Number(s.net_pnl ?? s.netPnl ?? (s.totalPnl || 0));
    const totalSlippageCost = Number(s.total_slippage_cost ?? s.totalSlippageCost ?? 0);
    const totalCommission = Number(s.total_commission ?? s.totalCommission ?? 0);
    const totalBorrowCost = Number(s.total_borrow_cost ?? s.totalBorrowCost ?? 0);
    const executionDragPct = Number(s.cost_drag_pct ?? s.executionDragPct ?? 0);
    const grossClass = grossPnl >= 0 ? 'bb-green' : 'bb-red';
    const netClass = netPnl >= 0 ? 'bb-green' : 'bb-red';
    const realClass = s.realizedPnl >= 0 ? 'bb-green' : 'bb-red';
    const unrealClass = s.unrealizedPnl >= 0 ? 'bb-green' : 'bb-red';

    return `
      <div class="bb-header">
        <div class="bb-header-left">
          <span class="bb-brand">STRATOS</span>
          <span class="bb-sep">|</span>
          <span class="bb-fund-name">${this.currentFund.name}</span>
        </div>
        <div class="bb-header-right">
          <span class="bb-live-dot"></span> LIVE
          <span class="bb-sep">|</span>
          <span>${d.meta.isPaused ? '⏸ PAUSED' : '▶ RUNNING'}</span>
          <span class="bb-sep">|</span>
          <span>Every ${d.meta.runIntervalMs / 1000}s</span>
          <span class="bb-sep">|</span>
          <span>Runs: ${d.meta.totalRuns}</span>
        </div>
      </div>

      <!-- PnL Summary -->
      <div class="bb-panel-row">
        <div class="bb-panel bb-pnl-panel">
          <div class="bb-panel-title">P&L SUMMARY</div>
          <div class="bb-pnl-grid">
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">GROSS P&L</div>
              <div class="bb-pnl-value ${grossClass}">${this.bbMoney(grossPnl)}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">NET P&L</div>
              <div class="bb-pnl-value ${netClass}">${this.bbMoney(netPnl)}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">REALIZED</div>
              <div class="bb-pnl-value ${realClass}">${this.bbMoney(s.realizedPnl)}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">UNREALIZED</div>
              <div class="bb-pnl-value ${unrealClass}">${this.bbMoney(s.unrealizedPnl)}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">CLOSED</div>
              <div class="bb-pnl-value">${closedTrades}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">FILLS</div>
              <div class="bb-pnl-value">${totalFills}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">OPENING FILLS</div>
              <div class="bb-pnl-value">${nonClosingFills}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">SLIPPAGE</div>
              <div class="bb-pnl-value bb-red">${this.bbMoney(totalSlippageCost)}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">COMMISSION</div>
              <div class="bb-pnl-value bb-red">${this.bbMoney(totalCommission)}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">BORROW</div>
              <div class="bb-pnl-value bb-red">${this.bbMoney(totalBorrowCost)}</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">EXEC DRAG</div>
              <div class="bb-pnl-value ${executionDragPct <= 8 ? 'bb-green' : executionDragPct <= 15 ? 'bb-amber' : 'bb-red'}">${executionDragPct.toFixed(2)}%</div>
            </div>
            <div class="bb-pnl-item">
              <div class="bb-pnl-label">WIN RATE</div>
              <div class="bb-pnl-value ${s.winRate >= 50 ? 'bb-green' : s.winRate > 0 ? 'bb-amber' : ''}">${s.winRate}%</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Positions + Trades Row -->
      <div class="bb-panel-row bb-panel-row-2col">
        <div class="bb-panel">
          <div class="bb-panel-title">ACTIVE POSITIONS</div>
          ${this.renderBBPositions(d.positions)}
        </div>
        <div class="bb-panel">
          <div class="bb-panel-title">RECENT FILLS <span class="bb-badge">${d.trades.length}/${totalFills}</span></div>
          ${this.renderBBTrades(d.trades)}
        </div>
      </div>

      <!-- Strategy Performance + Activity Log -->
      <div class="bb-panel-row bb-panel-row-2col">
        <div class="bb-panel">
          <div class="bb-panel-title">STRATEGY PERFORMANCE</div>
          ${this.renderBBStrategyPerf(d.strategies)}
        </div>
        <div class="bb-panel">
          <div class="bb-panel-title">ACTIVITY LOG <span class="bb-badge">${d.signals.length}</span></div>
          ${this.renderBBSignals(d.signals)}
        </div>
      </div>
    `;
  },

  renderBBPositions(positions) {
    if (!positions || positions.length === 0) {
      return '<div class="bb-empty">No open positions</div>';
    }
    return `
      <div class="bb-table-wrap">
        <table class="bb-table">
          <thead>
            <tr><th>TICKER</th><th>SIDE</th><th>QTY</th><th>AVG ENTRY</th><th>CURRENT</th><th>UNREAL P&L</th><th>STRATEGY</th></tr>
          </thead>
          <tbody>
            ${positions.map(p => {
      const plClass = p.unrealizedPnl >= 0 ? 'bb-green' : 'bb-red';
      return `<tr>
                <td class="bb-mono">${p.ticker}</td>
                <td class="${p.side === 'long' ? 'bb-green' : 'bb-red'}">${p.side.toUpperCase()}</td>
                <td>${Math.abs(p.qty)}</td>
                <td class="bb-mono">${p.avgEntry.toFixed(2)}</td>
                <td class="bb-mono">${p.currentPrice.toFixed(2)}</td>
                <td class="${plClass} bb-mono">${this.bbMoney(p.unrealizedPnl)}</td>
                <td class="bb-dim">${p.strategyName}</td>
              </tr>`;
    }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  renderBBTrades(trades) {
    if (!trades || trades.length === 0) {
      return '<div class="bb-empty">No trades yet — strategies will execute every 30s</div>';
    }
    return `
      <div class="bb-table-wrap bb-scrollable">
        <table class="bb-table">
          <thead>
            <tr><th>TIME</th><th>TICKER</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>SLIP</th><th>COMM</th><th>BORROW</th><th>REGIME</th><th>STRATEGY</th></tr>
          </thead>
          <tbody>
            ${trades.slice(0, 20).map(t => {
      return `<tr>
                <td class="bb-dim">${Utils.formatTime(t.executed_at)}</td>
                <td class="bb-mono">${t.ticker}</td>
                <td class="${t.side === 'buy' ? 'bb-green' : 'bb-red'}">${t.side.toUpperCase()}</td>
                <td>${t.quantity}</td>
                <td class="bb-mono">${Number(t.price).toFixed(2)}</td>
                <td class="bb-mono">${Number(t.slippage_bps || 0).toFixed(2)}bps</td>
                <td class="bb-mono">${this.bbMoney(t.commission || 0)}</td>
                <td class="bb-mono">${this.bbMoney(t.borrow_cost || 0)}</td>
                <td class="bb-dim">${t.regime || 'normal'}</td>
                <td class="bb-dim">${t.strategy_name || ''}</td>
              </tr>`;
    }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  renderBBStrategyPerf(strategies) {
    if (!strategies || strategies.length === 0) {
      return '<div class="bb-empty">No strategies configured</div>';
    }
    return `
      <div class="bb-strat-grid">
        ${strategies.map(s => {
      const totalPnl = s.realizedPnl + s.unrealizedPnl;
      const pnlClass = totalPnl >= 0 ? 'bb-green' : 'bb-red';
      const fillCount = Number(s.fillCount || 0);
      const closedCount = Number(s.closedTradeCount ?? s.tradeCount ?? 0);
      const nonClosingFills = Number(s.nonClosingFills ?? Math.max(0, fillCount - closedCount));
      const winRate = Number.isFinite(Number(s.winRate))
        ? Number(s.winRate).toFixed(0)
        : ((s.winCount + s.lossCount) > 0 ? ((s.winCount / (s.winCount + s.lossCount)) * 100).toFixed(0) : '—');
      const typeIcon = this.STRATEGY_TYPES[s.type]?.icon || '📊';
      return `
            <div class="bb-strat-card">
              <div class="bb-strat-header">
                <span>${typeIcon} ${s.name}</span>
                <span class="bb-strat-status ${s.is_active ? 'bb-active' : 'bb-inactive'}">${s.is_active ? 'ACTIVE' : 'OFF'}</span>
              </div>
              <div class="bb-strat-metrics">
                <div><span class="bb-dim">P&L</span> <span class="${pnlClass}">${this.bbMoney(totalPnl)}</span></div>
                <div><span class="bb-dim">Cost Drag</span> <span>${Number(s.costDragPct || 0).toFixed(2)}%</span></div>
                <div><span class="bb-dim">Closed/Fills</span> <span>${closedCount}/${fillCount}</span></div>
                <div><span class="bb-dim">Opening Fills</span> <span>${nonClosingFills}</span></div>
                <div><span class="bb-dim">Win%</span> <span>${winRate}%</span></div>
                <div><span class="bb-dim">W/L/B</span> <span><span class="bb-green">${s.winCount}</span>/<span class="bb-red">${s.lossCount}</span>/<span class="bb-dim">${s.breakevenCount || 0}</span></span></div>
              </div>
              ${s.lastRunAt ? `<div class="bb-strat-time">Last run: ${Utils.timeAgo(s.lastRunAt)}</div>` : ''}
            </div>
          `;
    }).join('')}
      </div>
    `;
  },

  renderBBSignals(signals) {
    if (!signals || signals.length === 0) {
      return '<div class="bb-empty">Waiting for strategy signals...</div>';
    }
    return `
      <div class="bb-signal-list bb-scrollable">
        ${signals.slice(0, 15).map(s => {
      const sigClass = s.signal === 'buy' ? 'bb-green' : s.signal === 'sell' ? 'bb-red' : 'bb-dim';
      return `
            <div class="bb-signal-item">
              <span class="bb-signal-time">${Utils.formatTime(s.timestamp)}</span>
              <span class="bb-signal-badge ${sigClass}">${s.signal.toUpperCase()}</span>
              <span class="bb-mono">${s.ticker}</span>
              <span class="bb-signal-strat">${s.strategy_name}</span>
              <div class="bb-signal-reason">${s.reason}</div>
            </div>
          `;
    }).join('')}
      </div>
    `;
  },

  bbMoney(val) {
    if (val === undefined || val === null) return '$0.00';
    const sign = val >= 0 ? '+' : '';
    return `${sign}$${Math.abs(val).toFixed(2)}`;
  },

  destroy() {
    if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }
  }
};

window.Funds = Funds;

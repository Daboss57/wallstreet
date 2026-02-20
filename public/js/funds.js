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

  // Pre-built strategy types
  STRATEGY_TYPES: {
    'mean_reversion': { name: 'Mean Reversion', icon: '🔄', desc: 'Buy oversold, sell overbought assets' },
    'momentum': { name: 'Momentum', icon: '🚀', desc: 'Follow market trends and momentum' },
    'grid': { name: 'Grid Trading', icon: '📊', desc: 'Place buy/sell orders at fixed intervals' },
    'pairs': { name: 'Pairs Trading', icon: '🔗', desc: 'Trade correlated asset pairs' },
    'custom': { name: 'Custom Strategy', icon: '⚙️', desc: 'Write your own trading logic' }
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

  // ─── Funds List ──────────────────────────────────────────────────────────────
  renderFundsList() {
    return `
      <div class="funds-header">
        <h1>🏦 Hedge Funds</h1>
        <p class="page-subtitle">Create and manage collaborative trading funds</p>
      </div>

      ${this.myFunds.length > 0 ? `
      <div class="funds-actions">
        <button class="btn-primary" onclick="Funds.showCreateFundModal()">
          + Create New Fund
        </button>
      </div>
      ` : ''}

      ${this.myFunds.length === 0 ? this.renderEmptyState() : this.renderFundsGrid()}
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

  renderFundsGrid() {
    return `
      <div class="funds-grid">
        ${this.myFunds.map(fund => this.renderFundCard(fund)).join('')}
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
          <button class="fund-tab ${this.currentTab === 'members' ? 'active' : ''}" data-tab="members">Members</button>
          <button class="fund-tab ${this.currentTab === 'capital' ? 'active' : ''}" data-tab="capital">Capital</button>
          <button class="fund-tab ${this.currentTab === 'strategies' ? 'active' : ''}" data-tab="strategies">Strategies</button>
        </div>

        <div class="fund-tab-content">
          ${this.renderTabContent()}
        </div>
      </div>
    `;
  },

  renderTabContent() {
    switch (this.currentTab) {
      case 'overview': return this.renderOverviewTab();
      case 'members': return this.renderMembersTab();
      case 'capital': return this.renderCapitalTab();
      case 'strategies': return this.renderStrategiesTab();
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
    return `
      <div class="capital-section">
        <div class="capital-actions">
          <button class="btn-primary" onclick="Funds.showDepositModal()">+ Deposit</button>
          <button class="btn-secondary" onclick="Funds.showWithdrawModal()">Withdraw</button>
        </div>

        <div class="capital-summary">
          <div class="overview-card">
            <div class="card-label">Your Capital</div>
            <div class="card-value">${Utils.money(this.getUserCapital())}</div>
          </div>
        </div>

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
              <th>User</th>
            </tr>
          </thead>
          <tbody>
            ${this.capitalTransactions.map(t => `
            <tr>
              <td>${Utils.formatDate(t.created_at)}</td>
              <td class="${t.type === 'deposit' ? 'price-up' : 'price-down'}">${t.type.toUpperCase()}</td>
              <td class="mono">${Utils.money(t.amount)}</td>
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
        </div>
        <div class="strategy-actions">
          ${strategy.is_active ? `
          <button class="action-btn" onclick="Funds.stopStrategy('${strategy.id}', ${isCustom})">Stop</button>
          ` : `
          <button class="action-btn success" onclick="Funds.startStrategy('${strategy.id}', ${isCustom})">Start</button>
          `}
          ${isCustom ? `
          <button class="action-btn" onclick="Funds.viewCustomStrategy('${strategy.id}')">View Code</button>
          ` : ''}
          <button class="action-btn" onclick="Funds.showEditStrategyModal('${strategy.id}', ${isCustom})">Edit</button>
          <button class="action-btn danger" onclick="Funds.deleteStrategy('${strategy.id}', ${isCustom})">Delete</button>
        </div>
      </div>
    `;
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
      const [fund, members, strategies, customStrategies, capital] = await Promise.all([
        Utils.get('/funds/' + fundId),
        Utils.get('/funds/' + fundId + '/members'),
        Utils.get('/funds/' + fundId + '/strategies'),
        Utils.get('/funds/' + fundId + '/custom-strategies'),
        Utils.get('/funds/' + fundId + '/capital')
      ]);

      // Get role from myFunds
      const myFund = this.myFunds.find(f => f.id === fundId);
      this.currentFund = { ...fund, role: myFund?.role || 'client' };
      this.members = members;
      this.strategies = strategies;
      this.customStrategies = customStrategies;
      this.capitalTransactions = capital;
    } catch (e) {
      console.error('Failed to load fund details:', e);
      Utils.showToast('error', 'Load Failed', e.message);
    }
  },

  // ─── Navigation ──────────────────────────────────────────────────────────────
  async viewFund(fundId) {
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
    this.updateContent();
  },

  switchTab(tab) {
    this.currentTab = tab;
    this.updateContent();
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
    const userCash = App.user?.cash || 0;
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

    if (!amount || amount <= 0) {
      Utils.showToast('error', 'Invalid Amount', 'Please enter a valid amount');
      return;
    }

    try {
      await Utils.post('/funds/' + fundId + '/capital', { amount, type: 'deposit' });
      Utils.showToast('info', 'Deposit Successful', `${Utils.money(amount)} has been deposited`);
      document.getElementById('deposit-modal')?.remove();

      // Refresh data
      const [capital, user] = await Promise.all([
        Utils.get('/funds/' + fundId + '/capital'),
        Utils.get('/me')
      ]);
      this.capitalTransactions = capital;
      App.user = user;
      this.updateContent();
    } catch (e) {
      Utils.showToast('error', 'Deposit Failed', e.message);
    }
  },

  showWithdrawModal() {
    const userCapital = this.getUserCapital();
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
            <label>Your Capital in Fund</label>
            <div class="form-value">${Utils.money(userCapital)}</div>
          </div>
          <div class="form-group">
            <label>Amount to Withdraw</label>
            <input type="number" id="withdraw-amount" placeholder="0.00" min="0" max="${userCapital}" step="0.01">
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

    if (!amount || amount <= 0) {
      Utils.showToast('error', 'Invalid Amount', 'Please enter a valid amount');
      return;
    }

    try {
      await Utils.post('/funds/' + fundId + '/capital', { amount, type: 'withdrawal' });
      Utils.showToast('info', 'Withdrawal Successful', `${Utils.money(amount)} has been withdrawn`);
      document.getElementById('withdraw-modal')?.remove();

      // Refresh data
      const [capital, user] = await Promise.all([
        Utils.get('/funds/' + fundId + '/capital'),
        Utils.get('/me')
      ]);
      this.capitalTransactions = capital;
      App.user = user;
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
                <select id="strategy-ticker">
                  <optgroup label="Stocks — Large Cap">
                    <option value="AAPL">AAPL — Apricot Corp</option>
                    <option value="MSFT">MSFT — MegaSoft</option>
                    <option value="NVDA">NVDA — NeuraVolt</option>
                    <option value="AMZN">AMZN — AmazoNet</option>
                    <option value="GOOG">GOOG — GooglTech</option>
                    <option value="META">META — MetaVerse Inc</option>
                    <option value="TSLA">TSLA — VoltMotors</option>
                  </optgroup>
                  <optgroup label="Stocks — Growth / Speculative">
                    <option value="MOON">MOON — LunarTech</option>
                    <option value="BIOT">BIOT — BioTera</option>
                    <option value="QNTM">QNTM — QuantumLeap</option>
                  </optgroup>
                  <optgroup label="Commodities">
                    <option value="OGLD">OGLD — OmniGold</option>
                    <option value="SLVR">SLVR — SilverEdge</option>
                    <option value="CRUD">CRUD — CrudeFlow</option>
                    <option value="NATG">NATG — NatGas Plus</option>
                    <option value="COPR">COPR — CopperLine</option>
                  </optgroup>
                  <optgroup label="Futures / Indices">
                    <option value="SPXF">SPXF — S&P Futures</option>
                    <option value="NQFT">NQFT — NQ Futures</option>
                    <option value="DOWF">DOWF — Dow Futures</option>
                    <option value="VIXF">VIXF — Fear Index</option>
                  </optgroup>
                  <optgroup label="ETFs">
                    <option value="SAFE">SAFE — Treasury ETF</option>
                    <option value="BNKX">BNKX — BankEx ETF</option>
                    <option value="NRGY">NRGY — Energy ETF</option>
                    <option value="MEDS">MEDS — HealthCare ETF</option>
                    <option value="SEMX">SEMX — SemiConductor ETF</option>
                    <option value="REIT">REIT — RealtyFund ETF</option>
                  </optgroup>
                  <optgroup label="Crypto">
                    <option value="BTCX">BTCX — Bitcoin Index</option>
                    <option value="ETHX">ETHX — Ethereum Index</option>
                    <option value="SOLX">SOLX — Solana Index</option>
                  </optgroup>
                  <optgroup label="Forex">
                    <option value="EURUSD">EURUSD — Euro/Dollar</option>
                    <option value="GBPUSD">GBPUSD — Pound/Dollar</option>
                    <option value="USDJPY">USDJPY — Dollar/Yen</option>
                  </optgroup>
                </select>
              </div>
            </div>

            <div id="custom-code-section" style="display:none">
              <div class="form-group">
                <label>Strategy Code (JavaScript)</label>
                <textarea id="strategy-code" rows="10" placeholder="// function run(context) {
//   const { prices, ticker } = context;
//   const aapl = ticker('AAPL');
//   return { action: 'buy', ticker: 'AAPL', qty: 10 };
// }"></textarea>
                <small class="form-hint">Available: prices (all prices), ticker(symbol), log()</small>
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
    document.getElementById('prebuilt-config').style.display = isCustom ? 'none' : '';
    document.getElementById('custom-code-section').style.display = isCustom ? '' : 'none';
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

        await Utils.post('/funds/' + fundId + '/strategies', {
          name,
          type,
          config: { ticker }
        });
      }

      Utils.showToast('info', 'Strategy Created', `"${name}" has been created`);
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
    const parameters = typeof strategy.parameters === 'string' ? JSON.parse(strategy.parameters) : (strategy.parameters || {});

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
              <option value="AAPL" ${config.ticker === 'AAPL' ? 'selected' : ''}>AAPL - Apple</option>
              <option value="GOOGL" ${config.ticker === 'GOOGL' ? 'selected' : ''}>GOOGL - Google</option>
              <option value="MSFT" ${config.ticker === 'MSFT' ? 'selected' : ''}>MSFT - Microsoft</option>
              <option value="TSLA" ${config.ticker === 'TSLA' ? 'selected' : ''}>TSLA - Tesla</option>
              <option value="AMZN" ${config.ticker === 'AMZN' ? 'selected' : ''}>AMZN - Amazon</option>
              <option value="BTC" ${config.ticker === 'BTC' ? 'selected' : ''}>BTC - Bitcoin</option>
              <option value="ETH" ${config.ticker === 'ETH' ? 'selected' : ''}>ETH - Ethereum</option>
            </select>
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
        const ticker = document.getElementById('strategy-ticker')?.value;
        await Utils.put('/strategies/' + strategyId, {
          name,
          config: { ticker }
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
      await Utils.post('/strategies/' + strategyId + '/start');
      Utils.showToast('info', 'Strategy Started', 'Strategy is now active');

      await this.refreshStrategies();
    } catch (e) {
      Utils.showToast('error', 'Start Failed', e.message);
    }
  },

  async stopStrategy(strategyId, isCustom) {
    try {
      await Utils.post('/strategies/' + strategyId + '/stop');
      Utils.showToast('info', 'Strategy Stopped', 'Strategy has been stopped');

      await this.refreshStrategies();
    } catch (e) {
      Utils.showToast('error', 'Stop Failed', e.message);
    }
  },

  async deleteStrategy(strategyId, isCustom) {
    if (!confirm('Are you sure you want to delete this strategy?')) return;

    try {
      await Utils.del('/strategies/' + strategyId);
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

  destroy() {
    if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
  }
};

window.Funds = Funds;

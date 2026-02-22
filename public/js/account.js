/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Account Page
   ═══════════════════════════════════════════════════════════════════════════════ */

const Account = {
    profile: null,
    stats: null,
    trades: [],
    funds: [],

    async render(container) {
        await this.loadData();

        const profile = this.profile || App.user || {};
        const stats = this.stats || {};
        const totalValue = Utils.toNumber(stats.totalValue, Utils.toNumber(profile.cash, 0));
        const startingCash = Utils.toNumber(profile.starting_cash, 100000);
        const pnlValue = +(totalValue - startingCash).toFixed(2);
        const allTimeReturn = Number.isFinite(stats.allTimeReturn)
            ? Number(stats.allTimeReturn)
            : (startingCash > 0 ? ((totalValue - startingCash) / startingCash) * 100 : 0);

        container.innerHTML = `
      <div class="terminal-layout">
        ${Terminal.renderHeader()}
        <div class="account-page">
          <div class="account-header">
            <h1>👤 Account</h1>
            <p class="page-subtitle">Profile, balances, and recent activity.</p>
          </div>

          <div class="account-overview-grid">
            <div class="portfolio-stat-card">
              <div class="psc-label">Cash Balance</div>
              <div class="psc-value">${Utils.money(profile.cash ?? 0)}</div>
              <div class="psc-sub text-muted">Available to trade or deposit into funds</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Portfolio Value</div>
              <div class="psc-value">${Utils.money(totalValue)}</div>
              <div class="psc-sub ${Utils.colorClass(allTimeReturn)}">${Utils.pct(allTimeReturn)} all-time</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Net P&L</div>
              <div class="psc-value ${Utils.colorClass(pnlValue)}">${Utils.money(pnlValue)}</div>
              <div class="psc-sub text-muted">From starting balance ${Utils.money(startingCash)}</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Fund Memberships</div>
              <div class="psc-value">${this.funds.length}</div>
              <div class="psc-sub text-muted">Owner / analyst / client roles</div>
            </div>
          </div>

          <div class="account-sections">
            <section class="account-card">
              <h3>Profile</h3>
              <div class="account-profile-grid">
                <div class="account-field">
                  <span class="account-label">Username</span>
                  <span class="account-value">${profile.username || '—'}</span>
                </div>
                <div class="account-field">
                  <span class="account-label">Role</span>
                  <span class="account-value">${(profile.role || 'user').toUpperCase()}</span>
                </div>
                <div class="account-field">
                  <span class="account-label">Member Since</span>
                  <span class="account-value">${profile.created_at ? Utils.formatDate(profile.created_at) : '—'}</span>
                </div>
                <div class="account-field">
                  <span class="account-label">Total Trades</span>
                  <span class="account-value">${stats.totalTrades || 0}</span>
                </div>
              </div>
            </section>

            <section class="account-card">
              <h3>Funds</h3>
              ${this.renderFunds()}
            </section>

            <section class="account-card">
              <h3>Recent Trades</h3>
              ${this.renderExecutionCostSummary()}
              ${this.renderTrades()}
            </section>
          </div>
        </div>
      </div>
    `;

        Terminal.startClock();
    },

    async loadData() {
        const [profileResult, statsResult, tradesResult, fundsResult] = await Promise.allSettled([
            Utils.get('/me'),
            Utils.get('/portfolio/stats'),
            Utils.get('/trades?limit=200'),
            Utils.get('/funds/my'),
        ]);

        if (profileResult.status === 'fulfilled') {
            this.profile = profileResult.value;
            App.user = profileResult.value;
        } else {
            console.error('Failed to load account profile:', profileResult.reason);
            this.profile = null;
        }

        if (statsResult.status === 'fulfilled') {
            this.stats = statsResult.value;
        } else {
            console.error('Failed to load account stats:', statsResult.reason);
            this.stats = null;
        }

        if (tradesResult.status === 'fulfilled') {
            this.trades = tradesResult.value;
        } else {
            console.error('Failed to load account trades:', tradesResult.reason);
            this.trades = [];
        }

        if (fundsResult.status === 'fulfilled') {
            this.funds = fundsResult.value;
        } else {
            console.error('Failed to load account funds:', fundsResult.reason);
            this.funds = [];
        }
    },

    renderFunds() {
        if (!this.funds.length) {
            return `
        <div class="empty-state" style="padding:24px">
          <span class="empty-icon">🏦</span>
          <span class="empty-text">You are not in any funds yet.</span>
        </div>
      `;
        }

        return `
      <table class="data-table">
        <thead>
          <tr>
            <th>Fund</th>
            <th>Role</th>
            <th>Strategy</th>
            <th>Min Investment</th>
          </tr>
        </thead>
        <tbody>
          ${this.funds.map((fund) => `
            <tr>
              <td style="font-weight:700">${fund.name}</td>
              <td><span class="fund-role role-${fund.role}">${fund.role.toUpperCase()}</span></td>
              <td>${(fund.strategy_type || '').replace('_', ' ')}</td>
              <td>${Utils.money(fund.min_investment || 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    },

    renderTrades() {
        if (!this.trades.length) {
            return `
        <div class="empty-state" style="padding:24px">
          <span class="empty-icon">📭</span>
          <span class="empty-text">No trades yet.</span>
        </div>
      `;
        }

        return `
      <table class="data-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Ticker</th>
            <th>Side</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Total</th>
            <th>P&L</th>
          </tr>
        </thead>
        <tbody>
          ${this.trades.map((trade) => `
            <tr>
              <td>${Utils.formatDate(trade.executed_at)}</td>
              <td style="font-weight:700">${trade.ticker}</td>
              <td class="${trade.side === 'buy' ? 'price-up' : 'price-down'}">${trade.side.toUpperCase()}</td>
              <td>${trade.qty}</td>
              <td>${Utils.num(trade.price || 0)}</td>
              <td>${Utils.money(trade.total || 0)}</td>
              <td class="${Utils.colorClass(trade.pnl || 0)}">${Utils.money(trade.pnl || 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    },

    renderExecutionCostSummary() {
        if (!this.trades.length) return '';

        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const monthStartTs = monthStart.getTime();
        const monthTrades = this.trades.filter((t) => Number(t.executed_at || 0) >= monthStartTs);
        const sumField = (rows, field) => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
        const monthSlippage = sumField(monthTrades, 'slippage_cost');
        const monthCommission = sumField(monthTrades, 'commission');
        const monthBorrow = sumField(monthTrades, 'borrow_cost');
        const monthTotal = monthSlippage + monthCommission + monthBorrow;

        return `
      <div class="portfolio-analytics" style="margin-bottom:14px">
        <div class="portfolio-stat-card">
          <div class="psc-label">Month Slippage</div>
          <div class="psc-value price-down">${Utils.money(monthSlippage)}</div>
        </div>
        <div class="portfolio-stat-card">
          <div class="psc-label">Month Commission</div>
          <div class="psc-value price-down">${Utils.money(monthCommission)}</div>
        </div>
        <div class="portfolio-stat-card">
          <div class="psc-label">Month Borrow</div>
          <div class="psc-value price-down">${Utils.money(monthBorrow)}</div>
        </div>
        <div class="portfolio-stat-card">
          <div class="psc-label">Month Total Cost</div>
          <div class="psc-value">${Utils.money(monthTotal)}</div>
        </div>
      </div>
    `;
    },

    destroy() {
        if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
    },
};

window.Account = Account;

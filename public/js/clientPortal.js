/* 
 * StreetOS Client Portal
 * Restricted dashboard for fund investors with "client" role
 * Bloomberg-style dark theme
 */

const ClientPortal = {
    currentFundId: null,
    allocation: null,
    navData: null,
    performance: null,
    transactions: [],
    statements: null,
    fundSummary: null,
    chart: null,

    // Strategy type icons and descriptions
    STRATEGY_ICONS: {
        'mean_reversion': { icon: 'fa-solid fa-rotate', name: 'Mean Reversion' },
        'momentum': { icon: 'fa-solid fa-rocket', name: 'Momentum' },
        'grid': { icon: 'fa-solid fa-grip', name: 'Grid Trading' },
        'pairs': { icon: 'fa-solid fa-link', name: 'Pairs Trading' },
        'custom': { icon: 'fa-solid fa-code', name: 'Custom' },
    },

    // Initialize and render
    async render(container) {
        // Check if user has client role in any fund
        await this.loadClientFunds();

        if (this.clientFunds.length === 0) {
            this.renderNoAccess(container);
            return;
        }

        // Use first fund if none selected
        if (!this.currentFundId && this.clientFunds.length > 0) {
            this.currentFundId = this.clientFunds[0].id;
        }

        // Load all data
        await this.loadAllData();

        // Render page
        container.innerHTML = `
            <div class="terminal-layout">
                ${Terminal.renderHeader()}
                <div class="client-portal-page">
                    ${this.renderContent()}
                </div>
            </div>
        `;

        Terminal.startClock();
        this.bindEvents();
        this.initChart();
    },

    renderNoAccess(container) {
        container.innerHTML = `
            <div class="terminal-layout">
                ${Terminal.renderHeader()}
                <div class="client-portal-page">
                    <div class="no-access-container">
                        <div class="no-access-icon">fa-solid fa-lock</div>
                        <h2>Access Restricted</h2>
                        <p>You don't have client access to any funds. Contact a fund manager to be added as a client.</p>
                        <button class="btn-secondary" onclick="window.location.hash='#/funds'">View Funds</button>
                    </div>
                </div>
            </div>
        `;
        Terminal.startClock();
    },

    renderContent() {
        const currentFund = this.clientFunds.find(f => f.id === this.currentFundId);

        return `
            <div class="cp-header">
                <div class="cp-header-left">
                    <h1><i class="fa-solid fa-building-columns"></i> Client Portal</h1>
                    <span class="cp-fund-name">${currentFund?.name || 'Select Fund'}</span>
                </div>
                <div class="cp-fund-selector">
                    <select id="cp-fund-select" onchange="ClientPortal.selectFund(this.value)">
                        ${this.clientFunds.map(f => `
                            <option value="${f.id}" ${f.id === this.currentFundId ? 'selected' : ''}>
                                ${f.name} (${f.role})
                            </option>
                        `).join('')}
                    </select>
                </div>
            </div>

            <div class="cp-dashboard">
                <!-- Allocation Card -->
                <div class="cp-card cp-allocation-card">
                    <div class="cp-card-header">
                        <h3><i class="fa-solid fa-wallet"></i> Your Investment</h3>
                    </div>
                    <div class="cp-card-body">
                        ${this.renderAllocationContent()}
                    </div>
                </div>

                <!-- Fund Summary Card -->
                <div class="cp-card cp-summary-card">
                    <div class="cp-card-header">
                        <h3><i class="fa-solid fa-chart-pie"></i> Fund Summary</h3>
                    </div>
                    <div class="cp-card-body">
                        ${this.renderSummaryContent()}
                    </div>
                </div>

                <!-- Performance Chart -->
                <div class="cp-card cp-chart-card">
                    <div class="cp-card-header">
                        <h3><i class="fa-solid fa-chart-line"></i> Performance</h3>
                        <div class="cp-chart-period">
                            <button class="period-btn active" data-period="30">30D</button>
                            <button class="period-btn" data-period="60">60D</button>
                            <button class="period-btn" data-period="90">90D</button>
                        </div>
                    </div>
                    <div class="cp-card-body">
                        <div id="cp-performance-chart" class="cp-chart-container"></div>
                        <div class="cp-performance-stats">
                            ${this.renderPerformanceStats()}
                        </div>
                    </div>
                </div>

                <!-- Transactions Table -->
                <div class="cp-card cp-transactions-card">
                    <div class="cp-card-header">
                        <h3><i class="fa-solid fa-clock-rotate-left"></i> Transaction History</h3>
                    </div>
                    <div class="cp-card-body">
                        ${this.renderTransactionsContent()}
                    </div>
                </div>

                <!-- Monthly Statements -->
                <div class="cp-card cp-statements-card">
                    <div class="cp-card-header">
                        <h3><i class="fa-solid fa-file-invoice-dollar"></i> Monthly Statements</h3>
                    </div>
                    <div class="cp-card-body">
                        ${this.renderStatementsContent()}
                    </div>
                </div>
            </div>
        `;
    },

    renderAllocationContent() {
        if (!this.allocation && !this.navData) return '<div class="loading-spinner"></div>';

        const currentFund = this.clientFunds.find(f => f.id === this.currentFundId) || {};
        const navUser = this.navData?.user || null;

        const capitalContributed = navUser
            ? Number(navUser.netCapital || 0)
            : Number(this.allocation?.capital_contributed || 0);
        const currentValue = navUser
            ? Number(navUser.value || 0)
            : Number(this.allocation?.current_value || 0);
        const unrealizedPnl = navUser
            ? Number(navUser.pnl || 0)
            : Number(this.allocation?.unrealized_pnl || 0);
        const ownershipPct = navUser
            ? Number(navUser.ownershipPct || 0)
            : Number(this.allocation?.ownership_pct || 0);
        const returnPct = capitalContributed !== 0
            ? (unrealizedPnl / capitalContributed) * 100
            : Number(this.allocation?.return_pct || 0);
        const managementFee = Number(this.allocation?.management_fee ?? currentFund.management_fee ?? 0);
        const performanceFee = Number(this.allocation?.performance_fee ?? currentFund.performance_fee ?? 0);

        const pnlClass = unrealizedPnl >= 0 ? 'positive' : 'negative';
        const pnlSign = unrealizedPnl >= 0 ? '+' : '';
        const returnSign = returnPct >= 0 ? '+' : '';

        return `
            <div class="cp-allocation-main">
                <div class="cp-allocation-value">
                    <span class="cp-value-label">Current Value</span>
                    <span class="cp-value-amount">${Utils.money(currentValue)}</span>
                </div>
                <div class="cp-allocation-pnl ${pnlClass}">
                    <span class="cp-pnl-value">${pnlSign}${Utils.money(unrealizedPnl)}</span>
                    <span class="cp-pnl-pct">${returnSign}${Utils.num(returnPct, 2)}%</span>
                </div>
            </div>
            <div class="cp-allocation-details">
                <div class="cp-detail-row">
                    <span class="cp-detail-label">Capital Contributed</span>
                    <span class="cp-detail-value">${Utils.money(capitalContributed)}</span>
                </div>
                <div class="cp-detail-row">
                    <span class="cp-detail-label">Ownership</span>
                    <span class="cp-detail-value">${Utils.num(ownershipPct, 2)}%</span>
                </div>
                <div class="cp-detail-row">
                    <span class="cp-detail-label">Management Fee</span>
                    <span class="cp-detail-value">${(managementFee * 100).toFixed(1)}%</span>
                </div>
                <div class="cp-detail-row">
                    <span class="cp-detail-label">Performance Fee</span>
                    <span class="cp-detail-value">${(performanceFee * 100).toFixed(1)}%</span>
                </div>
            </div>
        `;
    },

    renderSummaryContent() {
        if (!this.fundSummary) return '<div class="loading-spinner"></div>';

        const returnClass = this.fundSummary.overall_return_pct >= 0 ? 'positive' : 'negative';
        const returnSign = this.fundSummary.overall_return_pct >= 0 ? '+' : '';
        const execCostSummary = this.fundSummary.execution_cost_summary || {};
        const trailingCost = Number(execCostSummary.total_execution_cost || 0);
        const costDragPct = Number(this.fundSummary.total_aum || 0) > 0
            ? (trailingCost / Number(this.fundSummary.total_aum || 0)) * 100
            : 0;

        return `
            <div class="cp-summary-grid">
                <div class="cp-summary-item">
                    <span class="cp-summary-label">Total AUM</span>
                    <span class="cp-summary-value">${Utils.money(this.fundSummary.total_aum)}</span>
                </div>
                <div class="cp-summary-item">
                    <span class="cp-summary-label">Net Capital</span>
                    <span class="cp-summary-value">${Utils.money(this.fundSummary.total_capital || 0)}</span>
                </div>
                <div class="cp-summary-item">
                    <span class="cp-summary-label">Members</span>
                    <span class="cp-summary-value">${this.fundSummary.member_count}</span>
                </div>
                <div class="cp-summary-item">
                    <span class="cp-summary-label">Clients</span>
                    <span class="cp-summary-value">${this.fundSummary.client_count}</span>
                </div>
                <div class="cp-summary-item">
                    <span class="cp-summary-label">Fund Return</span>
                    <span class="cp-summary-value ${returnClass}">${returnSign}${this.fundSummary.overall_return_pct}%</span>
                </div>
                <div class="cp-summary-item">
                    <span class="cp-summary-label">Execution Cost (12m)</span>
                    <span class="cp-summary-value">${Utils.money(trailingCost)}</span>
                </div>
                <div class="cp-summary-item">
                    <span class="cp-summary-label">Fund Cost Drag</span>
                    <span class="cp-summary-value">${Utils.num(costDragPct, 2)}%</span>
                </div>
            </div>
            ${this.fundSummary.description ? `
            <div class="cp-fund-description">
                <p>${this.fundSummary.description}</p>
            </div>
            ` : ''}
        `;
    },

    renderPerformanceStats() {
        if (!this.performance) return '';

        const lifetimeClass = this.performance.lifetime_return_pct >= 0 ? 'positive' : 'negative';
        const monthlyClass = this.performance.monthly_return_pct >= 0 ? 'positive' : 'negative';
        const weeklyClass = this.performance.weekly_return_pct >= 0 ? 'positive' : 'negative';

        const lifetimeSign = this.performance.lifetime_return_pct >= 0 ? '+' : '';
        const monthlySign = this.performance.monthly_return_pct >= 0 ? '+' : '';
        const weeklySign = this.performance.weekly_return_pct >= 0 ? '+' : '';

        return `
            <div class="cp-stat">
                <span class="cp-stat-label">Weekly</span>
                <span class="cp-stat-value ${weeklyClass}">${weeklySign}${this.performance.weekly_return_pct}%</span>
            </div>
            <div class="cp-stat">
                <span class="cp-stat-label">Monthly</span>
                <span class="cp-stat-value ${monthlyClass}">${monthlySign}${this.performance.monthly_return_pct}%</span>
            </div>
            <div class="cp-stat">
                <span class="cp-stat-label">Lifetime</span>
                <span class="cp-stat-value ${lifetimeClass}">${lifetimeSign}${this.performance.lifetime_return_pct}%</span>
            </div>
        `;
    },

    renderTransactionsContent() {
        if (!this.transactions || !this.transactions.transactions) {
            return '<div class="loading-spinner"></div>';
        }

        const transactions = this.transactions.transactions;

        if (transactions.length === 0) {
            return `
                <div class="cp-empty-state">
                    <i class="fa-solid fa-receipt"></i>
                    <p>No transactions yet</p>
                </div>
            `;
        }

        return `
            <table class="cp-transactions-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${transactions.slice(0, 20).map(t => {
                        const typeClass = t.type.toLowerCase() === 'deposit' ? 'deposit' : 'withdrawal';
                        return `
                            <tr>
                                <td>${t.date}</td>
                                <td><span class="cp-tx-type ${typeClass}">${t.type}</span></td>
                                <td class="cp-amount">${Utils.money(t.amount)}</td>
                                <td><span class="cp-status completed">${t.status}</span></td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
            ${transactions.length > 20 ? `<p class="cp-table-note">Showing last 20 transactions</p>` : ''}
        `;
    },

    renderStatementsContent() {
        if (!this.statements) {
            return '<div class="loading-spinner"></div>';
        }

        const rows = this.statements.statements || [];
        const summary = this.statements.summary || {};
        const pnlClass = Number(summary.since_inception_pnl || 0) >= 0 ? 'positive' : 'negative';
        const returnClass = Number(summary.since_inception_return_pct || 0) >= 0 ? 'positive' : 'negative';
        const pnlSign = Number(summary.since_inception_pnl || 0) >= 0 ? '+' : '';
        const returnSign = Number(summary.since_inception_return_pct || 0) >= 0 ? '+' : '';

        if (rows.length === 0) {
            return `
                <div class="cp-empty-state">
                    <i class="fa-solid fa-file-circle-xmark"></i>
                    <p>No monthly statement data yet</p>
                </div>
            `;
        }

        return `
            <div class="cp-statement-summary">
                <div class="cp-statement-pill">
                    <span class="cp-statement-pill-label">Net Contributed</span>
                    <span class="cp-statement-pill-value">${Utils.money(summary.net_contributed || 0)}</span>
                </div>
                <div class="cp-statement-pill">
                    <span class="cp-statement-pill-label">Current Value</span>
                    <span class="cp-statement-pill-value">${Utils.money(summary.current_value || 0)}</span>
                </div>
                <div class="cp-statement-pill">
                    <span class="cp-statement-pill-label">Since Inception P&L</span>
                    <span class="cp-statement-pill-value ${pnlClass}">${pnlSign}${Utils.money(summary.since_inception_pnl || 0)}</span>
                </div>
                <div class="cp-statement-pill">
                    <span class="cp-statement-pill-label">Since Inception Return</span>
                    <span class="cp-statement-pill-value ${returnClass}">${returnSign}${Utils.num(summary.since_inception_return_pct || 0, 2)}%</span>
                </div>
                <div class="cp-statement-pill">
                    <span class="cp-statement-pill-label">Est. Total Fees</span>
                    <span class="cp-statement-pill-value">${Utils.money(summary.total_estimated_fees || 0)}</span>
                </div>
            </div>

            <div class="cp-statements-wrap">
                <table class="cp-statements-table">
                    <thead>
                        <tr>
                            <th>Month</th>
                            <th>Opening Value</th>
                            <th>Net Flows</th>
                            <th>Gross P&L</th>
                            <th>Est. Fees</th>
                            <th>Net P&L</th>
                            <th>Ending Value</th>
                            <th>Return</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((row) => {
                            const grossClass = Number(row.gross_pnl || 0) >= 0 ? 'positive' : 'negative';
                            const netClass = Number(row.net_pnl_after_fees || 0) >= 0 ? 'positive' : 'negative';
                            const returnClassRow = Number(row.net_return_pct || 0) >= 0 ? 'positive' : 'negative';
                            const grossSign = Number(row.gross_pnl || 0) >= 0 ? '+' : '';
                            const netSign = Number(row.net_pnl_after_fees || 0) >= 0 ? '+' : '';
                            const returnSignRow = Number(row.net_return_pct || 0) >= 0 ? '+' : '';
                            return `
                                <tr>
                                    <td>${row.month_label}</td>
                                    <td>${Utils.money(row.opening_value || 0)}</td>
                                    <td>${Utils.money(row.net_flows || 0)}</td>
                                    <td class="${grossClass}">${grossSign}${Utils.money(row.gross_pnl || 0)}</td>
                                    <td>${Utils.money(row.estimated_total_fees || 0)}</td>
                                    <td class="${netClass}">${netSign}${Utils.money(row.net_pnl_after_fees || 0)}</td>
                                    <td>${Utils.money(row.closing_value || 0)}</td>
                                    <td class="${returnClassRow}">${returnSignRow}${Utils.num(row.net_return_pct || 0, 2)}%</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            <p class="cp-table-note">Values are estimated from monthly NAV snapshots and your unit ledger.</p>
        `;
    },

    // Data loading methods
    async loadClientFunds() {
        try {
            const allFunds = await Utils.get('/funds/my');
            // Filter to funds where user has client role (or owner/analyst for testing)
            this.clientFunds = allFunds.filter(f => 
                ['client', 'analyst', 'owner'].includes(f.role)
            );
        } catch (e) {
            console.error('Failed to load client funds:', e);
            this.clientFunds = [];
        }
    },

    async loadAllData() {
        const fundId = this.currentFundId;
        if (!fundId) return;

        const params = `?fund_id=${fundId}`;

        try {
            const [allocation, navData, performance, transactions, statements, fundSummary] = await Promise.all([
                Utils.get(`/client-portal/allocation${params}`).catch(() => null),
                Utils.get(`/funds/${fundId}/nav`).catch(() => null),
                Utils.get(`/client-portal/performance${params}`).catch(() => null),
                Utils.get(`/client-portal/transactions${params}`).catch(() => ({ transactions: [] })),
                Utils.get(`/client-portal/statements${params}`).catch(() => ({ statements: [], summary: null })),
                Utils.get(`/client-portal/fund-summary${params}`).catch(() => null),
            ]);

            this.allocation = allocation;
            this.navData = navData;
            this.performance = performance;
            this.transactions = transactions;
            this.statements = statements;
            this.fundSummary = fundSummary;
        } catch (e) {
            console.error('Failed to load client portal data:', e);
        }
    },

    selectFund(fundId) {
        this.currentFundId = fundId;
        this.loadAllData().then(() => {
            this.updateContent();
            this.initChart();
        });
    },

    updateContent() {
        const page = document.querySelector('.client-portal-page');
        if (page) {
            page.innerHTML = this.renderContent();
            this.bindEvents();
            this.initChart();
        }
    },

    bindEvents() {
        // Period buttons for chart
        document.querySelectorAll('.period-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.updateChart(parseInt(e.target.dataset.period));
            });
        });
    },

    initChart() {
        const container = document.getElementById('cp-performance-chart');
        if (!container || !this.performance || !this.performance.performance_history) {
            return;
        }

        // Clear existing chart
        container.innerHTML = '';

        // Create simple line chart using canvas
        const canvas = document.createElement('canvas');
        canvas.width = container.clientWidth || 600;
        canvas.height = 200;
        container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        const data = this.performance.performance_history;
        
        if (data.length === 0) return;

        // Filter to last 30 days by default
        const displayData = data.slice(-30);
        this.drawChart(ctx, displayData, canvas.width, canvas.height);
    },

    updateChart(days) {
        const container = document.getElementById('cp-performance-chart');
        if (!container || !this.performance || !this.performance.performance_history) {
            return;
        }

        const canvas = container.querySelector('canvas');
        if (!canvas) {
            this.initChart();
            return;
        }

        const ctx = canvas.getContext('2d');
        const data = this.performance.performance_history;
        const displayData = data.slice(-days);
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this.drawChart(ctx, displayData, canvas.width, canvas.height);
    },

    drawChart(ctx, data, width, height) {
        if (data.length === 0) return;

        const padding = { top: 20, right: 20, bottom: 30, left: 60 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        // Calculate min/max values
        const values = data.map(d => d.value);
        const minVal = Math.min(...values) * 0.95;
        const maxVal = Math.max(...values) * 1.05;
        const valueRange = maxVal - minVal;

        // Draw background
        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, width, height);

        // Draw grid lines
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        
        // Horizontal grid lines
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (chartHeight / 4) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();

            // Y-axis labels
            const value = maxVal - (valueRange / 4) * i;
            ctx.fillStyle = '#4a5568';
            ctx.font = '10px JetBrains Mono';
            ctx.textAlign = 'right';
            ctx.fillText(Utils.money(value), padding.left - 5, y + 3);
        }

        // Draw line
        const firstValue = data[0].value;
        ctx.strokeStyle = firstValue <= data[data.length - 1].value ? '#22c55e' : '#ef4444';
        ctx.lineWidth = 2;
        ctx.beginPath();

        data.forEach((point, i) => {
            const x = padding.left + (chartWidth / (data.length - 1)) * i;
            const y = padding.top + chartHeight - ((point.value - minVal) / valueRange) * chartHeight;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });

        ctx.stroke();

        // Draw gradient fill under line
        const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
        const lineColor = firstValue <= data[data.length - 1].value ? '34, 197, 94' : '239, 68, 68';
        gradient.addColorStop(0, `rgba(${lineColor}, 0.3)`);
        gradient.addColorStop(1, `rgba(${lineColor}, 0)`);

        ctx.fillStyle = gradient;
        ctx.beginPath();

        data.forEach((point, i) => {
            const x = padding.left + (chartWidth / (data.length - 1)) * i;
            const y = padding.top + chartHeight - ((point.value - minVal) / valueRange) * chartHeight;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });

        ctx.lineTo(padding.left + chartWidth, height - padding.bottom);
        ctx.lineTo(padding.left, height - padding.bottom);
        ctx.closePath();
        ctx.fill();

        // Draw current value dot
        const lastPoint = data[data.length - 1];
        const lastX = padding.left + chartWidth;
        const lastY = padding.top + chartHeight - ((lastPoint.value - minVal) / valueRange) * chartHeight;

        ctx.fillStyle = firstValue <= data[data.length - 1].value ? '#22c55e' : '#ef4444';
        ctx.beginPath();
        ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
        ctx.fill();
    },

    destroy() {
        if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
    }
};

// Make globally available
window.ClientPortal = ClientPortal;

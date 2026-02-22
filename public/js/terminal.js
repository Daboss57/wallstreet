/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Trading Terminal
   Main trading interface with watchlist, chart, order book, order panel, and
   bottom tabs (positions, open orders, trade history)
   ═══════════════════════════════════════════════════════════════════════════════ */

const Terminal = {
  selectedTicker: 'AAPL',
  orderSide: 'buy',
  tickers: {},
  priceCache: {},
  positions: [],
  openOrders: [],
  trades: [],
  executionEstimate: null,
  _watchlistFilter: '',
  _bottomTab: 'positions',

  async render(container) {
    // Load tickers
    try { this.tickers = await Utils.get('/tickers'); } catch (e) { console.error(e); }

    container.innerHTML = `
      <div class="terminal-layout">
        ${this.renderHeader()}
        <div class="terminal-main">
          ${this.renderWatchlist()}
          <div class="center-panel">
            ${this.renderChartHeader()}
            <div class="chart-container" id="chart-container"></div>
            ${this.renderOrderBook()}
          </div>
          ${this.renderOrderPanel()}
          ${this.renderBottomPanel()}
        </div>
      </div>
    `;

    // Initialize chart
    const chartEl = document.getElementById('chart-container');
    if (chartEl) {
      ChartManager.init(chartEl);
      ChartManager.loadTicker(this.selectedTicker, '1m');
    }

    // Bind events
    this.bindEvents();
    this.startClock();
    this.loadPortfolioData();

    // Listen for real-time updates
    Utils.on('ticks', (ticks) => this.onTicks(ticks));
    Utils.on('orderbook', (book) => this.onOrderBook(book));
    Utils.on('portfolio:update', (data) => this.onPortfolioUpdate(data));
    Utils.on('fill', () => this.loadPortfolioData());
  },

  renderHeader() {
    const user = App.user || {};
    const cash = Utils.toNumber(user.cash, 0);
    const currentHash = window.location.hash || '#/terminal';
    const activeClass = (route) => (currentHash === route ? 'active' : '');
    return `
      <div class="terminal-header">
        <div class="header-left">
          <div class="header-logo">
            <span class="logo-icon">🏦</span>
            <span>StreetOS</span>
          </div>
          <div class="market-status">
            <div class="status-dot"></div>
            <span class="status-text">LIVE</span>
          </div>
          <span class="header-clock" id="header-clock">--:--:--</span>
        </div>
        <div class="header-right">
          <nav class="header-nav">
            <a href="#/terminal" class="${activeClass('#/terminal')}">Terminal</a>
            <a href="#/markets" class="${activeClass('#/markets')}">Markets</a>
            <a href="#/portfolio" class="${activeClass('#/portfolio')}">Portfolio</a>
            <a href="#/funds" class="${activeClass('#/funds')}">Funds</a>
            <a href="#/client-portal" class="${activeClass('#/client-portal')}">My Portal</a>
            <a href="#/account" class="${activeClass('#/account')}">Account</a>
            <a href="#/leaderboard" class="${activeClass('#/leaderboard')}">Leaderboard</a>
            <a href="#/news" class="${activeClass('#/news')}">News</a>
          </nav>
          <div class="header-balance">
            <span class="balance-label">Balance</span>
            <span class="balance-value" id="header-cash">${Utils.money(cash)}</span>
          </div>
          <div class="header-user">
            <div class="user-avatar">${(user.username || 'U')[0].toUpperCase()}</div>
            <span>${user.username || 'User'}</span>
          </div>
          <button class="header-nav" onclick="App.logout()" style="color:var(--text-muted);font-size:0.8rem;">Logout</button>
        </div>
      </div>
    `;
  },

  renderWatchlist() {
    const grouped = {};
    for (const [ticker, def] of Object.entries(this.tickers)) {
      const cls = def.class || 'Other';
      if (!grouped[cls]) grouped[cls] = [];
      grouped[cls].push({ ticker, ...def });
    }

    let html = `<div class="watchlist">
      <input class="watchlist-search" id="watchlist-search" placeholder="Search tickers..." type="text">`;

    const classOrder = ['Stock', 'Commodity', 'Future', 'ETF', 'Crypto', 'Forex'];
    for (const cls of classOrder) {
      if (!grouped[cls]) continue;
      html += `<div class="watchlist-group-label">${cls}s</div>`;
      for (const item of grouped[cls]) {
        const change = item.changePct || 0;
        const colorCls = Utils.colorClass(change);
        const active = item.ticker === this.selectedTicker ? 'active' : '';
        html += `
          <div class="watchlist-item ${active}" data-ticker="${item.ticker}" id="wi-${item.ticker}">
            <div class="wi-left">
              <span class="wi-ticker">${item.ticker}</span>
              <span class="wi-name">${item.name}</span>
            </div>
            <div class="wi-right">
              <span class="wi-price" id="wp-${item.ticker}">${item.price ? Utils.num(item.price) : '--'}</span>
              <span class="wi-change ${colorCls}" id="wc-${item.ticker}">${Utils.pct(change)}</span>
            </div>
          </div>`;
      }
    }
    html += '</div>';
    return html;
  },

  renderChartHeader() {
    const t = this.tickers[this.selectedTicker] || {};
    const price = t.price || 0;
    const change = t.change || 0;
    const changePct = t.changePct || 0;
    const colorCls = Utils.colorClass(change);

    return `
      <div class="chart-header">
        <div class="chart-ticker-info">
          <span class="chart-ticker-name" id="chart-ticker">${this.selectedTicker}</span>
          <span class="chart-ticker-price ${colorCls}" id="chart-price">${Utils.num(price)}</span>
          <span class="chart-ticker-change ${colorCls}" id="chart-change">${Utils.change(change)} (${Utils.pct(changePct)})</span>
          <div class="chart-ticker-meta" id="chart-meta">
            <span>O: <b id="cm-open">${Utils.num(t.open || price)}</b></span>
            <span>H: <b id="cm-high">${Utils.num(t.high || price)}</b></span>
            <span>L: <b id="cm-low">${Utils.num(t.low || price)}</b></span>
            <span>Vol: <b id="cm-vol">${Utils.abbrev(t.volume || 0)}</b></span>
          </div>
        </div>
        <div class="chart-timeframes" id="chart-timeframes">
          <button class="active" data-interval="1m">1m</button>
          <button data-interval="5m">5m</button>
          <button data-interval="15m">15m</button>
          <button data-interval="1h">1h</button>
          <button data-interval="4h">4h</button>
          <button data-interval="1D">1D</button>
        </div>
      </div>
    `;
  },

  renderOrderBook() {
    return `
      <div class="orderbook-section" id="orderbook-section">
        <div class="orderbook-header">
          <span>Order Book — ${this.selectedTicker}</span>
          <span id="ob-spread">Spread: --</span>
        </div>
        <div class="orderbook-cols"><span>Price</span><span style="text-align:center">Qty</span><span style="text-align:right">Depth</span></div>
        <div id="ob-asks"></div>
        <div class="ob-spread-row">
          <span>Last:</span>
          <span class="spread-price" id="ob-last">--</span>
        </div>
        <div id="ob-bids"></div>
      </div>
    `;
  },

  ORDER_TYPE_INFO: {
    'market': { icon: '⚡', desc: 'Execute immediately at best available price' },
    'limit': { icon: '🎯', desc: 'Execute only at your price or better' },
    'stop-loss': { icon: '🛡️', desc: 'Sell when price drops to stop level' },
    'take-profit': { icon: '💰', desc: 'Sell when price rises to target level' },
    'stop-limit': { icon: '🔒', desc: 'Limit order activated when stop price hit' },
    'trailing-stop': { icon: '📐', desc: 'Stop that follows price by a % distance' },
  },

  renderOrderPanel() {
    const t = this.priceCache[this.selectedTicker] || this.tickers[this.selectedTicker] || {};
    const price = t.price || 0;
    const cash = Utils.toNumber(App.user?.cash, 0);
    const maxQty = price > 0 ? Math.floor(cash / price) : 0;
    const pos = this.positions.find(p => p.ticker === this.selectedTicker);

    return `
      <div class="order-panel">
        <div class="order-panel-header">${this.selectedTicker} — Place Order</div>
        <div class="order-side-tabs">
          <button class="order-side-tab buy ${this.orderSide === 'buy' ? 'active' : ''}" data-side="buy">BUY / LONG</button>
          <button class="order-side-tab sell ${this.orderSide === 'sell' ? 'active' : ''}" data-side="sell">SELL / SHORT</button>
        </div>
        <div class="order-form" id="order-form">
          ${pos ? `
          <div class="order-position-badge" id="order-pos-badge">
            <span style="color:var(--text-muted);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px">Current Position</span>
            <span style="font-family:var(--font-mono);font-weight:700;font-size:0.9rem;${pos.qty > 0 ? 'color:var(--green)' : 'color:var(--red)'}">${pos.qty > 0 ? '▲ LONG' : '▼ SHORT'} ${Math.abs(pos.qty)} @ ${Utils.num(pos.avg_cost)}</span>
            <span style="font-family:var(--font-mono);font-size:0.8rem" class="${Utils.colorClass(pos.unrealizedPnl || 0)}">P&L: ${Utils.money(pos.unrealizedPnl || 0)} (${Utils.pct(pos.pnlPct || 0)})</span>
          </div>` : ''}
          <div class="form-group">
            <label>Order Type</label>
            <select id="order-type">
              <option value="market">⚡ Market</option>
              <option value="limit">🎯 Limit</option>
              <option value="stop-loss">🛡️ Stop-Loss</option>
              <option value="take-profit">💰 Take-Profit</option>
              <option value="stop-limit">🔒 Stop-Limit</option>
              <option value="trailing-stop">📐 Trailing Stop</option>
            </select>
            <div class="order-type-hint" id="order-type-hint">Execute immediately at best available price</div>
          </div>
          <div class="form-group">
            <label>Quantity</label>
            <input type="number" id="order-qty" placeholder="0" min="1" step="1" value="10">
            <div class="order-qty-presets" id="order-qty-presets">
              <button data-pct="25">25%</button>
              <button data-pct="50">50%</button>
              <button data-pct="75">75%</button>
              <button data-pct="100">MAX</button>
            </div>
          </div>
          <div class="form-group" id="limit-price-group" style="display:none;">
            <label>Limit Price</label>
            <input type="number" id="order-limit-price" placeholder="0.00" step="0.01">
            <div class="order-price-presets" id="limit-presets">
              <button data-offset="-1">-1%</button>
              <button data-offset="0">Mkt</button>
              <button data-offset="1">+1%</button>
            </div>
          </div>
          <div class="form-group" id="stop-price-group" style="display:none;">
            <label>Stop / Trigger Price</label>
            <input type="number" id="order-stop-price" placeholder="0.00" step="0.01">
            <div class="order-price-presets" id="stop-presets">
              <button data-offset="-2">-2%</button>
              <button data-offset="-5">-5%</button>
              <button data-offset="2">+2%</button>
              <button data-offset="5">+5%</button>
            </div>
          </div>
          <div class="form-group" id="trail-pct-group" style="display:none;">
            <label>Trail Distance %</label>
            <input type="number" id="order-trail-pct" placeholder="2.0" step="0.1" value="2">
            <div class="order-price-presets">
              <button onclick="document.getElementById('order-trail-pct').value='1';Terminal.updateOrderPreview()">1%</button>
              <button onclick="document.getElementById('order-trail-pct').value='2';Terminal.updateOrderPreview()">2%</button>
              <button onclick="document.getElementById('order-trail-pct').value='5';Terminal.updateOrderPreview()">5%</button>
              <button onclick="document.getElementById('order-trail-pct').value='10';Terminal.updateOrderPreview()">10%</button>
            </div>
          </div>
          <div class="order-preview" id="order-preview">
            <div class="order-preview-row"><span class="label">Ticker</span><span class="value" id="preview-ticker">${this.selectedTicker}</span></div>
            <div class="order-preview-row"><span class="label">Market Price</span><span class="value" id="preview-price">${Utils.num(price)}</span></div>
            <div class="order-preview-row"><span class="label">Est. Total</span><span class="value" id="preview-total">--</span></div>
            <div class="order-preview-row"><span class="label">Buying Power</span><span class="value" id="preview-bp">${Utils.money(cash)}</span></div>
            <div class="order-preview-row" id="preview-bp-after-row"><span class="label">BP After</span><span class="value" id="preview-bp-after">--</span></div>
          </div>
          <div class="order-preview" id="execution-estimate-panel">
            <div class="order-preview-row"><span class="label">Execution Estimate</span><span class="value" id="ee-regime">--</span></div>
            <div class="order-preview-row"><span class="label">Slippage</span><span class="value" id="ee-slippage">--</span></div>
            <div class="order-preview-row"><span class="label">Commission</span><span class="value" id="ee-commission">--</span></div>
            <div class="order-preview-row"><span class="label">Borrow / Day</span><span class="value" id="ee-borrow">--</span></div>
            <div class="order-preview-row"><span class="label">Total Cost</span><span class="value" id="ee-total">--</span></div>
            <div class="order-preview-row"><span class="label">Quality</span><span class="value" id="ee-quality">--</span></div>
          </div>
          <button class="order-submit-btn ${this.orderSide === 'buy' ? 'buy-btn' : 'sell-btn'}" id="order-submit">
            ${this.orderSide === 'buy' ? '🟢 BUY' : '🔴 SELL'} ${this.selectedTicker}
          </button>
          ${pos ? `<button class="order-close-position-btn" id="close-pos-btn" onclick="Terminal.closePosition('${pos.ticker}', ${Math.abs(pos.qty)}, ${pos.qty < 0 ? "'buy'" : "'sell'"})">
            ✕ Close Entire Position (${Math.abs(pos.qty)} shares)
          </button>` : ''}
        </div>
        <div class="order-quick-info" id="order-quick-info">
          <div class="order-quick-row"><span>Bid</span><span class="val price-up" id="qi-bid">--</span></div>
          <div class="order-quick-row"><span>Ask</span><span class="val price-down" id="qi-ask">--</span></div>
          <div class="order-quick-row"><span>Spread</span><span class="val" id="qi-spread">--</span></div>
          <div class="order-quick-row"><span>Volatility</span><span class="val" id="qi-vol">--</span></div>
          <div class="order-quick-row"><span>Max Buy Qty</span><span class="val" id="qi-max">${maxQty}</span></div>
        </div>
      </div>
    `;
  },

  renderBottomPanel() {
    return `
      <div class="bottom-panel">
        <div class="bottom-tabs">
          <button class="bottom-tab ${this._bottomTab === 'positions' ? 'active' : ''}" data-tab="positions">Positions</button>
          <button class="bottom-tab ${this._bottomTab === 'orders' ? 'active' : ''}" data-tab="orders">Open Orders</button>
          <button class="bottom-tab ${this._bottomTab === 'trades' ? 'active' : ''}" data-tab="trades">Trade History</button>
        </div>
        <div class="bottom-content" id="bottom-content">
          ${this.renderBottomContent()}
        </div>
      </div>
    `;
  },

  renderBottomContent() {
    switch (this._bottomTab) {
      case 'positions': return this.renderPositions();
      case 'orders': return this.renderOpenOrders();
      case 'trades': return this.renderTradeHistory();
      default: return '';
    }
  },

  renderPositions() {
    if (this.positions.length === 0) {
      return `<div class="empty-state"><span class="empty-icon">📭</span><span class="empty-text">No open positions</span></div>`;
    }
    let html = `<table class="data-table"><thead><tr>
      <th>Ticker</th><th>Qty</th><th>Avg Cost</th><th>Price</th><th>Mkt Value</th><th>P&L</th><th>P&L %</th><th>Action</th>
    </tr></thead><tbody>`;
    for (const p of this.positions) {
      const colorCls = Utils.colorClass(p.unrealizedPnl);
      html += `<tr>
        <td style="font-weight:700">${p.ticker}</td>
        <td>${p.qty}</td>
        <td>${Utils.num(p.avg_cost)}</td>
        <td>${Utils.num(p.currentPrice)}</td>
        <td>${Utils.money(p.marketValue)}</td>
        <td class="${colorCls}">${Utils.money(p.unrealizedPnl)}</td>
        <td class="${colorCls}">${Utils.pct(p.pnlPct)}</td>
        <td><button class="action-btn" onclick="Terminal.closePosition('${p.ticker}', ${Math.abs(p.qty)}, ${p.qty < 0 ? "'buy'" : "'sell'"})">Close</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    return html;
  },

  renderOpenOrders() {
    if (this.openOrders.length === 0) {
      return `<div class="empty-state"><span class="empty-icon">📋</span><span class="empty-text">No open orders</span></div>`;
    }
    let html = `<table class="data-table"><thead><tr>
      <th>Time</th><th>Ticker</th><th>Type</th><th>Side</th><th>Qty</th><th>Limit</th><th>Stop</th><th>Status</th><th>Action</th>
    </tr></thead><tbody>`;
    for (const o of this.openOrders) {
      html += `<tr>
        <td>${Utils.formatTime(o.created_at)}</td>
        <td style="font-weight:700">${o.ticker}</td>
        <td>${o.type}</td>
        <td class="${o.side === 'buy' ? 'price-up' : 'price-down'}" style="font-weight:700">${o.side.toUpperCase()}</td>
        <td>${o.qty}</td>
        <td>${o.limit_price ? Utils.num(o.limit_price) : '--'}</td>
        <td>${o.stop_price ? Utils.num(o.stop_price) : '--'}</td>
        <td>${o.status}</td>
        <td><button class="action-btn" onclick="Terminal.cancelOrder('${o.id}')">Cancel</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    return html;
  },

  renderTradeHistory() {
    if (this.trades.length === 0) {
      return `<div class="empty-state"><span class="empty-icon">📊</span><span class="empty-text">No trades yet</span></div>`;
    }
    let html = `<table class="data-table"><thead><tr>
      <th>Time</th><th>Ticker</th><th>Side</th><th>Qty</th><th>Price</th><th>Slip</th><th>Comm</th><th>Borrow</th><th>Net</th><th>Regime</th>
    </tr></thead><tbody>`;
    for (const t of this.trades) {
      const colorCls = Utils.colorClass(t.pnl);
      html += `<tr>
        <td>${Utils.formatTime(t.executed_at)}</td>
        <td style="font-weight:700">${t.ticker}</td>
        <td class="${t.side === 'buy' ? 'price-up' : 'price-down'}" style="font-weight:700">${t.side.toUpperCase()}</td>
        <td>${t.qty}</td>
        <td>${Utils.num(t.price)}</td>
        <td>${Number(t.slippage_bps || 0).toFixed(2)} bps</td>
        <td>${Utils.money(t.commission || 0)}</td>
        <td>${Utils.money(t.borrow_cost || 0)}</td>
        <td class="${colorCls}">${Utils.money(t.pnl)}</td>
        <td>${t.regime || '—'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    return html;
  },

  bindEvents() {
    // Watchlist click
    document.querySelectorAll('.watchlist-item').forEach(el => {
      el.addEventListener('click', () => this.selectTicker(el.dataset.ticker));
    });

    // Watchlist search
    const searchInput = document.getElementById('watchlist-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this._watchlistFilter = e.target.value.toLowerCase();
        document.querySelectorAll('.watchlist-item').forEach(el => {
          const ticker = el.dataset.ticker.toLowerCase();
          const name = (this.tickers[el.dataset.ticker]?.name || '').toLowerCase();
          const match = ticker.includes(this._watchlistFilter) || name.includes(this._watchlistFilter);
          el.style.display = match ? '' : 'none';
        });
      });
    }

    // Timeframes
    document.getElementById('chart-timeframes')?.addEventListener('click', (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      if (!button.dataset.interval) return;
      document.querySelectorAll('#chart-timeframes button[data-interval]').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      ChartManager.changeInterval(button.dataset.interval);
    });

    // Order side tabs
    document.querySelectorAll('.order-side-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.orderSide = tab.dataset.side;
        document.querySelectorAll('.order-side-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const btn = document.getElementById('order-submit');
        if (btn) {
          btn.className = `order-submit-btn ${this.orderSide === 'buy' ? 'buy-btn' : 'sell-btn'}`;
          btn.textContent = `${this.orderSide === 'buy' ? '🟢 BUY' : '🔴 SELL'} ${this.selectedTicker}`;
        }
        this.updateOrderPreview();
      });
    });

    // Order type change — show/hide price inputs + update hint
    const orderType = document.getElementById('order-type');
    if (orderType) {
      orderType.addEventListener('change', () => this.updateOrderForm());
    }

    // Qty change — update preview
    const qtyInput = document.getElementById('order-qty');
    if (qtyInput) {
      qtyInput.addEventListener('input', () => this.updateOrderPreview());
    }

    // Limit price change — update preview
    document.getElementById('order-limit-price')?.addEventListener('input', () => this.updateOrderPreview());
    document.getElementById('order-stop-price')?.addEventListener('input', () => this.updateOrderPreview());

    // Quick quantity % buttons
    document.getElementById('order-qty-presets')?.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const pct = parseFloat(e.target.dataset.pct) / 100;
      const t = this.priceCache[this.selectedTicker] || this.tickers[this.selectedTicker] || {};
      const price = t.price || t.ask || 1;
      const cash = Utils.toNumber(App.user?.cash, 0);
      const maxQty = Math.floor(cash / price);
      const qty = Math.max(1, Math.floor(maxQty * pct));
      const qtyEl = document.getElementById('order-qty');
      if (qtyEl) { qtyEl.value = qty; this.updateOrderPreview(); }
    });

    // Limit price offset buttons
    document.getElementById('limit-presets')?.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const offset = parseFloat(e.target.dataset.offset) / 100;
      const t = this.priceCache[this.selectedTicker] || this.tickers[this.selectedTicker] || {};
      const price = t.price || 0;
      const newPrice = +(price * (1 + offset)).toFixed(2);
      const el = document.getElementById('order-limit-price');
      if (el) { el.value = newPrice; this.updateOrderPreview(); }
    });

    // Stop price offset buttons
    document.getElementById('stop-presets')?.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const offset = parseFloat(e.target.dataset.offset) / 100;
      const t = this.priceCache[this.selectedTicker] || this.tickers[this.selectedTicker] || {};
      const price = t.price || 0;
      const newPrice = +(price * (1 + offset)).toFixed(2);
      const el = document.getElementById('order-stop-price');
      if (el) { el.value = newPrice; this.updateOrderPreview(); }
    });

    // Submit order
    const submitBtn = document.getElementById('order-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.submitOrder());
    }

    // Bottom tabs
    document.querySelectorAll('.bottom-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._bottomTab = tab.dataset.tab;
        document.querySelectorAll('.bottom-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const content = document.getElementById('bottom-content');
        if (content) content.innerHTML = this.renderBottomContent();
      });
    });

    // Header nav links
    document.querySelectorAll('.header-nav a').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const hash = link.getAttribute('href');
        window.location.hash = hash;
      });
    });
  },

  selectTicker(ticker) {
    this.selectedTicker = ticker;
    // Update watchlist active state
    document.querySelectorAll('.watchlist-item').forEach(el => {
      el.classList.toggle('active', el.dataset.ticker === ticker);
    });
    // Update chart
    ChartManager.loadTicker(ticker);
    // Update chart header
    this.updateChartHeader(ticker);
    // Update order panel
    this.updateOrderPanel(ticker);
    // Update order book header
    const obHeader = document.querySelector('.orderbook-header span');
    if (obHeader) obHeader.textContent = `Order Book — ${ticker}`;
  },

  updateChartHeader(ticker) {
    const t = this.priceCache[ticker] || this.tickers[ticker] || {};
    const el = (id) => document.getElementById(id);
    const colorCls = Utils.colorClass(t.change || t.changePct || 0);

    if (el('chart-ticker')) el('chart-ticker').textContent = ticker;
    if (el('chart-price')) { el('chart-price').textContent = Utils.num(t.price || 0); el('chart-price').className = 'chart-ticker-price ' + colorCls; }
    if (el('chart-change')) {
      el('chart-change').textContent = `${Utils.change(t.change || 0)} (${Utils.pct(t.changePct || 0)})`;
      el('chart-change').className = 'chart-ticker-change ' + colorCls;
    }
    if (el('cm-open')) el('cm-open').textContent = Utils.num(t.open || t.price || 0);
    if (el('cm-high')) el('cm-high').textContent = Utils.num(t.high || t.price || 0);
    if (el('cm-low')) el('cm-low').textContent = Utils.num(t.low || t.price || 0);
    if (el('cm-vol')) el('cm-vol').textContent = Utils.abbrev(t.volume || 0);
  },

  updateOrderPanel(ticker) {
    const t = this.priceCache[ticker] || this.tickers[ticker] || {};
    const el = (id) => document.getElementById(id);

    if (el('preview-ticker')) el('preview-ticker').textContent = ticker;
    if (el('preview-price')) el('preview-price').textContent = Utils.num(t.price || 0);

    const panelHeader = document.querySelector('.order-panel-header');
    if (panelHeader) panelHeader.textContent = `${ticker} — Place Order`;

    const btn = document.getElementById('order-submit');
    if (btn) btn.textContent = `${this.orderSide === 'buy' ? '🟢 BUY' : '🔴 SELL'} ${ticker}`;

    this.updateOrderPreview();
    this.updateQuickInfo(t);
  },

  updateOrderForm() {
    const type = document.getElementById('order-type')?.value;
    const limitGroup = document.getElementById('limit-price-group');
    const stopGroup = document.getElementById('stop-price-group');
    const trailGroup = document.getElementById('trail-pct-group');
    const hintEl = document.getElementById('order-type-hint');

    if (limitGroup) limitGroup.style.display = ['limit', 'stop-limit'].includes(type) ? '' : 'none';
    if (stopGroup) stopGroup.style.display = ['stop', 'stop-loss', 'stop-limit', 'take-profit'].includes(type) ? '' : 'none';
    if (trailGroup) trailGroup.style.display = type === 'trailing-stop' ? '' : 'none';

    // Update hint text
    if (hintEl && this.ORDER_TYPE_INFO[type]) {
      hintEl.textContent = this.ORDER_TYPE_INFO[type].desc;
    }

    // Auto-fill price fields from market
    const t = this.priceCache[this.selectedTicker] || this.tickers[this.selectedTicker] || {};
    const price = t.price || 0;
    if (type === 'limit') {
      const el = document.getElementById('order-limit-price');
      if (el && !el.value) el.value = price.toFixed(2);
    }
    if (['stop-loss', 'stop-limit'].includes(type)) {
      const el = document.getElementById('order-stop-price');
      if (el && !el.value) el.value = (price * 0.97).toFixed(2); // default 3% below
    }
    if (type === 'take-profit') {
      const el = document.getElementById('order-stop-price');
      if (el && !el.value) el.value = (price * 1.05).toFixed(2); // default 5% above
    }

    this.updateOrderPreview();
  },

  updateOrderPreview() {
    const qty = parseFloat(document.getElementById('order-qty')?.value) || 0;
    const type = document.getElementById('order-type')?.value;
    const t = this.priceCache[this.selectedTicker] || this.tickers[this.selectedTicker] || {};
    const price = t.price || 0;
    const cash = Utils.toNumber(App.user?.cash, 0);

    // Use limit price for limit orders, otherwise market price
    let execPrice = price;
    if (type === 'limit' || type === 'stop-limit') {
      const lp = parseFloat(document.getElementById('order-limit-price')?.value);
      if (lp > 0) execPrice = lp;
    }

    const total = qty * execPrice;
    const bpAfter = this.orderSide === 'buy' ? cash - total : cash + total;

    const el = (id) => document.getElementById(id);
    if (el('preview-total')) el('preview-total').textContent = Utils.money(total);
    if (el('preview-price')) el('preview-price').textContent = Utils.num(price);
    if (el('preview-bp')) el('preview-bp').textContent = Utils.money(cash);
    if (el('preview-bp-after')) {
      el('preview-bp-after').textContent = Utils.money(bpAfter);
      el('preview-bp-after').className = `value ${bpAfter < 0 ? 'price-down' : ''}`;
    }
    if (el('qi-max')) {
      const maxQty = price > 0 ? Math.floor(cash / price) : 0;
      el('qi-max').textContent = maxQty;
    }
    this.updateExecutionEstimate({
      qty,
      execPrice,
      marketPrice: price,
      type,
      cash,
    });
  },

  updateExecutionEstimate({ qty, execPrice, marketPrice, type, cash }) {
    const def = this.tickers[this.selectedTicker] || {};
    const tick = this.priceCache[this.selectedTicker] || def || {};
    const el = (id) => document.getElementById(id);

    if (!qty || qty <= 0 || !Number.isFinite(execPrice) || execPrice <= 0) {
      this.executionEstimate = null;
      if (el('ee-regime')) el('ee-regime').textContent = '--';
      if (el('ee-slippage')) el('ee-slippage').textContent = '--';
      if (el('ee-commission')) el('ee-commission').textContent = '--';
      if (el('ee-borrow')) el('ee-borrow').textContent = '--';
      if (el('ee-total')) el('ee-total').textContent = '--';
      if (el('ee-quality')) el('ee-quality').textContent = '--';
      return;
    }

    const mid = tick.bid && tick.ask
      ? (Number(tick.bid) + Number(tick.ask)) / 2
      : (Number(marketPrice || execPrice) || execPrice);
    const orderNotional = qty * execPrice;
    const addv = Math.max(1, Number(def.avg_daily_dollar_volume || 1_000_000_000));
    const baseSpreadBps = Number(def.base_spread_bps || def.spread_bps || 2);
    const impactCoeff = Number(def.impact_coeff || 60);
    const volatility = Math.max(0, Number(tick.volatility || 0));
    const volatilityMult = Math.max(0.85, Math.min(4, 1 + (volatility * 25)));
    const regimeName = String(tick.regime || def.regime || 'normal');
    const regimeMult = regimeName === 'event_shock'
      ? { liq: 2.1, borrow: 1.5 }
      : regimeName === 'high_volatility'
        ? { liq: 1.2, borrow: 1.25 }
        : regimeName === 'tight_liquidity'
          ? { liq: 1.45, borrow: 1.2 }
          : { liq: 1.0, borrow: 1.0 };
    const impactBps = baseSpreadBps + (impactCoeff * ((orderNotional / addv) ** 0.6) * regimeMult.liq * volatilityMult);
    const direction = this.orderSide === 'sell' ? -1 : 1;
    const estFillPrice = execPrice * (1 + ((impactBps / 10000) * direction));
    const slippageCost = this.orderSide === 'buy'
      ? Math.max(0, (estFillPrice - mid) * qty)
      : Math.max(0, (mid - estFillPrice) * qty);
    const commissionBps = Number(def.commission_bps || 1);
    const commissionMin = Number(def.commission_min_usd || 0.01);
    const commission = Math.max(commissionMin, orderNotional * (commissionBps / 10000));
    const currentPosition = this.positions.find((p) => p.ticker === this.selectedTicker);
    const longInventory = Math.max(0, Number(currentPosition?.qty || 0));
    const opensShortQty = this.orderSide === 'sell' ? Math.max(0, qty - longInventory) : 0;
    const borrowApr = Number(def.borrow_apr_short || 0);
    const borrowDay = opensShortQty > 0
      ? (opensShortQty * estFillPrice) * ((borrowApr * regimeMult.borrow) / 365)
      : 0;
    const totalCost = slippageCost + commission + borrowDay;
    const commissionCostBps = orderNotional > 0 ? (commission / orderNotional) * 10000 : 0;
    const borrowCostBps = orderNotional > 0 ? (borrowDay / orderNotional) * 10000 : 0;
    const quality = Math.max(0, Math.min(100, 100 - ((impactBps * 0.6) + (commissionCostBps * 0.3) + (borrowCostBps * 0.1))));

    this.executionEstimate = {
      est_slippage_bps: impactBps,
      est_slippage_cost: slippageCost,
      est_commission: commission,
      est_borrow_day: borrowDay,
      est_total_cost: totalCost,
      est_execution_quality_score: quality,
      regime: regimeName,
      est_fill_price: estFillPrice,
    };

    if (el('ee-regime')) el('ee-regime').textContent = regimeName;
    if (el('ee-slippage')) el('ee-slippage').textContent = `${impactBps.toFixed(2)} bps (${Utils.money(slippageCost)})`;
    if (el('ee-commission')) el('ee-commission').textContent = Utils.money(commission);
    if (el('ee-borrow')) el('ee-borrow').textContent = Utils.money(borrowDay);
    if (el('ee-total')) el('ee-total').textContent = Utils.money(totalCost);
    if (el('ee-quality')) el('ee-quality').textContent = `${quality.toFixed(1)}/100`;

    const bpAfter = this.orderSide === 'buy'
      ? cash - (orderNotional + totalCost)
      : cash + (orderNotional - totalCost);
    if (el('preview-bp-after')) {
      el('preview-bp-after').textContent = Utils.money(bpAfter);
      el('preview-bp-after').className = `value ${bpAfter < 0 ? 'price-down' : ''}`;
    }
  },

  updateQuickInfo(tick) {
    const el = (id) => document.getElementById(id);
    if (el('qi-bid')) el('qi-bid').textContent = Utils.num(tick.bid || 0);
    if (el('qi-ask')) el('qi-ask').textContent = Utils.num(tick.ask || 0);
    if (el('qi-spread') && tick.bid && tick.ask) el('qi-spread').textContent = Utils.num(tick.ask - tick.bid);
    if (el('qi-vol')) el('qi-vol').textContent = tick.volatility ? (tick.volatility * 100).toFixed(2) + '%' : '--';
  },

  async submitOrder() {
    const type = document.getElementById('order-type')?.value;
    const qty = parseFloat(document.getElementById('order-qty')?.value);
    const limitPrice = parseFloat(document.getElementById('order-limit-price')?.value) || undefined;
    const stopPrice = parseFloat(document.getElementById('order-stop-price')?.value) || undefined;
    const trailPct = parseFloat(document.getElementById('order-trail-pct')?.value) || undefined;

    if (!qty || qty <= 0) {
      Utils.showToast('error', 'Invalid Order', 'Quantity must be positive');
      return;
    }

    try {
      const result = await Utils.post('/orders', {
        ticker: this.selectedTicker,
        type,
        side: this.orderSide,
        qty,
        limitPrice,
        stopPrice,
        trailPct,
      });

      Utils.showToast('info', 'Order Placed',
        `${this.orderSide.toUpperCase()} ${qty} ${this.selectedTicker} (${type}) · Est Cost ${Utils.money(result?.estimated_execution?.est_total_cost || 0)}`);

      this.loadPortfolioData();
    } catch (e) {
      Utils.showToast('error', 'Order Failed', e.message);
    }
  },

  async cancelOrder(orderId) {
    try {
      await Utils.del('/orders/' + orderId);
      Utils.showToast('info', 'Order Cancelled', 'Order has been cancelled');
      this.loadPortfolioData();
    } catch (e) {
      Utils.showToast('error', 'Cancel Failed', e.message);
    }
  },

  async closePosition(ticker, qty, side) {
    try {
      await Utils.post('/orders', { ticker, type: 'market', side, qty });
      Utils.showToast('info', 'Position Closed', `Closing ${qty} ${ticker}`);
      this.loadPortfolioData();
    } catch (e) {
      Utils.showToast('error', 'Close Failed', e.message);
    }
  },

  async loadPortfolioData() {
    try {
      const [positions, orders, trades] = await Promise.all([
        Utils.get('/positions'),
        Utils.get('/orders'),
        Utils.get('/trades?limit=50'),
      ]);
      this.positions = positions;
      this.openOrders = orders;
      this.trades = trades;

      const content = document.getElementById('bottom-content');
      if (content) content.innerHTML = this.renderBottomContent();

      // Update cash
      const user = await Utils.get('/me');
      if (user) {
        App.user = user;
        Utils.syncHeaderBalance(user.cash);
      }
    } catch (e) { /* silent */ }
  },

  // ─── Real-time tick updates (HOT PATH) ────────────────────────────────────
  onTicks: Utils.throttle(function (ticks) {
    for (const tick of ticks) {
      Terminal.priceCache[tick.ticker] = tick;

      // Update watchlist
      const priceEl = document.getElementById('wp-' + tick.ticker);
      const changeEl = document.getElementById('wc-' + tick.ticker);

      if (priceEl) {
        const oldText = priceEl.textContent;
        const newText = Utils.num(tick.price);
        if (oldText !== newText) {
          priceEl.textContent = newText;
        }
      }
      if (changeEl) {
        changeEl.textContent = Utils.pct(tick.changePct);
        changeEl.className = 'wi-change ' + Utils.colorClass(tick.changePct);
      }

      // Update chart header for selected ticker
      if (tick.ticker === Terminal.selectedTicker) {
        Terminal.updateChartHeader(tick.ticker);
        Terminal.updateQuickInfo(tick);
        Terminal.updateOrderPreview();
      }
    }

    // Update positions P&L
    if (Terminal.positions.length > 0 && Terminal._bottomTab === 'positions') {
      let needsUpdate = false;
      for (const p of Terminal.positions) {
        const tick = Terminal.priceCache[p.ticker];
        if (tick) {
          p.currentPrice = tick.price;
          p.marketValue = p.qty * tick.price;
          p.unrealizedPnl = p.marketValue - p.qty * p.avg_cost;
          p.pnlPct = p.avg_cost ? ((tick.price - p.avg_cost) / p.avg_cost) * 100 : 0;
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        const content = document.getElementById('bottom-content');
        if (content) content.innerHTML = Terminal.renderPositions();
      }
    }
  }, 250), // Throttle to 4fps for DOM updates — chart updates at full speed via Lightweight Charts

  onOrderBook(book) {
    if (book.ticker !== this.selectedTicker) return;

    const asksEl = document.getElementById('ob-asks');
    const bidsEl = document.getElementById('ob-bids');
    const lastEl = document.getElementById('ob-last');
    const spreadEl = document.getElementById('ob-spread');

    if (!asksEl || !bidsEl) return;

    const maxQty = Math.max(
      ...book.asks.map(a => a.qty),
      ...book.bids.map(b => b.qty),
      1
    );

    // Asks (reversed — lowest ask at bottom)
    const asks = [...book.asks].reverse().slice(0, 5);
    asksEl.innerHTML = asks.map(a => `
      <div class="ob-row ask">
        <span class="ob-price">${Utils.num(a.price)}</span>
        <span class="ob-qty">${Utils.abbrev(a.qty)}</span>
        <span class="ob-depth"><div class="ob-depth-bar" style="width:${(a.qty / maxQty * 100).toFixed(0)}%"></div></span>
      </div>
    `).join('');

    // Bids
    const bids = book.bids.slice(0, 5);
    bidsEl.innerHTML = bids.map(b => `
      <div class="ob-row bid">
        <span class="ob-price">${Utils.num(b.price)}</span>
        <span class="ob-qty">${Utils.abbrev(b.qty)}</span>
        <span class="ob-depth"><div class="ob-depth-bar" style="width:${(b.qty / maxQty * 100).toFixed(0)}%"></div></span>
      </div>
    `).join('');

    if (lastEl && book.mid) lastEl.textContent = Utils.num(book.mid);
    if (spreadEl && book.spread !== undefined) spreadEl.textContent = `Spread: ${book.spread.toFixed(2)}`;
  },

  onPortfolioUpdate(data) {
    if (data.cash !== undefined) {
      Utils.syncHeaderBalance(data.cash);
    }
  },

  startClock() {
    const update = () => {
      const el = document.getElementById('header-clock');
      if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
    };
    update();
    this._clockInterval = setInterval(update, 1000);
  },

  destroy() {
    if (this._clockInterval) clearInterval(this._clockInterval);
    ChartManager.destroy();
    Utils.off('ticks', this.onTicks);
    Utils.off('orderbook', this.onOrderBook);
    Utils.off('portfolio:update', this.onPortfolioUpdate);
  }
};

window.Terminal = Terminal;

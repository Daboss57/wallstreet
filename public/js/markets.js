/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Markets Page
   ═══════════════════════════════════════════════════════════════════════════════ */

const Markets = {
    tickers: {},
    filter: 'all',
    currentRegime: 'normal',

    async render(container) {
        try { this.tickers = await Utils.get('/tickers'); } catch (e) { console.error(e); }
        const firstTicker = Object.values(this.tickers)[0];
        this.currentRegime = firstTicker?.regime || 'normal';

        const classes = ['all', ...new Set(Object.values(this.tickers).map(t => t.class))];

        container.innerHTML = `
      <div class="terminal-layout">
        ${Terminal.renderHeader()}
        <div class="markets-page" id="markets-page">
          <h1>📈 Markets</h1>
          <p class="page-subtitle">All instruments at a glance. Click to trade.</p>
          <div class="portfolio-stat-card" style="margin-bottom:12px;max-width:320px">
            <div class="psc-label">Market Regime</div>
            <div class="psc-value">${this.currentRegime.replace('_', ' ')}</div>
            <div class="psc-sub text-muted">Execution conditions adapt by regime</div>
          </div>
          <div class="markets-filters" id="markets-filters">
            ${classes.map(c => `<button class="markets-filter-btn ${c === this.filter ? 'active' : ''}" data-filter="${c}">${c === 'all' ? 'All' : c + 's'}</button>`).join('')}
          </div>
          <div class="markets-grid" id="markets-grid">
            ${this.renderGrid()}
          </div>
        </div>
      </div>
    `;

        Terminal.startClock();
        this.bindEvents();

        Utils.on('ticks', this._onTicks);
    },

    renderGrid() {
        let items = Object.entries(this.tickers);
        if (this.filter !== 'all') {
            items = items.filter(([, def]) => def.class === this.filter);
        }

        return items.map(([ticker, def]) => {
            const change = def.changePct || 0;
            const colorCls = Utils.colorClass(change);
            return `
        <div class="market-card" data-ticker="${ticker}">
          <div class="market-card-header">
            <span class="mc-ticker">${ticker}</span>
            <span class="mc-class">${def.class}</span>
          </div>
          <div class="mc-name">${def.name} · ${def.sector || ''}</div>
          <div class="mc-price-row">
            <span class="mc-price" id="mp-${ticker}">${def.price ? Utils.num(def.price) : '--'}</span>
            <span class="mc-change ${colorCls}" id="mc-${ticker}">${Utils.pct(change)}</span>
          </div>
          <div class="mc-meta">
            <span>Vol: ${Utils.abbrev(def.volume || 0)}</span>
            <span>Spread: ${Utils.num(def.spread_bps || 0, 2)} bps</span>
            <span>Liq: ${Math.round(def.liquidity_score || 0)}/100</span>
            <span>Borrow: ${Utils.num((Number(def.borrow_apr_short || 0) * 100), 2)}%</span>
          </div>
        </div>`;
        }).join('');
    },

    bindEvents() {
        document.getElementById('markets-filters')?.addEventListener('click', (e) => {
            if (!e.target.classList.contains('markets-filter-btn')) return;
            this.filter = e.target.dataset.filter;
            document.querySelectorAll('.markets-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById('markets-grid').innerHTML = this.renderGrid();
            // Re-bind card clicks
            this.bindCardClicks();
        });
        this.bindCardClicks();
    },

    bindCardClicks() {
        document.querySelectorAll('.market-card').forEach(card => {
            card.addEventListener('click', () => {
                Terminal.selectedTicker = card.dataset.ticker;
                window.location.hash = '#/terminal';
            });
        });
    },

    _onTicks: Utils.throttle(function (ticks) {
        for (const tick of ticks) {
            const priceEl = document.getElementById('mp-' + tick.ticker);
            const changeEl = document.getElementById('mc-' + tick.ticker);
            if (priceEl) priceEl.textContent = Utils.num(tick.price);
            if (changeEl) {
                changeEl.textContent = Utils.pct(tick.changePct);
                changeEl.className = 'mc-change ' + Utils.colorClass(tick.changePct);
            }
            if (tick.regime) Markets.currentRegime = tick.regime;
        }
        const regimeCard = document.querySelector('.markets-page .portfolio-stat-card .psc-value');
        if (regimeCard) {
            regimeCard.textContent = String(Markets.currentRegime || 'normal').replace('_', ' ');
        }
    }, 500),

    destroy() {
        if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
        Utils.off('ticks', this._onTicks);
    }
};

window.Markets = Markets;

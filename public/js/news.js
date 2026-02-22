/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — News Feed Page
   ═══════════════════════════════════════════════════════════════════════════════ */

const News = {
    events: [],

    async render(container) {
        try { this.events = await Utils.get('/news?limit=100'); } catch (e) { console.error(e); }

        container.innerHTML = `
      <div class="terminal-layout">
        ${Terminal.renderHeader()}
        <div class="news-page">
          <h1>📰 Market News</h1>
          <div id="news-list">
            ${this.renderEvents()}
          </div>
          ${this.events.length === 0 ? `
            <div class="empty-state" style="padding:60px">
              <span class="empty-icon">📰</span>
              <span class="empty-text">No news events yet. Market news will appear here as events fire.</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;

        Terminal.startClock();

        // Listen for live news
        Utils.on('news:live', (event) => {
            this.events.unshift(event);
            const list = document.getElementById('news-list');
            if (list) {
                list.innerHTML = this.renderEvents();
            }
        });
    },

    renderEvents() {
        return this.events.map(event => {
            const colorCls = event.price_impact >= 0 ? 'price-up' : 'price-down';
            const isLiquidityShock = Boolean(event.liquidity_shock) || String(event.type || '').toLowerCase().includes('liquidity');
            return `
        <div class="news-card">
          <div class="news-card-header">
            <span class="news-severity ${event.severity || 'normal'}">${event.severity === 'high' ? '🔴 BREAKING' : '🔵 News'}</span>
            <span class="news-time">${Utils.timeAgo(event.fired_at)}</span>
            <span class="news-ticker-badge">${event.ticker || 'MARKET'}</span>
            ${isLiquidityShock ? `<span class="news-ticker-badge" style="background:rgba(239,68,68,.2);color:#fca5a5">Liquidity Shock</span>` : ''}
            ${event.regime ? `<span class="news-ticker-badge" style="background:rgba(59,130,246,.2);color:#93c5fd">${event.regime}</span>` : ''}
          </div>
          <h3>${event.headline}</h3>
          <p>${event.body || ''}</p>
          <span class="news-impact ${colorCls}">
            Impact: ${event.price_impact >= 0 ? '+' : ''}${event.price_impact}%
          </span>
        </div>
      `;
        }).join('');
    },

    destroy() {
        if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
        Utils.off('news:live');
    }
};

window.News = News;

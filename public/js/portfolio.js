/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Portfolio Dashboard
   ═══════════════════════════════════════════════════════════════════════════════ */

const Portfolio = {
    stats: null,

    async render(container) {
        try { this.stats = await Utils.get('/portfolio/stats'); } catch (e) { console.error(e); }
        const s = this.stats || {};

        container.innerHTML = `
      <div class="terminal-layout">
        ${Terminal.renderHeader()}
        <div class="portfolio-page">
          <h1>💼 Portfolio Dashboard</h1>

            <div class="portfolio-summary">
            <div class="portfolio-stat-card">
              <div class="psc-label">Total Portfolio Value</div>
              <div class="psc-value">${Utils.money(s.totalValue ?? 100000)}</div>
              <div class="psc-sub ${Utils.colorClass(s.allTimeReturn || 0)}">${Utils.pct(s.allTimeReturn || 0)} all-time</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Cash Available</div>
              <div class="psc-value">${Utils.money(s.cash || 0)}</div>
              <div class="psc-sub text-muted">${s.totalValue ? ((s.cash / s.totalValue) * 100).toFixed(0) : 100}% allocation</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Positions Value</div>
              <div class="psc-value">${Utils.money(s.positionsValue || 0)}</div>
              <div class="psc-sub text-muted">${s.totalValue ? ((s.positionsValue / s.totalValue) * 100).toFixed(0) : 0}% invested</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Total Trades</div>
              <div class="psc-value" style="color:var(--accent)">${s.totalTrades || 0}</div>
              <div class="psc-sub text-muted">Win rate: ${s.winRate || 0}%</div>
            </div>
          </div>

          <div class="portfolio-analytics">
            <div class="portfolio-stat-card">
              <div class="psc-label">Avg Win</div>
              <div class="psc-value price-up">${Utils.money(s.avgWin || 0)}</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Avg Loss</div>
              <div class="psc-value price-down">${Utils.money(s.avgLoss || 0)}</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Most Traded</div>
              <div class="psc-value" style="font-size:1.2rem">${s.mostTraded ? `${s.mostTraded.ticker} (${s.mostTraded.count}x)` : '--'}</div>
            </div>
          </div>

          ${s.bestTrade || s.worstTrade ? `
          <div style="margin-top:24px;">
            <div class="portfolio-analytics">
              ${s.bestTrade ? `
              <div class="portfolio-stat-card" style="border-color: rgba(34,197,94,0.3)">
                <div class="psc-label">🏆 Best Trade</div>
                <div class="psc-value price-up">${Utils.money(s.bestTrade.pnl)}</div>
                <div class="psc-sub text-muted">${s.bestTrade.ticker} · ${s.bestTrade.qty} shares @ ${Utils.num(s.bestTrade.price)}</div>
              </div>` : ''}
              ${s.worstTrade ? `
              <div class="portfolio-stat-card" style="border-color: rgba(239,68,68,0.3)">
                <div class="psc-label">💀 Worst Trade</div>
                <div class="psc-value price-down">${Utils.money(s.worstTrade.pnl)}</div>
                <div class="psc-sub text-muted">${s.worstTrade.ticker} · ${s.worstTrade.qty} shares @ ${Utils.num(s.worstTrade.price)}</div>
              </div>` : ''}
            </div>
          </div>` : ''}

          <div class="portfolio-positions" style="margin-top:24px;">
            <h3>Current Positions</h3>
            ${await this.renderPositions()}
          </div>
        </div>
      </div>
    `;

        Terminal.startClock();
    },

    async renderPositions() {
        try {
            const positions = await Utils.get('/positions');
            if (positions.length === 0) {
                return `<div class="empty-state" style="padding:24px"><span class="empty-icon">📭</span><span class="empty-text">No open positions. Start trading to see your portfolio here.</span></div>`;
            }

            let html = `<table class="data-table" style="margin-top:12px"><thead><tr>
        <th>Ticker</th><th>Qty</th><th>Avg Cost</th><th>Price</th><th>Mkt Value</th><th>P&L</th><th>P&L %</th>
      </tr></thead><tbody>`;
            for (const p of positions) {
                const colorCls = Utils.colorClass(p.unrealizedPnl);
                html += `<tr>
          <td style="font-weight:700">${p.ticker}</td>
          <td>${p.qty}</td>
          <td>${Utils.num(p.avg_cost)}</td>
          <td>${Utils.num(p.currentPrice)}</td>
          <td>${Utils.money(p.marketValue)}</td>
          <td class="${colorCls}">${Utils.money(p.unrealizedPnl)}</td>
          <td class="${colorCls}">${Utils.pct(p.pnlPct)}</td>
        </tr>`;
            }
            html += '</tbody></table>';
            return html;
        } catch (e) {
            return `<div class="empty-state"><span class="empty-text">Error loading positions</span></div>`;
        }
    },

    destroy() {
        if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
    }
};

window.Portfolio = Portfolio;

/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Portfolio Dashboard
   ═══════════════════════════════════════════════════════════════════════════════ */

const Portfolio = {
    stats: null,

    async render(container) {
        try { this.stats = await Utils.get('/portfolio/stats'); } catch (e) { console.error(e); }
        const s = this.stats || {};
        const cash = Utils.toNumber(s.cash, 0);
        const positionsValue = Utils.toNumber(s.positionsValue, 0);
        const totalValue = Utils.toNumber(s.totalValue, cash + positionsValue);
        const allTimeReturn = Utils.toNumber(s.allTimeReturn, 0);
        const grossReturn = Utils.toNumber(s.gross_return, allTimeReturn);
        const totalTrades = Utils.toNumber(s.totalTrades, 0);
        const winRate = Utils.toNumber(s.winRate, 0);
        const netWinRate = Utils.toNumber(s.net_win_rate, winRate);
        const grossPnl = Utils.toNumber(s.gross_pnl, 0);
        const netPnl = Utils.toNumber(s.net_pnl, 0);
        const totalSlippageCost = Utils.toNumber(s.total_slippage_cost, 0);
        const totalCommission = Utils.toNumber(s.total_commission, 0);
        const totalBorrowCost = Utils.toNumber(s.total_borrow_cost, 0);
        const totalExecutionCost = Utils.toNumber(s.total_execution_cost, totalSlippageCost + totalCommission + totalBorrowCost);
        const costDragPct = Utils.toNumber(s.cost_drag_pct, 0);
        const safeCostBase = Math.max(0.0001, totalExecutionCost);

        container.innerHTML = `
      <div class="terminal-layout">
        ${Terminal.renderHeader()}
        <div class="portfolio-page">
          <h1>💼 Portfolio Dashboard</h1>

            <div class="portfolio-summary">
            <div class="portfolio-stat-card">
              <div class="psc-label">Total Portfolio Value</div>
              <div class="psc-value">${Utils.money(totalValue)}</div>
              <div class="psc-sub ${Utils.colorClass(allTimeReturn)}">Net ${Utils.pct(allTimeReturn)} | Gross ${Utils.pct(grossReturn)}</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Gross P&L</div>
              <div class="psc-value ${Utils.colorClass(grossPnl)}">${Utils.money(grossPnl)}</div>
              <div class="psc-sub text-muted">Before execution costs</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Net P&L</div>
              <div class="psc-value ${Utils.colorClass(netPnl)}">${Utils.money(netPnl)}</div>
              <div class="psc-sub text-muted">After execution costs</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Cost Drag</div>
              <div class="psc-value">${Utils.num(costDragPct, 2)}%</div>
              <div class="psc-sub text-muted">${Utils.money(totalExecutionCost)} total execution cost</div>
            </div>
          </div>

          <div class="portfolio-analytics">
            <div class="portfolio-stat-card">
              <div class="psc-label">Slippage Cost</div>
              <div class="psc-value price-down">${Utils.money(totalSlippageCost)}</div>
              <div class="psc-sub text-muted">${Utils.num((totalSlippageCost / safeCostBase) * 100, 1)}% of cost stack</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Commission Cost</div>
              <div class="psc-value price-down">${Utils.money(totalCommission)}</div>
              <div class="psc-sub text-muted">${Utils.num((totalCommission / safeCostBase) * 100, 1)}% of cost stack</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Borrow Cost</div>
              <div class="psc-value price-down">${Utils.money(totalBorrowCost)}</div>
              <div class="psc-sub text-muted">${Utils.num((totalBorrowCost / safeCostBase) * 100, 1)}% of cost stack</div>
            </div>
            <div class="portfolio-stat-card">
              <div class="psc-label">Net Win Rate</div>
              <div class="psc-value">${Utils.num(netWinRate, 1)}%</div>
              <div class="psc-sub text-muted">Gross win rate ${Utils.num(winRate, 1)}%</div>
            </div>
          </div>

          <div class="portfolio-stat-card" style="margin-top:16px">
            <div class="psc-label">Execution Cost Attribution</div>
            <div style="display:flex;height:14px;border-radius:999px;overflow:hidden;background:rgba(148,163,184,0.12);margin-top:10px">
              <div title="Slippage" style="width:${((totalSlippageCost / safeCostBase) * 100).toFixed(2)}%;background:#ef4444"></div>
              <div title="Commission" style="width:${((totalCommission / safeCostBase) * 100).toFixed(2)}%;background:#f59e0b"></div>
              <div title="Borrow" style="width:${((totalBorrowCost / safeCostBase) * 100).toFixed(2)}%;background:#3b82f6"></div>
            </div>
            <div class="psc-sub text-muted" style="margin-top:8px">Slippage ${Utils.money(totalSlippageCost)} · Commission ${Utils.money(totalCommission)} · Borrow ${Utils.money(totalBorrowCost)}</div>
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

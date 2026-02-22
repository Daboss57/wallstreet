/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Leaderboard
   ═══════════════════════════════════════════════════════════════════════════════ */

const Leaderboard = {
    data: [],

    async render(container) {
        try { this.data = await Utils.get('/leaderboard'); } catch (e) { console.error(e); }

        const podium = this.data.slice(0, 3);
        const rest = this.data.slice(3);

        container.innerHTML = `
      <div class="terminal-layout">
        ${Terminal.renderHeader()}
        <div class="leaderboard-page">
          <h1>🏆 Leaderboard</h1>

          ${podium.length >= 1 ? `
          <div class="lb-podium">
            ${podium.length >= 2 ? this.renderPodiumCard(podium[1], '🥈', 'second') : ''}
            ${this.renderPodiumCard(podium[0], '🥇', 'first')}
            ${podium.length >= 3 ? this.renderPodiumCard(podium[2], '🥉', 'third') : ''}
          </div>` : ''}

          <div class="lb-table-wrapper">
            <table class="lb-table">
              <thead>
                <tr>
                  <th>Rank</th><th>Trader</th><th>Badges</th>
                  <th>Net Value</th><th>Gross/Net Return</th><th>Cost Drag</th>
                </tr>
              </thead>
              <tbody>
                ${this.data.map(entry => `
                  <tr>
                    <td class="lb-rank">${entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : '#' + entry.rank}</td>
                    <td class="lb-user">${entry.username}</td>
                    <td class="lb-badges-cell">${entry.badges.join(' ')} ${entry.execution_discipline === 'high' ? '<span class="fund-role role-analyst">Execution Discipline</span>' : ''}</td>
                    <td class="lb-mono">${Utils.money(entry.net_portfolio_value || entry.portfolioValue)}</td>
                    <td class="lb-mono">
                      <span class="${Utils.colorClass(entry.gross_return || entry.allTimeReturn)}">G ${Utils.pct(entry.gross_return || entry.allTimeReturn)}</span>
                      <span class="${Utils.colorClass(entry.net_return || entry.allTimeReturn)}" style="margin-left:8px">N ${Utils.pct(entry.net_return || entry.allTimeReturn)}</span>
                    </td>
                    <td class="lb-mono">${Utils.num(entry.cost_drag_pct || 0, 2)}%</td>
                  </tr>
                `).join('')}
                ${this.data.length === 0 ? `<tr><td colspan="6" class="text-center text-muted" style="padding:40px">No traders yet. Be the first!</td></tr>` : ''}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

        Terminal.startClock();
    },

    renderPodiumCard(entry, medal, cls) {
        return `
      <div class="lb-podium-card ${cls}">
        <div class="lb-rank-badge">${medal}</div>
        <div class="lb-username">${entry.username}</div>
        <div class="lb-value">${Utils.money(entry.net_portfolio_value || entry.portfolioValue)}</div>
        <div class="lb-return ${Utils.colorClass(entry.net_return || entry.allTimeReturn)}">Net ${Utils.pct(entry.net_return || entry.allTimeReturn)}</div>
        <div class="lb-return ${Utils.colorClass(entry.gross_return || entry.allTimeReturn)}" style="font-size:0.8rem">Gross ${Utils.pct(entry.gross_return || entry.allTimeReturn)}</div>
        <div class="lb-badges">${entry.badges.join(' ') || '—'}</div>
      </div>
    `;
    },

    destroy() {
        if (Terminal._clockInterval) clearInterval(Terminal._clockInterval);
    }
};

window.Leaderboard = Leaderboard;

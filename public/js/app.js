/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Main App (Router, Auth, Landing Page)
   ═══════════════════════════════════════════════════════════════════════════════ */

const App = {
    user: null,
    currentPage: null,

    async init() {
        // Check auth
        const token = localStorage.getItem('streetos_token');
        if (token) {
            try {
                this.user = await Utils.get('/me');
                WS.connect();
            } catch (e) {
                localStorage.removeItem('streetos_token');
                this.user = null;
            }
        }

        // Listen for auth events
        Utils.on('auth:logout', () => this.logout());

        // Router
        window.addEventListener('hashchange', () => this.route());
        this.route();
    },

    route() {
        const hash = window.location.hash || '#/';
        const container = document.getElementById('app');

        // Cleanup previous page
        if (this.currentPage?.destroy) this.currentPage.destroy();

        // Auth required for most pages
        const publicRoutes = ['#/', '#/landing'];
        if (!this.user && !publicRoutes.includes(hash)) {
            window.location.hash = '#/';
            return;
        }

        switch (hash) {
            case '#/':
            case '#/landing':
                if (this.user) {
                    window.location.hash = '#/terminal';
                    return;
                }
                this.currentPage = null;
                this.renderLanding(container);
                break;
            case '#/terminal':
                this.currentPage = Terminal;
                Terminal.render(container);
                break;
            case '#/markets':
                this.currentPage = Markets;
                Markets.render(container);
                break;
            case '#/portfolio':
                this.currentPage = Portfolio;
                Portfolio.render(container);
                break;
            case '#/leaderboard':
                this.currentPage = Leaderboard;
                Leaderboard.render(container);
                break;
            case '#/news':
                this.currentPage = News;
                News.render(container);
                break;
            case '#/funds':
                this.currentPage = Funds;
                Funds.render(container);
                break;
            default:
                window.location.hash = '#/';
        }
    },

    renderLanding(container) {
        // Fetch live ticker data for the strip
        Utils.get('/tickers').then(tickers => {
            const strip = document.getElementById('ticker-strip-inner');
            if (!strip) return;
            const items = Object.entries(tickers).map(([ticker, def]) => {
                const colorCls = Utils.colorClass(def.changePct || 0);
                return `<div class="ticker-strip-item">
          <span class="ticker-sym">${ticker}</span>
          <span class="ticker-price">${def.price ? Utils.num(def.price) : '--'}</span>
          <span class="${colorCls}">${Utils.pct(def.changePct || 0)}</span>
        </div>`;
            }).join('');
            strip.innerHTML = items + items; // Duplicate for seamless scroll
        }).catch(() => { });

        container.innerHTML = `
      <div class="landing">
        <nav class="landing-nav">
          <div class="landing-logo">
            <span class="logo-icon">🏦</span>
            <span>StreetOS</span>
          </div>
          <div class="landing-nav-links">
            <a href="#" onclick="App.showAuth('login')">Log In</a>
            <button class="btn-primary" style="padding:10px 24px; font-size:0.9rem;" onclick="App.showAuth('register')">Start Trading</button>
          </div>
        </nav>

        <section class="landing-hero">
          <h1>Master the Market.<br>Zero Risk.</h1>
          <p class="subtitle">
            Real-time trading simulator with 30+ instruments across stocks, commodities, futures, ETFs, crypto, and forex.
            Live charts. Real order books. Pure market chaos.
          </p>
          <div class="cta-group">
            <button class="btn-primary" onclick="App.showAuth('register')">Create Free Account</button>
            <button class="btn-secondary" onclick="App.showAuth('login')">Log In</button>
          </div>
        </section>

        <div class="ticker-strip">
          <div class="ticker-strip-inner" id="ticker-strip-inner">
            <div class="ticker-strip-item"><span class="ticker-sym">Loading...</span></div>
          </div>
        </div>

        <section class="landing-features">
          <div class="feature-card">
            <div class="feature-icon">⚡</div>
            <h3>Ultra Low Latency</h3>
            <p>1-second tick rate. WebSocket push. Sub-50ms updates. Charts extend live. No polling, no page refreshes.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">📊</div>
            <h3>TradingView Charts</h3>
            <p>Real candlestick charts with multiple timeframes (1m → 1D), volume histograms, and live extending candles.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">🏦</div>
            <h3>30+ Instruments</h3>
            <p>Stocks, commodities, futures, ETFs, crypto, forex. Each with unique volatility profiles and market behavior.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">📈</div>
            <h3>Full Order Types</h3>
            <p>Market, limit, stop-loss, take-profit, stop-limit, trailing stops, and OCO orders. Short selling with margin.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">📰</div>
            <h3>Live News Events</h3>
            <p>Random market-moving news fires every few minutes. Earnings, FDA approvals, geopolitical shocks, meme rallies.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">🏆</div>
            <h3>Compete & Earn Badges</h3>
            <p>Live leaderboard, trader badges (🐋 Whale, 🎯 Sniper, 🔥 Degen), and performance analytics.</p>
          </div>
        </section>

        <section class="landing-stats">
          <div class="stat-item">
            <div class="stat-value">30+</div>
            <div class="stat-label">Instruments</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">1s</div>
            <div class="stat-label">Tick Rate</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">6</div>
            <div class="stat-label">Order Types</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">$100K</div>
            <div class="stat-label">Starting Cash</div>
          </div>
        </section>
      </div>
    `;
    },

    showAuth(mode = 'register') {
        const overlay = document.createElement('div');
        overlay.className = 'auth-overlay';
        overlay.innerHTML = `
      <div class="auth-modal">
        <h2>${mode === 'register' ? 'Create Account' : 'Welcome Back'}</h2>
        <p class="auth-subtitle">${mode === 'register' ? 'Start trading with $100,000 virtual cash' : 'Log in to your trading terminal'}</p>
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="auth-username" placeholder="Choose a username" autocomplete="username">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="auth-password" placeholder="Choose a password" autocomplete="current-password">
        </div>
        <div class="auth-error" id="auth-error" style="display:none"></div>
        <button class="auth-btn" id="auth-submit">${mode === 'register' ? 'Create Account & Start Trading' : 'Log In'}</button>
        <div class="auth-toggle">
          ${mode === 'register'
                ? 'Already have an account? <a onclick="App.switchAuth(\'login\')">Log In</a>'
                : 'Need an account? <a onclick="App.switchAuth(\'register\')">Sign Up</a>'}
        </div>
      </div>
    `;

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);

        // Focus username
        setTimeout(() => document.getElementById('auth-username')?.focus(), 100);

        // Handle submit
        document.getElementById('auth-submit').addEventListener('click', () => this.handleAuth(mode));
        document.getElementById('auth-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.handleAuth(mode);
        });
    },

    switchAuth(mode) {
        document.querySelector('.auth-overlay')?.remove();
        this.showAuth(mode);
    },

    async handleAuth(mode) {
        const username = document.getElementById('auth-username')?.value;
        const password = document.getElementById('auth-password')?.value;
        const errorEl = document.getElementById('auth-error');

        try {
            const endpoint = mode === 'register' ? '/auth/register' : '/auth/login';
            const result = await Utils.post(endpoint, { username, password });

            localStorage.setItem('streetos_token', result.token);
            this.user = result.user;

            // Remove modal
            document.querySelector('.auth-overlay')?.remove();

            // Connect WebSocket
            WS.connect();

            // Navigate to terminal
            window.location.hash = '#/terminal';
        } catch (e) {
            if (errorEl) {
                errorEl.textContent = e.message;
                errorEl.style.display = 'block';
            }
        }
    },

    logout() {
        localStorage.removeItem('streetos_token');
        this.user = null;
        WS.disconnect();
        window.location.hash = '#/';
    }
};

// Boot
window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());

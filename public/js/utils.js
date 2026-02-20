/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Utility Functions
   ═══════════════════════════════════════════════════════════════════════════════ */

const Utils = {
    // Format currency
    money(val, decimals = 2) {
        if (val === null || val === undefined) return '$0.00';
        const sign = val < 0 ? '-' : '';
        return sign + '$' + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    },

    // Format number with commas
    num(val, decimals = 2) {
        if (val === null || val === undefined) return '0';
        return val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    },

    // Format percent
    pct(val) {
        if (val === null || val === undefined) return '0.00%';
        const sign = val >= 0 ? '+' : '';
        return sign + val.toFixed(2) + '%';
    },

    // Format change
    change(val, decimals = 2) {
        if (val === null || val === undefined) return '0.00';
        const sign = val >= 0 ? '+' : '';
        return sign + val.toFixed(decimals);
    },

    // Time ago
    timeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 10) return 'just now';
        if (seconds < 60) return seconds + 's ago';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm ago';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.floor(hours / 24);
        return days + 'd ago';
    },

    // Format time
    formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false });
    },

    // Format date
    formatDate(timestamp) {
        return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },

    // Color class based on value
    colorClass(val) {
        if (val > 0) return 'price-up';
        if (val < 0) return 'price-down';
        return 'price-flat';
    },

    // Abbreviate large numbers
    abbrev(val) {
        if (Math.abs(val) >= 1e9) return (val / 1e9).toFixed(1) + 'B';
        if (Math.abs(val) >= 1e6) return (val / 1e6).toFixed(1) + 'M';
        if (Math.abs(val) >= 1e3) return (val / 1e3).toFixed(1) + 'K';
        return val.toFixed(0);
    },

    // API helpers
    async api(path, options = {}) {
        const token = localStorage.getItem('streetos_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const res = await fetch('/api' + path, { ...options, headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    },

    async get(path) { return this.api(path); },
    async post(path, body) { return this.api(path, { method: 'POST', body: JSON.stringify(body) }); },
    async put(path, body) { return this.api(path, { method: 'PUT', body: JSON.stringify(body) }); },
    async del(path) { return this.api(path, { method: 'DELETE' }); },

    // Toast notifications
    toasts: [],
    showToast(type, title, message, duration = 5000) {
        const container = document.querySelector('.toast-container') || this.createToastContainer();
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { fill: '✅', news: '📰', error: '❌', margin: '🚨', info: 'ℹ️' };
        toast.innerHTML = `
      <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        <div class="toast-message">${message}</div>
      </div>
    `;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('leaving');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    },

    createToastContainer() {
        const c = document.createElement('div');
        c.className = 'toast-container';
        document.body.appendChild(c);
        return c;
    },

    // Event bus for component communication
    _events: {},
    on(event, cb) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push(cb);
    },
    off(event, cb) {
        if (!this._events[event]) return;
        this._events[event] = this._events[event].filter(fn => fn !== cb);
    },
    emit(event, data) {
        if (!this._events[event]) return;
        for (const cb of this._events[event]) cb(data);
    },

    // Debounce
    debounce(fn, ms) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    },

    // Throttle for ultra low latency rendering
    throttle(fn, ms) {
        let last = 0;
        return (...args) => {
            const now = Date.now();
            if (now - last >= ms) { last = now; fn(...args); }
        };
    }
};

window.Utils = Utils;

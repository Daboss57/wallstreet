/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — WebSocket Client
   Ultra low latency: reconnect, batch processing, subscription management
   ═══════════════════════════════════════════════════════════════════════════════ */

const WS = {
    socket: null,
    connected: false,
    authenticated: false,
    reconnectTimer: null,
    reconnectDelay: 1000,
    maxReconnectDelay: 30000,

    connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws`;

        this.socket = new WebSocket(url);
        this.socket.binaryType = 'arraybuffer';

        this.socket.onopen = () => {
            console.log('[WS] Connected');
            this.connected = true;
            this.reconnectDelay = 1000;

            // Authenticate
            const token = localStorage.getItem('streetos_token');
            if (token) {
                this.send({ type: 'auth', token });
            }
        };

        this.socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.handleMessage(msg);
            } catch (e) {
                console.error('[WS] Parse error:', e);
            }
        };

        this.socket.onclose = () => {
            console.log('[WS] Disconnected');
            this.connected = false;
            this.authenticated = false;
            this.scheduleReconnect();
        };

        this.socket.onerror = (e) => {
            console.error('[WS] Error:', e);
        };
    },

    send(msg) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(msg));
        }
    },

    handleMessage(msg) {
        switch (msg.type) {
            case 'connected':
                break;

            case 'authenticated':
                this.authenticated = true;
                console.log('[WS] Authenticated as', msg.username);
                Utils.emit('ws:authenticated', msg);
                break;

            case 'auth_error':
                console.error('[WS] Auth failed:', msg.message);
                localStorage.removeItem('streetos_token');
                Utils.emit('auth:logout');
                break;

            case 'ticks':
                // Batch tick update — ultra hot path
                if (msg.data && msg.data.length > 0) {
                    Utils.emit('ticks', msg.data);
                }
                break;

            case 'orderbook':
                Utils.emit('orderbook', msg.data);
                break;

            case 'fill':
                Utils.emit('fill', msg);
                Utils.showToast('fill', 'Order Filled',
                    `${msg.side.toUpperCase()} ${msg.qty} ${msg.ticker} @ $${msg.price.toFixed(2)}`);
                break;

            case 'margin_call':
                Utils.emit('margin_call', msg);
                Utils.showToast('margin', '🚨 Margin Call',
                    `Auto-covered ${msg.qty} ${msg.ticker} @ $${msg.price.toFixed(2)} — P&L: ${Utils.money(msg.pnl)}`);
                break;

            case 'news':
                Utils.emit('news:live', msg.data);
                Utils.showToast('news',
                    msg.data.severity === 'high' ? '🔴 BREAKING' : '🔵 News',
                    msg.data.headline, 8000);
                break;

            case 'portfolio':
                Utils.emit('portfolio:update', msg);
                break;

            case 'pong':
                break;
        }
    },

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
            this.connect();
        }, this.reconnectDelay);
    },

    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.connected = false;
        this.authenticated = false;
    },

    subscribe(tickers) {
        this.send({ type: 'subscribe', tickers });
    },

    subscribeAll() {
        this.send({ type: 'subscribe_all' });
    }
};

window.WS = WS;

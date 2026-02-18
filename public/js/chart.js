/* ═══════════════════════════════════════════════════════════════════════════════
   StreetOS — Chart Module (Lightweight Charts / TradingView)
   Supports: candlestick + volume, real-time ticks, TP/SL/entry price lines
   ═══════════════════════════════════════════════════════════════════════════════ */

const ChartManager = {
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    currentTicker: null,
    currentInterval: '1m',
    lastCandleTime: null,
    _priceLines: [],       // active price line objects
    _priceLineData: new Map(), // map line -> { type: 'entry'|'tp'|'sl'|'limit'|'stop', id: orderId, price: number }
    _positionLines: null,  // { entry, tp, sl }
    _orderLines: [],       // pending order lines

    // Drag state
    _isDragging: false,
    _draggedLine: null,
    _hoveredLine: null,

    init(container) {
        if (this.chart) this.chart.remove();

        this.chart = LightweightCharts.createChart(container, {
            width: container.clientWidth,
            height: container.clientHeight,
            layout: {
                background: { type: 'solid', color: '#0a0e17' },
                textColor: '#8892a8',
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
            },
            grid: {
                vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
                horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: 'rgba(59, 130, 246, 0.3)', width: 1, style: 2 },
                horzLine: { color: 'rgba(59, 130, 246, 0.3)', width: 1, style: 2 },
            },
            rightPriceScale: {
                borderColor: '#1e293b',
                scaleMargins: { top: 0.1, bottom: 0.25 },
            },
            timeScale: {
                borderColor: '#1e293b',
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 5,
                barSpacing: 8,
            },
            handleScale: { axisPressedMouseMove: true },
            handleScale: { axisPressedMouseMove: true },
            handleScroll: { mouseWheel: true, pressedMouseMove: true },
        });

        // Mouse events for drag-and-drop
        container.addEventListener('mousedown', (e) => this.onMouseDown(e));
        container.addEventListener('mousemove', (e) => this.onMouseMove(e));
        container.addEventListener('mouseup', (e) => this.onMouseUp(e));
        container.addEventListener('mouseleave', () => this.onMouseUp()); // Cancel drag on leave

        this.chart.subscribeCrosshairMove(param => this.onCrosshairMove(param));

        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#22c55e',
            downColor: '#ef4444',
            borderUpColor: '#22c55e',
            borderDownColor: '#ef4444',
            wickUpColor: '#22c55e',
            wickDownColor: '#ef4444',
        });

        this.volumeSeries = this.chart.addHistogramSeries({
            color: '#3b82f6',
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
        });

        this.chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 },
        });

        // Resize observer
        this._resizeObserver = new ResizeObserver(() => {
            if (this.chart) {
                this.chart.applyOptions({
                    width: container.clientWidth,
                    height: container.clientHeight,
                });
            }
        });
        this._resizeObserver.observe(container);

        // Listen for ticks
        Utils.on('ticks', (ticks) => this.onTicks(ticks));
    },

    async loadTicker(ticker, interval) {
        this.currentTicker = ticker;
        this.currentInterval = interval || this.currentInterval;
        this.lastCandleTime = null;

        // Clear old price lines
        this.clearAllPriceLines();

        try {
            const candles = await Utils.get(`/candles/${ticker}?interval=${this.currentInterval}&limit=500`);

            const candleData = [];
            const volumeData = [];

            for (const c of candles) {
                const time = Math.floor(c.open_time / 1000);
                candleData.push({
                    time,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                });
                volumeData.push({
                    time,
                    value: c.volume,
                    color: c.close >= c.open ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
                });
                this.lastCandleTime = time;
            }

            this.candleSeries.setData(candleData);
            this.volumeSeries.setData(volumeData);
            this.chart.timeScale().fitContent();
        } catch (e) {
            console.error('[Chart] Load error:', e);
        }
    },

    onTicks(ticks) {
        if (!this.currentTicker || !this.candleSeries) return;

        for (const tick of ticks) {
            if (tick.ticker !== this.currentTicker) continue;

            const intervalSecs = this.getIntervalSeconds(this.currentInterval);
            const candleTime = Math.floor(tick.timestamp / 1000 / intervalSecs) * intervalSecs;

            // Update or create candle
            if (this.lastCandleTime && candleTime > this.lastCandleTime) {
                // New candle
                this.lastCandleTime = candleTime;
                this.candleSeries.update({
                    time: candleTime,
                    open: tick.price,
                    high: tick.price,
                    low: tick.price,
                    close: tick.price,
                });
                this.volumeSeries.update({
                    time: candleTime,
                    value: 0,
                    color: 'rgba(59, 130, 246, 0.3)',
                });
            } else {
                // Update existing candle
                const time = this.lastCandleTime || candleTime;
                this.lastCandleTime = time;
                this.candleSeries.update({
                    time,
                    open: tick.open || tick.price,
                    high: Math.max(tick.high || tick.price || tick.open, tick.price),
                    low: Math.min(tick.low || tick.price || tick.open, tick.price),
                    close: tick.price,
                });
            }

            // Update entry P&L live
            if (this._positionLines?.entry) {
                const data = this._priceLineData.get(this._positionLines.entry);
                if (data) this.updateEntryPnl(data.position, tick.price);
            }
        }
    },

    // ─── Price Lines (TP / SL / Entry / Orders) ────────────────────────────────
    clearAllPriceLines() {
        if (!this.candleSeries) return;
        for (const line of this._priceLines) {
            try { this.candleSeries.removePriceLine(line); } catch (_) { }
        }
        this._priceLines = [];
        this._priceLineData.clear();
        this._positionLines = null;
        this._orderLines = [];
        this._draggedLine = null;
        this._hoveredLine = null;
    },

    /**
     * Draw position lines: entry, TP, SL with P&L labels
     * @param {Object} position - { qty, avg_cost, ticker }
     * @param {number|null} tpPrice - take-profit price
     * @param {number|null} slPrice - stop-loss price
     * @param {number} currentPrice - current market price
     */
    drawPositionLines(position, tpPrice, slPrice, currentPrice) {
        if (!this.candleSeries || !position) return;
        if (position.ticker !== this.currentTicker) return;

        // Remove old position lines
        this.clearPositionLines();

        const qty = Math.abs(position.qty);
        const isLong = position.qty > 0;
        const entry = position.avg_cost;

        // ─── Entry line (blue) ──
        const entryPnl = ((currentPrice - entry) * qty * (isLong ? 1 : -1));
        const entryPnlStr = entryPnl >= 0 ? `+${Utils.money(entryPnl)}` : Utils.money(entryPnl);
        const entryLine = this.candleSeries.createPriceLine({
            price: entry,
            color: '#3b82f6',
            lineWidth: 2,
            lineStyle: 0, // Solid
            axisLabelVisible: true,
            title: `⬤ Entry ${qty}x   ${entryPnlStr}`,
        });

        this._priceLines.push(entryLine);
        this._priceLineData.set(entryLine, { type: 'entry', position });
        const posLines = { entry: entryLine, tp: null, sl: null };

        // ── Take-Profit line (green) ──
        if (tpPrice && tpPrice > 0) {
            const tpPnl = (tpPrice - entry) * qty * (isLong ? 1 : -1);
            const tpPnlStr = tpPnl >= 0 ? `+${Utils.money(tpPnl)}` : Utils.money(tpPnl);
            const tpLine = this.candleSeries.createPriceLine({
                price: tpPrice,
                color: '#22c55e',
                lineWidth: 2,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: `TP   ${tpPnlStr}`,
                draggable: true // custom flag
            });
            this._priceLines.push(tpLine);
            this._priceLineData.set(tpLine, { type: 'tp', id: 'tp-dummy', position }); // In real app, bind to OCO order ID
            posLines.tp = tpLine;
        }

        // ── Stop-Loss line (red) ──
        if (slPrice && slPrice > 0) {
            const slPnl = (slPrice - entry) * qty * (isLong ? 1 : -1);
            const slPnlStr = slPnl >= 0 ? `+${Utils.money(slPnl)}` : Utils.money(slPnl);
            const slLine = this.candleSeries.createPriceLine({
                price: slPrice,
                color: '#ef4444',
                lineWidth: 2,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: `SL   ${slPnlStr}`,
                draggable: true
            });
            this._priceLines.push(slLine);
            this._priceLineData.set(slLine, { type: 'sl', id: 'sl-dummy', position });
            posLines.sl = slLine;
        }

        this._positionLines = posLines;
    },

    clearPositionLines() {
        if (!this.candleSeries || !this._positionLines) return;
        for (const key of ['entry', 'tp', 'sl']) {
            if (this._positionLines[key]) {
                try { this.candleSeries.removePriceLine(this._positionLines[key]); } catch (_) { }
                const idx = this._priceLines.indexOf(this._positionLines[key]);
                if (idx >= 0) this._priceLines.splice(idx, 1);
            }
        }
        this._positionLines = null;
    },

    /**
     * Draw pending order lines (limit/stop orders)
     * @param {Array} orders - open orders for the current ticker
     */
    drawOrderLines(orders) {
        if (!this.candleSeries) return;

        // Remove old order lines
        this.clearOrderLines();

        for (const order of orders) {
            if (order.ticker !== this.currentTicker) continue;
            if (order.status !== 'open') continue;

            const isBuy = order.side === 'buy';
            const color = isBuy ? '#22c55e' : '#ef4444';
            const label = `${order.side.toUpperCase()} ${order.qty}x`;
            let price = null;

            if (order.type === 'limit' || order.type === 'stop-limit') {
                price = order.limit_price;
            } else if (['stop', 'stop-loss', 'take-profit'].includes(order.type)) {
                price = order.stop_price;
            }

            if (price && price > 0) {
                const line = this.candleSeries.createPriceLine({
                    price,
                    color,
                    lineWidth: 2,
                    lineStyle: 1, // Dotted
                    axisLabelVisible: true,
                    title: `${order.type.toUpperCase()} ${label}`,
                    draggable: true,
                });
                this._priceLines.push(line);
                this._orderLines.push(line);
                this._priceLineData.set(line, { type: 'order', id: order.id, order });
            }
        }
    },

    clearOrderLines() {
        if (!this.candleSeries) return;
        for (const line of this._orderLines) {
            try { this.candleSeries.removePriceLine(line); } catch (_) { }
            const idx = this._priceLines.indexOf(line);
            if (idx >= 0) this._priceLines.splice(idx, 1);
        }
        this._orderLines = [];
    },

    /**
     * Update just the entry line P&L (called on every tick for speed)
     */
    updateEntryPnl(position, currentPrice) {
        if (!this._positionLines?.entry || !position) return;
        const qty = Math.abs(position.qty);
        const isLong = position.qty > 0;
        const entry = position.avg_cost;
        const pnl = (currentPrice - entry) * qty * (isLong ? 1 : -1);
        const pnlStr = pnl >= 0 ? `+${Utils.money(pnl)}` : Utils.money(pnl);
        try {
            this._positionLines.entry.applyOptions({
                title: `⬤ Entry ${qty}x   ${pnlStr}`,
            });
        } catch (_) { }
    },

    changeInterval(interval) {
        if (interval === this.currentInterval) return;
        this.currentInterval = interval;
        if (this.currentTicker) {
            this.loadTicker(this.currentTicker, interval);
        }
    },

    getIntervalSeconds(interval) {
        const map = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400 };
        return map[interval] || 60;
    },

    destroy() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this.chart) { this.chart.remove(); this.chart = null; }
        Utils.off('ticks', this.onTicks);
    },

    // ─── Interaction Logic ────────────────────────────────────────────────────────

    onCrosshairMove(param) {
        if (this._isDragging) return; // Don't hover detect while dragging
        if (!param || !param.seriesData || !param.point) {
            this.setCursor('default');
            this._hoveredLine = null;
            return;
        }

        const price = this.candleSeries.coordinateToPrice(param.point.y);
        const hovered = this.findNearestLine(price);

        if (hovered) {
            this.setCursor('ns-resize');
            this._hoveredLine = hovered;
        } else {
            this.setCursor('default');
            this._hoveredLine = null;
        }
    },

    findNearestLine(price) {
        if (!price) return null;
        let nearest = null;
        let minDist = Infinity;

        // Convert prices to pixels to check distance visually
        const pricePx = this.candleSeries.priceToCoordinate(price);

        for (const line of this._priceLines) {
            const data = this._priceLineData.get(line);
            if (!data || data.type === 'entry') continue; // Entry line static for now

            const linePrice = line.options().price;
            const linePx = this.candleSeries.priceToCoordinate(linePrice);

            if (linePx === null) continue; // Out of view?

            const dist = Math.abs(pricePx - linePx);
            if (dist < 10) { // 10px threshold
                if (dist < minDist) {
                    minDist = dist;
                    nearest = line;
                }
            }
        }
        return nearest;
    },

    setCursor(cursor) {
        const container = document.getElementById('chart-container');
        if (container) container.style.cursor = cursor;
    },

    onMouseDown(e) {
        if (this._hoveredLine) {
            this._isDragging = true;
            this._draggedLine = this._hoveredLine;
            this.chart.applyOptions({ handleScroll: { pressedMouseMove: false } }); // Disable scroll drag
        }
    },

    onMouseMove(e) {
        if (!this._isDragging || !this._draggedLine) return;

        // Calculate new price from mouse Y
        // Need to get chart rect
        const container = document.getElementById('chart-container');
        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top;

        const newPrice = this.candleSeries.coordinateToPrice(y);
        if (newPrice && newPrice > 0) {
            // Snap to tick size? (e.g. 0.01)
            const tickSize = 0.01;
            const sub = newPrice % tickSize;
            const snapped = newPrice - sub;

            // Visual update
            this._draggedLine.applyOptions({ price: snapped });
        }
    },

    async onMouseUp(e) {
        if (this._isDragging && this._draggedLine) {
            const line = this._draggedLine;
            const price = line.options().price;
            const data = this._priceLineData.get(line);

            this._isDragging = false;
            this._draggedLine = null;
            this.chart.applyOptions({ handleScroll: { pressedMouseMove: true } }); // Re-enable scroll

            // API Call
            if (data.type === 'order') {
                try {
                    // Update limit/stop price
                    console.log('Update order', data.id, price);
                    // For now, assume limit price for limit orders, stop for stop orders
                    const isStop = ['stop', 'stop-loss', 'take-profit', 'trailing-stop'].includes(data.order.type);
                    const payload = isStop ? { stopPrice: price } : { price };

                    await Utils.put(`/orders/${data.id}`, payload);
                    Utils.showToast('success', 'Order Updated', `New price: ${Utils.num(price)}`);
                    if (window.Terminal) Terminal.loadPortfolioData();
                } catch (err) {
                    Utils.showToast('error', 'Update Failed', err.message);
                    // Revert visual? Terminal reload will fix it
                    if (window.Terminal) Terminal.loadPortfolioData();
                }
            } else if (data.type === 'tp' || data.type === 'sl') {
                // Handle TP/SL modification for position
                // Logic: Find the associated order? Or create new one?
                // Currently backend doesn't link OCO properly exposed to frontend in this simplified version
                // So we'll warn user for now
                Utils.showToast('info', 'Feature Pending', 'Direct TP/SL modification coming soon. Use Order Panel.');
            }
        }
    }
};

window.ChartManager = ChartManager;

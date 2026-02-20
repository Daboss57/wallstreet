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
    _priceLines: [],       // active price line references
    _positionLines: null,  // { entry, tp, sl }
    _orderLines: [],       // pending order lines
    _futureSeries: null,
    _futurePreviewEnabled: false,

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
            handleScroll: { mouseWheel: true, pressedMouseMove: true },
        });

        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#22c55e',
            downColor: '#ef4444',
            borderUpColor: '#22c55e',
            borderDownColor: '#ef4444',
            wickUpColor: '#22c55e',
            wickDownColor: '#ef4444',
        });

        this._futureSeries = this.chart.addCandlestickSeries({
            upColor: 'rgba(34, 197, 94, 0.24)',
            downColor: 'rgba(239, 68, 68, 0.24)',
            borderUpColor: 'rgba(34, 197, 94, 0.55)',
            borderDownColor: 'rgba(239, 68, 68, 0.55)',
            wickUpColor: 'rgba(34, 197, 94, 0.55)',
            wickDownColor: 'rgba(239, 68, 68, 0.55)',
            priceLineVisible: false,
            lastValueVisible: false,
            baseLineVisible: false,
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
        this.clearFuturePreview();

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
            if (this._futurePreviewEnabled) {
                await this.refreshFuturePreview();
            }
        } catch (e) {
            console.error('[Chart] Load error:', e);
        }
    },

    onTicks(ticks) {
        if (!this.currentTicker || !this.candleSeries) return;
        let startedNewCandle = false;

        for (const tick of ticks) {
            if (tick.ticker !== this.currentTicker) continue;

            const intervalSecs = this.getIntervalSeconds(this.currentInterval);
            const candleTime = Math.floor(tick.timestamp / 1000 / intervalSecs) * intervalSecs;

            // Update or create candle
            if (this.lastCandleTime && candleTime > this.lastCandleTime) {
                // New candle
                startedNewCandle = true;
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
                    high: Math.max(tick.high || tick.price, tick.price),
                    low: Math.min(tick.low || tick.price, tick.price),
                    close: tick.price,
                });
            }
        }

        if (startedNewCandle && this._futurePreviewEnabled) {
            this.refreshFuturePreview().catch((e) => console.error('[Chart] Future preview refresh error:', e));
        }
    },

    // ─── Price Lines (TP / SL / Entry / Orders) ────────────────────────────────
    clearAllPriceLines() {
        if (!this.candleSeries) return;
        for (const line of this._priceLines) {
            try { this.candleSeries.removePriceLine(line); } catch (_) { }
        }
        this._priceLines = [];
        this._positionLines = null;
        this._orderLines = [];
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

        // ── Entry line (blue) ──
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
        const posLines = { entry: entryLine, tp: null, sl: null };

        // ── Take-Profit line (green) ──
        if (tpPrice && tpPrice > 0) {
            const tpPnl = (tpPrice - entry) * qty * (isLong ? 1 : -1);
            const tpPnlStr = tpPnl >= 0 ? `+${Utils.money(tpPnl)}` : Utils.money(tpPnl);
            const tpLine = this.candleSeries.createPriceLine({
                price: tpPrice,
                color: '#22c55e',
                lineWidth: 1,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: `TP   ${tpPnlStr}`,
            });
            this._priceLines.push(tpLine);
            posLines.tp = tpLine;
        }

        // ── Stop-Loss line (red) ──
        if (slPrice && slPrice > 0) {
            const slPnl = (slPrice - entry) * qty * (isLong ? 1 : -1);
            const slPnlStr = slPnl >= 0 ? `+${Utils.money(slPnl)}` : Utils.money(slPnl);
            const slLine = this.candleSeries.createPriceLine({
                price: slPrice,
                color: '#ef4444',
                lineWidth: 1,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: `SL   ${slPnlStr}`,
            });
            this._priceLines.push(slLine);
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
                    lineWidth: 1,
                    lineStyle: 1, // Dotted
                    axisLabelVisible: true,
                    title: `${order.type.toUpperCase()} ${label}`,
                });
                this._priceLines.push(line);
                this._orderLines.push(line);
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

    async setFuturePreview(enabled) {
        this._futurePreviewEnabled = !!enabled;
        if (!this._futurePreviewEnabled) {
            this.clearFuturePreview();
            return { enabled: false, available: true };
        }

        await this.refreshFuturePreview();
        return { enabled: true, available: true };
    },

    async refreshFuturePreview() {
        if (!this._futurePreviewEnabled || !this.currentTicker) {
            this.clearFuturePreview();
            return;
        }

        const ticker = this.currentTicker;
        const interval = this.currentInterval;
        const response = await Utils.get(`/candles/${ticker}/preview?interval=${interval}&minutes=5`);

        if (ticker !== this.currentTicker || interval !== this.currentInterval) return;
        const candles = Array.isArray(response?.candles) ? response.candles : [];
        const previewData = candles.map((c) => ({
            time: Math.floor(Number(c.open_time) / 1000),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
        }));

        if (this._futureSeries) this._futureSeries.setData(previewData);
        this.chart?.timeScale().applyOptions({ rightOffset: this._futurePreviewEnabled ? 8 : 5 });
    },

    clearFuturePreview() {
        if (this._futureSeries) this._futureSeries.setData([]);
        this.chart?.timeScale().applyOptions({ rightOffset: 5 });
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
        this._futurePreviewEnabled = false;
        this.clearFuturePreview();
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this.chart) { this.chart.remove(); this.chart = null; }
        Utils.off('ticks', this.onTicks);
    }
};

window.ChartManager = ChartManager;

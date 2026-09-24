const WebSocket = require('ws');
const axios = require('axios');

class BinanceFeed {
  constructor(state, symbol = 'btcusdt') {
    this.state = state;
    this.symbol = symbol;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.pingInterval = null;
    this.restPollInterval = null;
    this.running = false;
    this.wsConnected = false;

    // WebSocket endpoints to try (Binance.US first for US users, then global)
    this.wsEndpoints = [
      `wss://stream.binance.us:9443/ws/${symbol}@bookTicker`,
      `wss://stream.binance.com:9443/ws/${symbol}@bookTicker`,
    ];
    this.currentEndpointIdx = 0;
    this.wsFailCount = 0;

    // REST fallback endpoints
    this.restEndpoints = [
      { url: 'https://api.binance.us/api/v3/ticker/bookTicker', params: { symbol: 'BTCUSD' } },
      { url: 'https://api.binance.com/api/v3/ticker/bookTicker', params: { symbol: 'BTCUSDT' } },
    ];

    // Track price history for volatility estimation + trend indicator
    this.priceHistory = []; // [{ price, timestamp }]
    this.maxHistory = 3600; // 1 hour of ~1/sec samples (for trend EMA + ROC)

    // Trend indicator (injected via setTrendIndicator to avoid circular deps)
    this.trendIndicator = null;
  }

  setTrendIndicator(indicator) {
    this.trendIndicator = indicator;
  }

  start() {
    this.running = true;
    this.connectWs();
    // Start REST polling as fallback (only updates if WS is down)
    this.restPollInterval = setInterval(() => this.restFallback(), 1000);
  }

  connectWs() {
    if (!this.running) return;

    const url = this.wsEndpoints[this.currentEndpointIdx];
    console.log(`[BinanceFeed] Trying WebSocket: ${url.split('/ws/')[0]}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[BinanceFeed] WebSocket constructor error:', err.message);
      this.tryNextEndpoint();
      return;
    }

    const connectTimeout = setTimeout(() => {
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this.ws.terminate();
        this.tryNextEndpoint();
      }
    }, 5000);

    this.ws.on('open', () => {
      clearTimeout(connectTimeout);
      console.log('[BinanceFeed] WebSocket connected');
      this.wsConnected = true;
      this.state.updateConnection('binance', true);
      this.reconnectDelay = 1000;
      this.wsFailCount = 0;

      // Ping every 30s to keep alive
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const bid = parseFloat(data.b);
        const ask = parseFloat(data.a);

        if (isNaN(bid) || isNaN(ask)) return;

        this.state.updateBinancePrice(bid, ask);
        this.recordPrice((bid + ask) / 2);
      } catch (err) {
        // Ignore parse errors on binary frames
      }
    });

    this.ws.on('close', () => {
      clearTimeout(connectTimeout);
      this.wsConnected = false;
      this.state.updateConnection('binance', false);
      this.cleanupWs();
      this.tryNextEndpoint();
    });

    this.ws.on('error', (err) => {
      clearTimeout(connectTimeout);
      console.error(`[BinanceFeed] WS error: ${err.message}`);
      this.wsConnected = false;
    });
  }

  tryNextEndpoint() {
    if (!this.running) return;

    this.wsFailCount++;

    if (this.wsFailCount >= this.wsEndpoints.length * 2) {
      console.log('[BinanceFeed] All WebSocket endpoints failed, using REST polling');
      setTimeout(() => {
        this.wsFailCount = 0;
        this.currentEndpointIdx = 0;
        this.connectWs();
      }, 30000);
      return;
    }

    this.currentEndpointIdx = (this.currentEndpointIdx + 1) % this.wsEndpoints.length;
    setTimeout(() => this.connectWs(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
  }

  async restFallback() {
    if (!this.running) return;
    if (this.wsConnected) return;

    for (const endpoint of this.restEndpoints) {
      try {
        const resp = await axios.get(endpoint.url, {
          params: endpoint.params,
          timeout: 3000,
        });

        const bid = parseFloat(resp.data.bidPrice);
        const ask = parseFloat(resp.data.askPrice);

        if (isNaN(bid) || isNaN(ask)) continue;

        this.state.updateBinancePrice(bid, ask);
        this.recordPrice((bid + ask) / 2);
        return;
      } catch (err) {
        // Try next endpoint
      }
    }
  }

  recordPrice(price) {
    const now = Date.now();
    const last = this.priceHistory[this.priceHistory.length - 1];
    if (!last || now - last.timestamp > 1000) {
      this.priceHistory.push({ price, timestamp: now });
      if (this.priceHistory.length > this.maxHistory) {
        this.priceHistory.shift();
      }
      // Feed the trend indicator
      if (this.trendIndicator) {
        this.trendIndicator.update(price);
      }
    }
  }

  cleanupWs() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // Return an observation close to the contract's scheduled reference time.
  // Never replace a missed open observation with current spot.
  getPriceAt(timestamp, toleranceMs = 2500) {
    if (!Number.isFinite(timestamp) || this.priceHistory.length === 0) return null;
    let nearest = null;
    for (const sample of this.priceHistory) {
      if (!nearest || Math.abs(sample.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp)) nearest = sample;
    }
    if (!nearest || Math.abs(nearest.timestamp - timestamp) > toleranceMs) return null;
    return { price: nearest.price, timestamp: nearest.timestamp };
  }

  // Estimate realized volatility from recent price history
  getRecentVolatility(windowSeconds = 300) {
    const cutoff = Date.now() - windowSeconds * 1000;
    const relevant = this.priceHistory.filter(p => p.timestamp >= cutoff);
    if (relevant.length < 10) return 0.0015; // default ~0.15% for 5-min

    // Calculate log returns
    const returns = [];
    for (let i = 1; i < relevant.length; i++) {
      returns.push(Math.log(relevant[i].price / relevant[i - 1].price));
    }

    // Standard deviation of returns
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const stdPerSample = Math.sqrt(variance);

    // Scale to the window
    const avgInterval = (relevant[relevant.length - 1].timestamp - relevant[0].timestamp) / (relevant.length - 1);
    const samplesInWindow = (windowSeconds * 1000) / avgInterval;

    return stdPerSample * Math.sqrt(samplesInWindow);
  }

  stop() {
    this.running = false;
    this.cleanupWs();
    if (this.restPollInterval) {
      clearInterval(this.restPollInterval);
      this.restPollInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = BinanceFeed;

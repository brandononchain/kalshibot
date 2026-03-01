const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

class KalshiClient {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.privateKeyPem = null;
    this.baseUrl = config.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  }

  loadPrivateKey() {
    if (!this.privateKeyPem) {
      const keyPath = this.config.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem';
      if (!fs.existsSync(keyPath)) {
        throw new Error(`Private key not found: ${keyPath}`);
      }
      this.privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    }
    return this.privateKeyPem;
  }

  generateAuth(method, apiPath) {
    const pem = this.loadPrivateKey();
    const timestampMs = Date.now().toString();
    const pathWithoutQuery = apiPath.split('?')[0];
    const message = timestampMs + method + pathWithoutQuery;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    const signature = sign.sign({
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, 'base64');

    return {
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': this.config.KALSHI_API_KEY,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      },
    };
  }

  async get(apiPath) {
    const auth = this.generateAuth('GET', apiPath);
    return axios.get(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 });
  }

  async post(apiPath, body) {
    const auth = this.generateAuth('POST', apiPath);
    return axios.post(`${this.baseUrl}${apiPath}`, body, { ...auth, timeout: 8000 });
  }

  async delete(apiPath) {
    const auth = this.generateAuth('DELETE', apiPath);
    return axios.delete(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 });
  }

  async fetchBalance() {
    try {
      const resp = await this.get('/trade-api/v2/portfolio/balance');
      const totalCents = resp.data.balance;
      const reservedCents = resp.data.payout || 0;

      const balance = {
        total: totalCents / 100,
        available: (totalCents - reservedCents) / 100,
        reserved: reservedCents / 100,
      };

      this.state.updateBalance(balance);
      this.state.updateKalshiConnection(true);
      return balance;
    } catch (error) {
      this.state.updateKalshiConnection(false);
      throw error;
    }
  }

  async discoverMarkets(seriesTicker) {
    const apiPath = `/trade-api/v2/markets?series_ticker=${seriesTicker}&limit=20&status=open`;
    const resp = await this.get(apiPath);
    return resp.data.markets || [];
  }

  async fetchMarket(ticker) {
    try {
      const resp = await this.get(`/trade-api/v2/markets/${ticker}`);
      const m = resp.data.market;
      return {
        ticker: m.ticker,
        status: m.status,
        result: m.result,
        yesBid: m.yes_bid / 100,
        yesAsk: m.yes_ask / 100,
        noBid: m.no_bid / 100,
        noAsk: m.no_ask / 100,
        lastPrice: m.last_price / 100,
        yesBidCents: m.yes_bid,
        yesAskCents: m.yes_ask,
        noBidCents: m.no_bid,
        noAskCents: m.no_ask,
        openTime: new Date(m.open_time).getTime(),
        closeTime: new Date(m.close_time).getTime(),
      };
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async placeOrder(orderData) {
    const resp = await this.post('/trade-api/v2/portfolio/orders', orderData);
    return resp.data.order;
  }

  async getOrder(orderId) {
    const resp = await this.get(`/trade-api/v2/portfolio/orders/${orderId}`);
    return resp.data.order;
  }

  async cancelOrder(orderId) {
    const resp = await this.delete(`/trade-api/v2/portfolio/orders/${orderId}`);
    return resp.data;
  }

  // Fetch actual positions from Kalshi (for reconciliation on startup)
  async fetchPositions(seriesTicker) {
    try {
      // Fetch ALL unsettled positions (ticker filter requires exact market ticker, not series)
      const apiPath = `/trade-api/v2/portfolio/positions?settlement_status=unsettled&limit=200`;
      const resp = await this.get(apiPath);
      const all = resp.data.market_positions || [];
      // Filter client-side to our series only
      return all.filter(p => p.ticker && p.ticker.startsWith(seriesTicker));
    } catch (error) {
      console.error('[Kalshi] Failed to fetch positions:', error.message);
      return [];
    }
  }

  // Sell existing position (for take-profit before settlement)
  async sellPosition(ticker, side, count, priceCents) {
    const orderData = {
      ticker,
      action: 'sell',
      side,
      count,
      type: 'limit',
      client_order_id: `sell-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    };

    if (side === 'yes') orderData.yes_price = priceCents;
    else orderData.no_price = priceCents;

    return this.placeOrder(orderData);
  }
}

module.exports = KalshiClient;

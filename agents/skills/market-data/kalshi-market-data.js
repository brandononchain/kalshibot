/**
 * KalshiMarketData Skill
 *
 * Wraps the existing KalshiClient as an agent skill.
 * Handles market discovery, price refresh, balance checks, position reconciliation.
 *
 * Capabilities: fetch-balance, discover-markets, refresh-markets, fetch-market,
 *               reconcile-positions, place-order, get-order, cancel-order, sell-position
 */

const BaseSkill = require('../../core/base-skill');
const KalshiClient = require('../../../bot/kalshi');

class KalshiMarketData extends BaseSkill {
  constructor() {
    super({
      name: 'kalshi-market-data',
      description: 'Kalshi API client for market data, orders, and account management',
      domain: 'market-data',
      capabilities: [
        'fetch-balance', 'discover-markets', 'refresh-markets', 'fetch-market',
        'reconcile-positions', 'place-order', 'get-order', 'cancel-order', 'sell-position',
      ],
      dependencies: ['state-manager'],
    });

    this.client = null;
    this.seriesTicker = null;
    this.slotDuration = 900;
    this._marketCache = { data: [], ts: 0 };
    this._marketCacheTTL = 3000;
  }

  async initialize(context) {
    await super.initialize(context);
    const stateManager = context.registry.get('state-manager');
    this.client = new KalshiClient(context.config, stateManager.botState);
    this.seriesTicker = context.config.SERIES_TICKER || 'KXBTC15M';
    this.slotDuration = context.config.SLOT_DURATION || 900;
  }

  async start() {
    await super.start();
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'fetch-balance': {
        const balance = await this.client.fetchBalance();
        return { balance };
      }

      case 'discover-markets': {
        return await this._discoverMarkets(state);
      }

      case 'refresh-markets': {
        return await this._refreshMarkets(state);
      }

      case 'fetch-market': {
        const ticker = task.params?.ticker;
        if (!ticker) throw new Error('ticker required');
        const market = await this.client.fetchMarket(ticker);
        return { market };
      }

      case 'reconcile-positions': {
        return await this._reconcilePositions(state);
      }

      case 'place-order': {
        const orderData = task.params?.orderData;
        if (!orderData) throw new Error('orderData required');
        const order = await this.client.placeOrder(orderData);
        return { order };
      }

      case 'get-order': {
        const orderId = task.params?.orderId;
        if (!orderId) throw new Error('orderId required');
        const order = await this.client.getOrder(orderId);
        return { order };
      }

      case 'cancel-order': {
        const orderId = task.params?.orderId;
        if (!orderId) throw new Error('orderId required');
        await this.client.cancelOrder(orderId);
        return { cancelled: true };
      }

      case 'sell-position': {
        const { ticker, side, count, priceCents } = task.params || {};
        const order = await this.client.sellPosition(ticker, side, count, priceCents);
        return { order };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async _discoverMarkets(state) {
    try {
      const markets = await this.client.discoverMarkets(this.seriesTicker);
      const now = Date.now();
      const processed = [];

      for (const m of markets) {
        const closeTime = new Date(m.close_time).getTime();
        if (closeTime <= now) continue;

        const ticker = m.ticker;
        if (!state.marketOpenPrices[ticker] && state.btcPrice.binance) {
          state.marketOpenPrices[ticker] = state.btcPrice.binance;
        }

        processed.push({
          ticker,
          eventTicker: m.event_ticker,
          title: m.title,
          openTime: new Date(m.open_time).getTime(),
          closeTime,
          yesBid: m.yes_bid / 100,
          yesAsk: m.yes_ask / 100,
          noBid: m.no_bid / 100,
          noAsk: m.no_ask / 100,
          yesBidCents: m.yes_bid,
          yesAskCents: m.yes_ask,
          noBidCents: m.no_bid,
          noAskCents: m.no_ask,
          lastPrice: m.last_price / 100,
          minutesUntilClose: Math.floor((closeTime - now) / 60000),
          secondsUntilClose: Math.floor((closeTime - now) / 1000),
          status: m.status,
        });
      }

      state.updateMarkets(processed);

      // Clean up old open prices
      for (const ticker of Object.keys(state.marketOpenPrices)) {
        if (!processed.find(m => m.ticker === ticker)) {
          delete state.marketOpenPrices[ticker];
        }
      }

      return { markets: processed, count: processed.length };
    } catch (err) {
      return { markets: [], count: 0, error: err.message };
    }
  }

  async _refreshMarkets(state) {
    const markets = state.activeMarkets;
    if (markets.length === 0) return { markets: [], count: 0 };

    const results = await Promise.allSettled(
      markets.map(m => this.client.fetchMarket(m.ticker))
    );

    const refreshed = markets.map((m, i) => {
      if (results[i].status === 'fulfilled' && results[i].value) {
        return { ...m, ...results[i].value };
      }
      return m;
    });

    state.updateMarkets(refreshed);
    this._marketCache = { data: refreshed, ts: Date.now() };

    // Update unrealized P&L
    if (state.openPositions.length > 0) {
      let unrealized = 0;
      for (const pos of state.openPositions) {
        const market = refreshed.find(m => m.ticker === pos.ticker);
        if (!market) continue;
        const currentBid = pos.side === 'yes' ? (market.yesBid || 0) : (market.noBid || 0);
        unrealized += (currentBid - pos.priceDecimal) * (pos.filledContracts || pos.contracts);
      }
      state.updateUnrealizedPnL(unrealized);
    }

    return { markets: refreshed, count: refreshed.length };
  }

  async _reconcilePositions(state) {
    try {
      // Prune ghost orders
      const beforePrune = state.openPositions.length;
      state.openPositions = state.openPositions.filter(p => {
        if ((p.filledContracts || 0) === 0 && p.type !== 'RECONCILED') return false;
        return true;
      });
      const pruned = beforePrune - state.openPositions.length;

      // Clear stale pending orders
      const stalePending = state.pendingOrders.length;
      if (stalePending > 0) state.pendingOrders = [];

      const kalshiPositions = await this.client.fetchPositions(this.seriesTicker);
      const localPositions = state.openPositions;

      // Build maps
      const kalshiMap = new Map();
      for (const kp of kalshiPositions) {
        if (kp.yes_sub_total > 0) kalshiMap.set(`${kp.ticker}:yes`, { ticker: kp.ticker, side: 'yes', contracts: kp.yes_sub_total });
        if (kp.no_sub_total > 0) kalshiMap.set(`${kp.ticker}:no`, { ticker: kp.ticker, side: 'no', contracts: kp.no_sub_total });
      }

      const localMap = new Map();
      for (const lp of localPositions) {
        const key = `${lp.ticker}:${lp.side}`;
        const existing = localMap.get(key);
        if (existing) {
          existing.contracts += (lp.filledContracts || lp.contracts);
          existing.positions.push(lp);
        } else {
          localMap.set(key, { contracts: lp.filledContracts || lp.contracts, positions: [lp] });
        }
      }

      let added = 0, removed = 0;

      // Add missing positions from Kalshi
      for (const [key, kp] of kalshiMap) {
        if (!localMap.has(key)) {
          state.openPositions.push({
            orderId: `reconciled-${kp.ticker}-${kp.side}-${Date.now()}`,
            clientOrderId: 'reconciled',
            ticker: kp.ticker, type: 'RECONCILED', side: kp.side,
            contracts: kp.contracts, filledContracts: kp.contracts,
            priceCents: 0, priceDecimal: 0, totalCost: 0,
            edge: 0, modelProb: 0, reason: 'Reconciled from Kalshi portfolio',
            entryTime: Date.now(), closeTime: 0, status: 'executed', isDualSide: false,
          });
          added++;
        }
      }

      // Remove phantom local positions
      const tickersToRemove = [];
      for (const [key, lp] of localMap) {
        if (!kalshiMap.has(key)) {
          for (const pos of lp.positions) tickersToRemove.push(pos.orderId);
          removed += lp.positions.length;
        }
      }
      if (tickersToRemove.length > 0) {
        state.openPositions = state.openPositions.filter(p => !tickersToRemove.includes(p.orderId));
      }

      if (added > 0 || removed > 0) state.saveNow();

      return { added, removed, pruned, total: state.openPositions.length };
    } catch (err) {
      return { error: err.message, added: 0, removed: 0 };
    }
  }

  /**
   * Direct access to underlying client and cache.
   */
  getClient() { return this.client; }
  getMarketCache() { return this._marketCache; }

  async stop() {
    await super.stop();
  }
}

module.exports = KalshiMarketData;

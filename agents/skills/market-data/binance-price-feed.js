/**
 * BinancePriceFeed Skill
 *
 * Wraps the existing BinanceFeed as an agent skill.
 * Provides real-time BTC spot pricing via WebSocket with REST fallback.
 *
 * Capabilities: get-binance-price, get-volatility, get-price-history
 */

const BaseSkill = require('../../core/base-skill');
const BinanceFeed = require('../../../bot/binance-ws');

class BinancePriceFeed extends BaseSkill {
  constructor() {
    super({
      name: 'binance-price-feed',
      description: 'Real-time BTC spot price from Binance via WebSocket with REST fallback',
      domain: 'market-data',
      capabilities: ['get-binance-price', 'get-volatility', 'get-price-history'],
      dependencies: ['state-manager'],
    });

    this.feed = null;
  }

  async initialize(context) {
    await super.initialize(context);
    const stateManager = context.registry.get('state-manager');
    this.feed = new BinanceFeed(stateManager.botState, 'btcusdt');
  }

  async start() {
    await super.start();
    this.feed.start();
  }

  async handleTask(task) {
    switch (task.action) {
      case 'get-binance-price': {
        const stateManager = this.context.registry.get('state-manager');
        return {
          price: stateManager.botState.btcPrice.binance,
          bid: stateManager.botState.btcPrice.binanceBid,
          ask: stateManager.botState.btcPrice.binanceAsk,
          lastUpdate: stateManager.botState.btcPrice.lastUpdate,
        };
      }

      case 'get-volatility': {
        const windowSeconds = task.params?.windowSeconds || 300;
        return { volatility: this.feed.getRecentVolatility(windowSeconds) };
      }

      case 'get-price-history': {
        return { history: this.feed.priceHistory };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  /**
   * Direct access to the underlying feed (for skills that need it).
   */
  getFeed() {
    return this.feed;
  }

  async stop() {
    if (this.feed) this.feed.stop();
    await super.stop();
  }
}

module.exports = BinancePriceFeed;

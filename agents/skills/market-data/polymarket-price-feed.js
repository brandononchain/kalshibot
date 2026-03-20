/**
 * PolymarketPriceFeed Skill
 *
 * Wraps the existing PolymarketFeed as an agent skill.
 * Provides cross-market price data for arbitrage signal generation.
 *
 * Capabilities: get-polymarket-price, get-cached-polymarket-price
 */

const BaseSkill = require('../../core/base-skill');
const PolymarketFeed = require('../../../bot/polymarket');

class PolymarketPriceFeed extends BaseSkill {
  constructor() {
    super({
      name: 'polymarket-price-feed',
      description: 'Polymarket prediction contract prices for cross-market arbitrage',
      domain: 'market-data',
      capabilities: ['get-polymarket-price', 'get-cached-polymarket-price'],
      dependencies: ['state-manager'],
    });

    this.feed = null;
  }

  async initialize(context) {
    await super.initialize(context);
    const stateManager = context.registry.get('state-manager');
    this.feed = new PolymarketFeed(stateManager.botState, context.config);
  }

  async start() {
    await super.start();
    this.feed.start();
  }

  async handleTask(task) {
    switch (task.action) {
      case 'get-polymarket-price': {
        const closeTime = task.params?.closeTime;
        if (!closeTime) throw new Error('closeTime required');
        const price = await this.feed.fetchPrice(closeTime);
        return { price };
      }

      case 'get-cached-polymarket-price': {
        const closeTime = task.params?.closeTime;
        if (!closeTime) throw new Error('closeTime required');
        return { price: this.feed.getCachedPrice(closeTime) };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  /**
   * Direct access — used by SignalGenerator for cached price lookups.
   */
  getCachedPrice(closeTimeMs) {
    return this.feed ? this.feed.getCachedPrice(closeTimeMs) : null;
  }

  async stop() {
    if (this.feed) this.feed.stop();
    await super.stop();
  }
}

module.exports = PolymarketPriceFeed;

/**
 * RedstonePriceFeed Skill
 *
 * Wraps the existing RedstoneFeed as an agent skill.
 * Provides cryptographically-signed BTC price data for validation.
 *
 * Capabilities: get-redstone-price
 */

const BaseSkill = require('../../core/base-skill');
const RedstoneFeed = require('../../../bot/redstone');

class RedstonePriceFeed extends BaseSkill {
  constructor() {
    super({
      name: 'redstone-price-feed',
      description: 'Cryptographically-signed BTC price from RedStone oracle network',
      domain: 'market-data',
      capabilities: ['get-redstone-price'],
      dependencies: ['state-manager'],
    });

    this.feed = null;
  }

  async initialize(context) {
    await super.initialize(context);
    const stateManager = context.registry.get('state-manager');
    this.feed = new RedstoneFeed(stateManager.botState);
  }

  async start() {
    await super.start();
    this.feed.start();
  }

  async handleTask(task) {
    switch (task.action) {
      case 'get-redstone-price': {
        return {
          price: this.feed.lastPrice,
          timestamp: this.feed.lastTimestamp,
        };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async stop() {
    if (this.feed) this.feed.stop();
    await super.stop();
  }
}

module.exports = RedstonePriceFeed;

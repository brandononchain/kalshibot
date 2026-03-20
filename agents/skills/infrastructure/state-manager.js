/**
 * StateManager Skill
 *
 * Wraps BotState as an agent skill. Provides the shared state context
 * that all other skills read from and write to.
 *
 * This is always initialized first (no dependencies).
 *
 * Capabilities: save-state, get-snapshot, get-stats
 */

const BaseSkill = require('../../core/base-skill');
const BotState = require('../../../bot/state');

class StateManager extends BaseSkill {
  constructor() {
    super({
      name: 'state-manager',
      description: 'Shared bot state: prices, positions, stats, and persistence',
      domain: 'infrastructure',
      capabilities: ['save-state', 'get-snapshot', 'get-stats'],
      dependencies: [], // No dependencies — initialized first
    });

    this.botState = new BotState();
  }

  async initialize(context) {
    await super.initialize(context);
  }

  async handleTask(task) {
    switch (task.action) {
      case 'save-state': {
        this.botState.saveNow();
        return { saved: true };
      }

      case 'get-snapshot': {
        return { snapshot: this.botState.getSnapshot() };
      }

      case 'get-stats': {
        return { stats: { ...this.botState.stats } };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async stop() {
    this.botState.saveNow();
    await super.stop();
  }
}

module.exports = StateManager;

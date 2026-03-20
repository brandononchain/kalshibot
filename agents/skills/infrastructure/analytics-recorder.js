/**
 * AnalyticsRecorder Skill
 *
 * Wraps the SQLite AnalyticsDB as an agent skill.
 * Provides structured logging for signals, orders, fills, and market snapshots.
 *
 * Capabilities: log-signal, log-order, log-market-snapshot
 */

const BaseSkill = require('../../core/base-skill');
const AnalyticsDB = require('../../../bot/db');

class AnalyticsRecorder extends BaseSkill {
  constructor() {
    super({
      name: 'analytics-recorder',
      description: 'SQLite analytics ledger for signals, orders, fills, and market snapshots',
      domain: 'infrastructure',
      capabilities: ['log-signal', 'log-order', 'log-market-snapshot'],
      dependencies: [], // No dependencies
    });

    this.db = new AnalyticsDB();
  }

  async initialize(context) {
    await super.initialize(context);
  }

  async handleTask(task) {
    switch (task.action) {
      case 'log-signal': {
        const { signal, executed, blockedReason } = task.params || {};
        const id = this.db.logSignal(signal, executed, blockedReason);
        return { signalId: id };
      }

      case 'log-order': {
        const { order, signalId } = task.params || {};
        this.db.logOrder(order, signalId);
        return { logged: true };
      }

      case 'log-market-snapshot': {
        const { market, btcPrice, context } = task.params || {};
        this.db.logMarketSnapshot(market, btcPrice, context);
        return { logged: true };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  // Direct access methods for skills that need synchronous DB access

  getDB() { return this.db; }

  logSignalDirect(signal, executed, blockedReason = null) {
    return this.db.logSignal(signal, executed, blockedReason);
  }

  logBlockedSignal(signal, reason) {
    return this.db.logSignal(signal, false, reason);
  }

  logOrderDirect(order, signalId) {
    this.db.logOrder(order, signalId);
  }

  updateOrderDirect(orderId, status, fillCount, takerFillCost, takerFees) {
    this.db.updateOrder(orderId, status, fillCount, takerFillCost, takerFees);
  }

  logMarketSnapshotDirect(market, btcPrice, context) {
    this.db.logMarketSnapshot(market, btcPrice, context);
  }

  async stop() {
    this.db.close();
    await super.stop();
  }
}

module.exports = AnalyticsRecorder;

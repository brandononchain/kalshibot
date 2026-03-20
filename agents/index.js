/**
 * Kalshibot Agentic Framework
 *
 * Architecture:
 *
 *   MasterAgent (lifecycle owner)
 *     └── Orchestrator (task router & workflow coordinator)
 *           └── SkillRegistry (discovery & dependency resolution)
 *                 ├── Market Data Skills
 *                 │     ├── binance-price-feed
 *                 │     ├── polymarket-price-feed
 *                 │     ├── redstone-price-feed
 *                 │     └── kalshi-market-data
 *                 ├── Analysis Skills
 *                 │     ├── probability-model
 *                 │     ├── trend-analysis
 *                 │     └── signal-generator
 *                 ├── Trading Skills
 *                 │     ├── risk-manager
 *                 │     ├── order-executor
 *                 │     └── position-manager
 *                 └── Infrastructure Skills
 *                       ├── state-manager
 *                       └── analytics-recorder
 *
 * Usage:
 *   const { MasterAgent } = require('./agents');
 *   const agent = new MasterAgent(config);
 *   await agent.start();
 */

const MasterAgent = require('./core/master-agent');
const BaseSkill = require('./core/base-skill');
const SkillRegistry = require('./core/skill-registry');
const Orchestrator = require('./core/orchestrator');

module.exports = {
  MasterAgent,
  BaseSkill,
  SkillRegistry,
  Orchestrator,
};

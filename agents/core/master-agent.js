/**
 * MasterAgent — Top-level agent that owns the entire bot lifecycle.
 *
 * Responsibilities:
 *  1. Registers all skills with the SkillRegistry
 *  2. Resolves dependencies and initializes skills in topological order
 *  3. Configures the Orchestrator with routes and workflows
 *  4. Runs the main trading loop (scan → analyze → decide → execute)
 *  5. Handles graceful shutdown
 *
 * The MasterAgent is the single entry point — server.js creates it
 * and calls start()/stop(). Everything else is orchestrated through skills.
 */

const EventEmitter = require('events');
const SkillRegistry = require('./skill-registry');
const Orchestrator = require('./orchestrator');

// Market Data Skills
const BinancePriceFeed = require('../skills/market-data/binance-price-feed');
const PolymarketPriceFeed = require('../skills/market-data/polymarket-price-feed');
const RedstonePriceFeed = require('../skills/market-data/redstone-price-feed');
const KalshiMarketData = require('../skills/market-data/kalshi-market-data');

// Analysis Skills
const ProbabilityModel = require('../skills/analysis/probability-model');
const TrendAnalysis = require('../skills/analysis/trend-analysis');
const SignalGenerator = require('../skills/analysis/signal-generator');

// Trading Skills
const RiskManager = require('../skills/trading/risk-manager');
const OrderExecutor = require('../skills/trading/order-executor');
const PositionManager = require('../skills/trading/position-manager');

// Infrastructure Skills
const StateManager = require('../skills/infrastructure/state-manager');
const AnalyticsRecorder = require('../skills/infrastructure/analytics-recorder');

class MasterAgent extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.registry = new SkillRegistry();
    this.orchestrator = new Orchestrator(this.registry);

    this.running = false;
    this._scanInterval = null;
    this._takeProfitInterval = null;
    this._discoveryInterval = null;
    this._balanceInterval = null;

    this._registerSkills();
    this._configureRoutes();
    this._configureWorkflows();
  }

  /**
   * Access the state manager skill (used by server.js for snapshot/save).
   */
  get state() {
    const sm = this.registry.get('state-manager');
    return sm ? sm.botState : null;
  }

  // ===== Skill Registration =====

  _registerSkills() {
    // Infrastructure (no dependencies — initialized first)
    this.registry.register(new StateManager());
    this.registry.register(new AnalyticsRecorder());

    // Market Data (depends on state-manager)
    this.registry.register(new BinancePriceFeed());
    this.registry.register(new PolymarketPriceFeed());
    this.registry.register(new RedstonePriceFeed());
    this.registry.register(new KalshiMarketData());

    // Analysis (depends on market data skills)
    this.registry.register(new TrendAnalysis());
    this.registry.register(new ProbabilityModel());
    this.registry.register(new SignalGenerator());

    // Trading (depends on analysis + market data)
    this.registry.register(new RiskManager());
    this.registry.register(new OrderExecutor());
    this.registry.register(new PositionManager());
  }

  // ===== Route Configuration =====

  _configureRoutes() {
    const o = this.orchestrator;

    // Direct routes — action → skill
    o.route('fetch-balance', 'kalshi-market-data');
    o.route('discover-markets', 'kalshi-market-data');
    o.route('refresh-markets', 'kalshi-market-data');
    o.route('fetch-market', 'kalshi-market-data');
    o.route('reconcile-positions', 'kalshi-market-data');

    o.route('get-binance-price', 'binance-price-feed');
    o.route('get-volatility', 'binance-price-feed');

    o.route('get-polymarket-price', 'polymarket-price-feed');

    o.route('get-redstone-price', 'redstone-price-feed');

    o.route('calculate-probability', 'probability-model');
    o.route('get-trend', 'trend-analysis');

    o.route('generate-signals', 'signal-generator');
    o.route('generate-take-profit-signals', 'signal-generator');

    o.route('check-risk', 'risk-manager');
    o.route('check-position-limits', 'risk-manager');
    o.route('check-balance', 'risk-manager');

    o.route('place-order', 'order-executor');
    o.route('cancel-order', 'order-executor');
    o.route('check-order-status', 'order-executor');

    o.route('take-profit', 'position-manager');
    o.route('settle-position', 'position-manager');

    o.route('save-state', 'state-manager');
    o.route('get-snapshot', 'state-manager');

    o.route('log-signal', 'analytics-recorder');
    o.route('log-order', 'analytics-recorder');
    o.route('log-market-snapshot', 'analytics-recorder');

    // Parallel routes — fetch all price feeds at once
    o.parallel('refresh-all-prices', [
      'binance-price-feed',
      'polymarket-price-feed',
      'redstone-price-feed',
    ]);
  }

  // ===== Workflow Configuration =====

  _configureWorkflows() {
    const o = this.orchestrator;

    // Main scan-and-trade workflow — each step's result merges into ctx for the next
    o.workflow('scan-and-trade', {
      steps: [
        {
          action: 'refresh-markets',
          skill: 'kalshi-market-data',
        },
        {
          action: 'generate-signals',
          skill: 'signal-generator',
        },
        {
          action: 'evaluate-signals',
          skill: 'risk-manager',
          condition: (ctx) => ctx.signals && ctx.signals.length > 0,
        },
        {
          action: 'execute-signals',
          skill: 'order-executor',
          condition: (ctx) => ctx.approvedSignals && ctx.approvedSignals.length > 0,
        },
      ],
    });

    // Take-profit workflow
    o.workflow('check-take-profit', {
      steps: [
        {
          action: 'generate-take-profit-signals',
          skill: 'signal-generator',
        },
        {
          action: 'execute-take-profit',
          skill: 'position-manager',
          condition: (ctx) => ctx.takeProfitSignals && ctx.takeProfitSignals.length > 0,
        },
      ],
    });

    // Startup workflow
    o.workflow('startup', {
      steps: [
        { action: 'fetch-balance', skill: 'kalshi-market-data' },
        { action: 'reconcile-positions', skill: 'kalshi-market-data' },
        { action: 'discover-markets', skill: 'kalshi-market-data' },
      ],
    });
  }

  // ===== Lifecycle =====

  async start() {
    this.running = true;
    this.log('MasterAgent starting — initializing skills');

    const stateManager = this.registry.get('state-manager');
    stateManager.botState.updateIntent({
      status: 'initializing',
      message: 'Initializing agent skills...',
    });

    // Build shared context for all skills
    const context = {
      config: this.config,
      registry: this.registry,
      orchestrator: this.orchestrator,
    };

    // Initialize skills in dependency order
    const initOrder = this.registry.getInitOrder();
    this.log(`Init order: ${initOrder.join(' → ')}`);

    for (const skillName of initOrder) {
      const skill = this.registry.get(skillName);
      try {
        await skill.initialize(context);
        this.log(`  initialized ${skillName}`);
      } catch (err) {
        this.log(`  ${skillName} failed: ${err.message}`, 'ERROR');
        throw err;
      }
    }

    // Start all skills
    for (const skillName of initOrder) {
      const skill = this.registry.get(skillName);
      try {
        await skill.start();
      } catch (err) {
        this.log(`  ${skillName} start failed: ${err.message}`, 'ERROR');
      }
    }

    this.log('All skills started');

    // Run startup workflow: fetch balance → reconcile positions → discover markets
    stateManager.botState.updateIntent({
      status: 'initializing',
      message: 'Connecting to Kalshi...',
    });

    const startupResult = await this.orchestrator.dispatch({
      action: 'startup',
      workflow: 'startup',
      params: {},
    });

    if (!startupResult.success) {
      this.log(`Startup workflow failed: ${JSON.stringify(startupResult)}`, 'ERROR');
      throw new Error('Startup workflow failed');
    }

    // Log startup results
    const balance = stateManager.botState.balance;
    this.log(`Kalshi connected. Balance: $${balance.total.toFixed(2)}`);
    this.log(`Tracking ${stateManager.botState.activeMarkets.length} markets (${this.config.SERIES_TICKER})`);

    // Wait for Binance price feed
    stateManager.botState.updateIntent({
      status: 'waiting',
      message: 'Waiting for Binance price feed...',
    });

    await this._waitForPrice();

    // Start the OrderManager (manages fill polling and stale order cancellation)
    const orderExecutor = this.registry.get('order-executor');
    this.log('Order manager started');

    // Start periodic auto-trade loops
    this._scanInterval = setInterval(() => this._runScan(), 2000);
    this._takeProfitInterval = setInterval(() => this._runTakeProfit(), 3000);
    this._discoveryInterval = setInterval(() => this._runDiscovery(), 15000);
    this._balanceInterval = setInterval(() => this._runBalanceRefresh(), 15000);

    stateManager.botState.updateIntent({
      status: 'scanning',
      message: 'Scanning for opportunities...',
    });

    this.log('Engine running. All systems active.');
    return stateManager.botState;
  }

  async _waitForPrice() {
    const stateManager = this.registry.get('state-manager');
    return new Promise((resolve) => {
      if (stateManager.botState.btcPrice.binance) return resolve();
      const check = setInterval(() => {
        if (stateManager.botState.btcPrice.binance) {
          clearInterval(check);
          this.log(`BTC price: $${stateManager.botState.btcPrice.binance.toFixed(2)}`);
          resolve();
        }
      }, 500);
      setTimeout(() => { clearInterval(check); resolve(); }, 15000);
    });
  }

  // ===== Periodic Auto-Trade Runners =====

  _scanRunning = false;

  /**
   * Main auto-trade loop. Runs every 2 seconds:
   *   refresh markets → generate signals → risk check → execute orders
   */
  async _runScan() {
    if (this._scanRunning || !this.running) return;
    this._scanRunning = true;

    const state = this.state;

    try {
      const result = await this.orchestrator.dispatch({
        action: 'scan-and-trade',
        workflow: 'scan-and-trade',
        params: {},
      });

      if (!result.success) {
        if (result.failedStep) {
          this.log(`Scan workflow failed at step '${result.failedStep}': ${result.stepResults?.find(s => !s.success)?.error || 'unknown'}`, 'ERROR');
        }
        return;
      }

      // Extract results from workflow context to update UI intent
      const ctx = result.context || {};
      const signals = ctx.signals || [];
      const approvedSignals = ctx.approvedSignals || [];
      const executedSignals = ctx.executedSignals || [];
      const totalExecuted = ctx.totalExecuted || 0;

      if (signals.length > 0) {
        const best = signals[0];
        state.updateIntent({
          status: totalExecuted > 0 ? 'executing' : 'signal_detected',
          message: totalExecuted > 0
            ? `Executed ${totalExecuted} trade(s)`
            : `${best.type}: ${best.reason}`,
          lastSignal: best,
          modelProbability: best.modelProb,
          currentEdge: best.edge,
          action: `BUY ${best.side.toUpperCase()} @ ${best.priceCents}c`,
        });

        // Log signal activity
        if (totalExecuted > 0) {
          for (const exec of executedSignals) {
            if (exec.status === 'executed') {
              this.log(`Executed: ${exec.signal} → order ${exec.orderId}`, 'SUCCESS');
            } else if (exec.status === 'blocked') {
              this.log(`Blocked: ${exec.signal} (${exec.reason})`, 'WARN');
            } else if (exec.status === 'error') {
              this.log(`Execution error: ${exec.signal} — ${exec.error}`, 'ERROR');
            }
          }
        }
      } else {
        state.updateIntent({
          status: 'scanning',
          message: 'Scanning for opportunities...',
          currentEdge: null,
          action: null,
        });
      }
    } catch (err) {
      this.log(`Scan error: ${err.message}`, 'ERROR');
    } finally {
      this._scanRunning = false;
    }
  }

  /**
   * Take-profit loop. Runs every 3 seconds for open positions.
   * Sells positions that hit >15% gain or >50% of max possible gain.
   */
  async _runTakeProfit() {
    if (!this.running) return;
    const state = this.state;
    if (!state || state.openPositions.length === 0) return;

    try {
      const result = await this.orchestrator.dispatch({
        action: 'check-take-profit',
        workflow: 'check-take-profit',
        params: {},
      });

      if (!result.success) return;

      const ctx = result.context || {};
      const tpSignals = ctx.takeProfitSignals || [];
      const tpResults = ctx.results || [];

      for (let i = 0; i < tpResults.length; i++) {
        const tp = tpSignals[i];
        const res = tpResults[i];
        if (!tp) continue;

        if (res.status === 'sold') {
          state.updateIntent({
            status: 'taking_profit',
            message: `Take profit on ${tp.ticker}`,
            action: `SELL ${tp.side.toUpperCase()} @ ${tp.sellPriceCents}c`,
          });
          this.log(
            `Take profit: ${tp.ticker} ${tp.side} @ ${tp.sellPriceCents}c (+${tp.profitPct.toFixed(1)}%) | P&L: ${res.pnl >= 0 ? '+' : ''}$${res.pnl.toFixed(2)}`,
            res.pnl >= 0 ? 'SUCCESS' : 'WARN'
          );
        } else if (res.status === 'error') {
          this.log(`Take profit error: ${tp.ticker} — ${res.error}`, 'ERROR');
        }
      }
    } catch (err) {
      this.log(`Take profit error: ${err.message}`, 'ERROR');
    }
  }

  /**
   * Market discovery. Runs every 15 seconds.
   * Finds new active contracts in the KXBTC15M series.
   */
  async _runDiscovery() {
    if (!this.running) return;
    try {
      const result = await this.orchestrator.dispatch({ action: 'discover-markets', params: {} });
      if (result.success && result.count > 0) {
        this.log(`Tracking ${result.count} markets (${this.config.SERIES_TICKER})`);
      }
    } catch (err) {
      this.log(`Discovery error: ${err.message}`, 'ERROR');
    }
  }

  /**
   * Balance refresh. Runs every 15 seconds.
   */
  async _runBalanceRefresh() {
    if (!this.running) return;
    try {
      await this.orchestrator.dispatch({ action: 'fetch-balance', params: {} });
    } catch (err) {
      this.log(`Balance refresh error: ${err.message}`, 'WARN');
    }
  }

  // ===== Shutdown =====

  stop() {
    this.running = false;

    if (this._scanInterval) clearInterval(this._scanInterval);
    if (this._takeProfitInterval) clearInterval(this._takeProfitInterval);
    if (this._discoveryInterval) clearInterval(this._discoveryInterval);
    if (this._balanceInterval) clearInterval(this._balanceInterval);

    // Stop all skills in reverse init order
    const initOrder = this.registry.getInitOrder();
    for (const skillName of [...initOrder].reverse()) {
      try {
        this.registry.get(skillName).stop();
      } catch (err) {
        // ignore cleanup errors
      }
    }

    const stateManager = this.registry.get('state-manager');
    if (stateManager) {
      stateManager.botState.updateIntent({ status: 'stopped', message: 'Bot stopped' });
      const stats = stateManager.botState.stats;
      this.log(`Shutdown. Trades: ${stats.totalTrades} | P&L: $${stats.totalPnL.toFixed(2)}`);
    }
  }

  // ===== Logging =====

  log(msg, level = 'INFO') {
    const ts = new Date().toISOString();
    const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', ERROR: '\x1b[31m', WARN: '\x1b[33m' };
    console.log(`${colors[level] || ''}[${ts}] [MasterAgent] [${level}]\x1b[0m ${msg}`);

    const stateManager = this.registry.get('state-manager');
    if (stateManager && stateManager.botState) {
      stateManager.botState.logTrade({
        type: 'LOG',
        level,
        message: `[MasterAgent] ${msg}`,
      });
    }
  }
}

module.exports = MasterAgent;

/**
 * BaseSkill — Abstract base class for all agent skills.
 *
 * Every skill in the system extends this class. Skills are self-contained
 * units of capability that can be discovered, composed, and orchestrated
 * by the MasterAgent via the Orchestrator.
 *
 * Lifecycle: construct → initialize(context) → start() → execute(task) → stop()
 */

const EventEmitter = require('events');

class BaseSkill extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.name        — Unique skill identifier (e.g. 'binance-price-feed')
   * @param {string} options.description — Human-readable description of what this skill does
   * @param {string} options.domain      — Domain category: 'market-data' | 'analysis' | 'trading' | 'infrastructure'
   * @param {string[]} options.capabilities — List of capability tags for orchestrator routing
   * @param {string[]} options.dependencies — Names of other skills this one depends on
   */
  constructor({ name, description, domain, capabilities = [], dependencies = [] }) {
    super();
    if (!name) throw new Error('Skill must have a name');

    this.name = name;
    this.description = description || '';
    this.domain = domain || 'general';
    this.capabilities = capabilities;
    this.dependencies = dependencies;

    this.status = 'idle'; // idle | initializing | running | stopped | error
    this.context = null;  // Shared context injected at initialize()
    this.metrics = {
      invocations: 0,
      errors: 0,
      lastInvokedAt: null,
      avgLatencyMs: 0,
      totalLatencyMs: 0,
    };
  }

  /**
   * Initialize the skill with shared context (state, config, references to other skills).
   * Called once before start().
   */
  async initialize(context) {
    this.context = context;
    this.status = 'initializing';
  }

  /**
   * Start the skill (connect feeds, begin polling, etc).
   * Called after all skills are initialized and dependencies are satisfied.
   */
  async start() {
    this.status = 'running';
  }

  /**
   * Execute a task. This is the primary interface the Orchestrator uses.
   *
   * @param {Object} task — Task descriptor with at least { action: string, params: {} }
   * @returns {Object} — Result of the task execution
   */
  async execute(task) {
    const startTime = Date.now();
    this.metrics.invocations++;
    this.metrics.lastInvokedAt = startTime;

    try {
      const result = await this.handleTask(task);
      this._recordLatency(startTime);
      return { success: true, skill: this.name, ...result };
    } catch (err) {
      this.metrics.errors++;
      this._recordLatency(startTime);
      this.emit('error', { skill: this.name, error: err.message, task });
      return { success: false, skill: this.name, error: err.message };
    }
  }

  /**
   * Override this in subclasses to handle tasks.
   * @abstract
   */
  async handleTask(task) {
    throw new Error(`${this.name}: handleTask() not implemented`);
  }

  /**
   * Stop the skill gracefully.
   */
  async stop() {
    this.status = 'stopped';
  }

  /**
   * Returns a descriptor for the skill registry.
   */
  describe() {
    return {
      name: this.name,
      description: this.description,
      domain: this.domain,
      capabilities: this.capabilities,
      dependencies: this.dependencies,
      status: this.status,
      metrics: { ...this.metrics },
    };
  }

  _recordLatency(startTime) {
    const elapsed = Date.now() - startTime;
    this.metrics.totalLatencyMs += elapsed;
    this.metrics.avgLatencyMs = this.metrics.totalLatencyMs / this.metrics.invocations;
  }
}

module.exports = BaseSkill;

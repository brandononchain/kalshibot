/**
 * SkillRegistry — Central registry for discovering and resolving skills.
 *
 * Skills register themselves here. The Orchestrator queries the registry
 * to find skills that match a given capability or domain. Handles
 * dependency resolution for skill initialization ordering.
 */

class SkillRegistry {
  constructor() {
    this._skills = new Map();       // name → skill instance
    this._byCapability = new Map(); // capability → Set<skillName>
    this._byDomain = new Map();     // domain → Set<skillName>
  }

  /**
   * Register a skill instance.
   */
  register(skill) {
    if (this._skills.has(skill.name)) {
      throw new Error(`Skill '${skill.name}' already registered`);
    }

    this._skills.set(skill.name, skill);

    // Index by capabilities
    for (const cap of skill.capabilities) {
      if (!this._byCapability.has(cap)) {
        this._byCapability.set(cap, new Set());
      }
      this._byCapability.get(cap).add(skill.name);
    }

    // Index by domain
    if (!this._byDomain.has(skill.domain)) {
      this._byDomain.set(skill.domain, new Set());
    }
    this._byDomain.get(skill.domain).add(skill.name);

    return this;
  }

  /**
   * Get a skill by name.
   */
  get(name) {
    return this._skills.get(name) || null;
  }

  /**
   * Find skills that have a specific capability.
   */
  findByCapability(capability) {
    const names = this._byCapability.get(capability);
    if (!names) return [];
    return [...names].map(n => this._skills.get(n));
  }

  /**
   * Find skills in a specific domain.
   */
  findByDomain(domain) {
    const names = this._byDomain.get(domain);
    if (!names) return [];
    return [...names].map(n => this._skills.get(n));
  }

  /**
   * Get all registered skills.
   */
  all() {
    return [...this._skills.values()];
  }

  /**
   * Compute initialization order respecting dependencies (topological sort).
   * Returns skill names in order they should be initialized.
   */
  getInitOrder() {
    const visited = new Set();
    const order = [];
    const visiting = new Set(); // Cycle detection

    const visit = (name) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving '${name}'`);
      }
      visiting.add(name);

      const skill = this._skills.get(name);
      if (!skill) throw new Error(`Dependency '${name}' not registered`);

      for (const dep of skill.dependencies) {
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this._skills.keys()) {
      visit(name);
    }

    return order;
  }

  /**
   * Describe all registered skills (for monitoring/UI).
   */
  describeAll() {
    return this.all().map(s => s.describe());
  }

  /**
   * Number of registered skills.
   */
  get size() {
    return this._skills.size;
  }
}

module.exports = SkillRegistry;

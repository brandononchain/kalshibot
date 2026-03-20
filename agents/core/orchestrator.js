/**
 * Orchestrator — Routes tasks to skills and coordinates multi-skill workflows.
 *
 * The Orchestrator is the "brain" that decomposes high-level intents
 * from the MasterAgent into concrete skill invocations. It supports:
 *
 *  1. Direct routing:   task → single skill
 *  2. Pipeline routing:  task → skill A → skill B → skill C (sequential)
 *  3. Parallel routing:  task → [skill A, skill B] (concurrent, results merged)
 *  4. Workflow routing:  task → predefined workflow (named sequence of steps)
 *
 * Workflows are registered as reusable patterns (e.g. "scan-and-trade").
 */

const EventEmitter = require('events');

class Orchestrator extends EventEmitter {
  /**
   * @param {SkillRegistry} registry
   */
  constructor(registry) {
    super();
    this.registry = registry;

    // Prevent Node.js from throwing on unhandled 'error' events
    this.on('error', () => {});
    this._workflows = new Map();  // workflowName → workflow definition
    this._routes = new Map();     // action → routing rule
    this.metrics = {
      tasksRouted: 0,
      workflowsExecuted: 0,
      routingErrors: 0,
    };
  }

  /**
   * Register a direct route: action string → skill name.
   */
  route(action, skillName) {
    this._routes.set(action, { type: 'direct', skillName });
    return this;
  }

  /**
   * Register a pipeline route: action → ordered list of skill names.
   * Each skill receives the previous skill's result merged into the task params.
   */
  pipeline(action, skillNames) {
    this._routes.set(action, { type: 'pipeline', skillNames });
    return this;
  }

  /**
   * Register a parallel route: action → skills to invoke concurrently.
   */
  parallel(action, skillNames) {
    this._routes.set(action, { type: 'parallel', skillNames });
    return this;
  }

  /**
   * Register a named workflow — a complex multi-step pattern.
   *
   * @param {string} name — Workflow name (e.g. 'scan-and-trade')
   * @param {Object} definition
   * @param {Array<Object>} definition.steps — Array of step descriptors:
   *   { action, skill?, params?, condition?, onResult? }
   */
  workflow(name, definition) {
    this._workflows.set(name, definition);
    return this;
  }

  /**
   * Dispatch a task. The orchestrator resolves the best route and executes.
   *
   * @param {Object} task — { action: string, params: {}, workflow?: string }
   * @returns {Object} — Aggregated result
   */
  async dispatch(task) {
    this.metrics.tasksRouted++;

    try {
      // 1. Check for explicit workflow reference
      if (task.workflow) {
        return await this._executeWorkflow(task.workflow, task);
      }

      // 2. Check registered routes
      const routeDef = this._routes.get(task.action);
      if (routeDef) {
        return await this._executeRoute(routeDef, task);
      }

      // 3. Capability-based discovery — find a skill that advertises this action
      const skills = this.registry.findByCapability(task.action);
      if (skills.length > 0) {
        // Pick the first capable skill (could be extended with scoring)
        return await skills[0].execute(task);
      }

      // 4. No route found
      this.metrics.routingErrors++;
      return { success: false, error: `No route for action '${task.action}'` };

    } catch (err) {
      this.metrics.routingErrors++;
      this.emit('error', { task, error: err.message });
      return { success: false, error: err.message };
    }
  }

  async _executeRoute(routeDef, task) {
    switch (routeDef.type) {
      case 'direct': {
        const skill = this.registry.get(routeDef.skillName);
        if (!skill) return { success: false, error: `Skill '${routeDef.skillName}' not found` };
        return await skill.execute(task);
      }

      case 'pipeline': {
        let result = {};
        for (const skillName of routeDef.skillNames) {
          const skill = this.registry.get(skillName);
          if (!skill) return { success: false, error: `Skill '${skillName}' not found` };

          const pipelineTask = {
            ...task,
            params: { ...task.params, ...result },
          };
          result = await skill.execute(pipelineTask);

          if (!result.success) return result; // Fail fast
        }
        return result;
      }

      case 'parallel': {
        const promises = routeDef.skillNames.map(skillName => {
          const skill = this.registry.get(skillName);
          if (!skill) return Promise.resolve({ success: false, error: `Skill '${skillName}' not found` });
          return skill.execute(task);
        });

        const results = await Promise.allSettled(promises);
        const merged = {
          success: true,
          results: results.map((r, i) => ({
            skill: routeDef.skillNames[i],
            ...(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }),
          })),
        };

        // Mark overall as failed if any sub-result failed
        merged.success = merged.results.every(r => r.success);
        return merged;
      }

      default:
        return { success: false, error: `Unknown route type '${routeDef.type}'` };
    }
  }

  async _executeWorkflow(workflowName, initialTask) {
    const definition = this._workflows.get(workflowName);
    if (!definition) {
      return { success: false, error: `Workflow '${workflowName}' not found` };
    }

    this.metrics.workflowsExecuted++;
    this.emit('workflow:start', { workflow: workflowName });

    let context = { ...initialTask.params };
    const stepResults = [];

    for (const step of definition.steps) {
      // Check condition (skip step if condition returns false)
      if (step.condition && !step.condition(context)) {
        stepResults.push({ step: step.action, skipped: true });
        continue;
      }

      const task = {
        action: step.action,
        params: { ...context, ...(step.params || {}) },
      };

      // Resolve target skill
      let result;
      if (step.skill) {
        const skill = this.registry.get(step.skill);
        if (!skill) {
          result = { success: false, error: `Skill '${step.skill}' not found` };
        } else {
          result = await skill.execute(task);
        }
      } else {
        // Use standard dispatch (route/capability lookup)
        result = await this.dispatch(task);
      }

      stepResults.push({ step: step.action, ...result });

      // Run onResult hook if provided
      if (step.onResult) {
        context = step.onResult(context, result);
      } else if (result.success) {
        // Merge result into context for next step
        const { success, skill: _, ...data } = result;
        context = { ...context, ...data };
      }

      // Fail fast if step failed and no error handler
      if (!result.success && !step.continueOnError) {
        this.emit('workflow:error', { workflow: workflowName, step: step.action, error: result.error });
        return { success: false, workflow: workflowName, failedStep: step.action, stepResults };
      }
    }

    this.emit('workflow:complete', { workflow: workflowName });
    return { success: true, workflow: workflowName, context, stepResults };
  }

  /**
   * Describe all routes and workflows (for monitoring).
   */
  describe() {
    return {
      routes: [...this._routes.entries()].map(([action, def]) => ({ action, ...def })),
      workflows: [...this._workflows.keys()],
      metrics: { ...this.metrics },
    };
  }
}

module.exports = Orchestrator;

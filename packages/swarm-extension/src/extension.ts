// @bun
// packages/swarm-extension/src/extension.ts
import { formatDuration as formatDuration2 } from "@oh-my-pi/pi-utils";
import * as fs2 from "fs/promises";
import * as path3 from "path";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent";
import * as path from "path";
import { formatDuration, truncate } from "@oh-my-pi/pi-utils";
import * as fs from "fs/promises";
import * as path2 from "path";
function buildDependencyGraph(def) {
  const deps = new Map;
  for (const name of def.agents.keys()) {
    deps.set(name, new Set);
  }
  for (const [name, agent] of def.agents) {
    for (const dep of agent.waitsFor) {
      if (deps.has(dep)) {
        deps.get(name).add(dep);
      }
    }
  }
  for (const [name, agent] of def.agents) {
    for (const target of agent.reportsTo) {
      if (deps.has(target)) {
        deps.get(target).add(name);
      }
    }
  }
  if ((def.mode === "pipeline" || def.mode === "sequential") && !hasExplicitDeps(deps)) {
    for (let i = 1;i < def.agentOrder.length; i++) {
      deps.get(def.agentOrder[i]).add(def.agentOrder[i - 1]);
    }
  }
  return deps;
}
function hasExplicitDeps(deps) {
  for (const s of deps.values()) {
    if (s.size > 0)
      return true;
  }
  return false;
}
function detectCycles(deps) {
  const inDegree = new Map;
  const forward = new Map;
  for (const [node, nodeDeps] of deps) {
    inDegree.set(node, nodeDeps.size);
    for (const dep of nodeDeps) {
      const list = forward.get(dep) ?? [];
      list.push(node);
      forward.set(dep, list);
    }
  }
  const queue = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0)
      queue.push(node);
  }
  const sorted = [];
  while (queue.length > 0) {
    const node = queue.shift();
    sorted.push(node);
    for (const dependent of forward.get(node) ?? []) {
      const newDegree = inDegree.get(dependent) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0)
        queue.push(dependent);
    }
  }
  if (sorted.length < deps.size) {
    return [...deps.keys()].filter((k) => !sorted.includes(k));
  }
  return null;
}
function buildExecutionWaves(deps) {
  const waves = [];
  const completed = new Set;
  const remaining = new Set(deps.keys());
  while (remaining.size > 0) {
    const wave = [];
    for (const node of remaining) {
      const nodeDeps = deps.get(node);
      let ready = true;
      for (const dep of nodeDeps) {
        if (!completed.has(dep)) {
          ready = false;
          break;
        }
      }
      if (ready) {
        wave.push(node);
      }
    }
    if (wave.length === 0) {
      throw new Error(`Deadlock: agents [${[...remaining].join(", ")}] cannot make progress. This indicates a bug in cycle detection.`);
    }
    wave.sort();
    for (const node of wave) {
      remaining.delete(node);
      completed.add(node);
    }
    waves.push(wave);
  }
  return waves;
}
async function executeSwarmAgent(agent, index, options) {
  const { workspace, swarmName, iteration, modelOverride, signal, onProgress, modelRegistry, settings, stateTracker } = options;
  const agentId = `swarm-${swarmName}-${agent.name}-${iteration}`;
  const agentDef = {
    name: agent.name,
    description: `Swarm agent: ${agent.role}`,
    systemPrompt: buildSystemPrompt(agent),
    source: "project"
  };
  await stateTracker.updateAgent(agent.name, {
    status: "running",
    iteration,
    startedAt: Date.now()
  });
  await stateTracker.appendLog(agent.name, `Starting iteration ${iteration}`);
  try {
    const result = await runSubprocess({
      cwd: workspace,
      agent: agentDef,
      task: agent.task,
      index,
      id: agentId,
      modelOverride,
      signal,
      onProgress: (progress) => onProgress?.(agent.name, progress),
      modelRegistry,
      settings,
      enableLsp: false,
      artifactsDir: path.join(stateTracker.swarmDir, "context")
    });
    const status = result.exitCode === 0 ? "completed" : "failed";
    await stateTracker.updateAgent(agent.name, {
      status,
      completedAt: Date.now(),
      error: result.error
    });
    await stateTracker.appendLog(agent.name, `Iteration ${iteration} ${status}${result.error ? `: ${result.error}` : ""}`);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await stateTracker.updateAgent(agent.name, {
      status: "failed",
      completedAt: Date.now(),
      error
    });
    await stateTracker.appendLog(agent.name, `Iteration ${iteration} error: ${error}`);
    throw err;
  }
}
function buildSystemPrompt(agent) {
  const parts = [`You are a ${agent.role}.`];
  if (agent.extraContext) {
    parts.push(agent.extraContext);
  }
  return parts.join(`

`);
}

class PipelineController {
  #def;
  #waves;
  #stateTracker;
  constructor(def, waves, stateTracker) {
    this.#def = def;
    this.#waves = waves;
    this.#stateTracker = stateTracker;
  }
  async run(options) {
    const { workspace, signal, onProgress, modelRegistry, settings } = options;
    const allResults = new Map;
    const errors = [];
    for (const name of this.#def.agents.keys()) {
      allResults.set(name, []);
    }
    const targetCount = this.#def.targetCount;
    await this.#stateTracker.appendOrchestratorLog(`Pipeline '${this.#def.name}' starting: mode=${this.#def.mode} iterations=${targetCount} waves=${this.#waves.length} agents=${this.#def.agents.size}`);
    try {
      for (let iteration = 0;iteration < targetCount; iteration++) {
        if (signal?.aborted) {
          await this.#stateTracker.updatePipeline({ status: "aborted" });
          return { status: "aborted", iterations: iteration, agentResults: allResults, errors };
        }
        await this.#stateTracker.updatePipeline({ iteration });
        await this.#stateTracker.appendOrchestratorLog(`--- Iteration ${iteration + 1}/${targetCount} ---`);
        const emitProgress = (currentWave) => {
          onProgress?.({
            iteration,
            targetCount,
            currentWave,
            totalWaves: this.#waves.length,
            agents: this.#buildProgressSnapshot()
          });
        };
        const iterationResults = await this.#runIteration(iteration, {
          workspace,
          signal,
          emitProgress,
          modelRegistry,
          settings
        });
        for (const [agentName, result] of iterationResults) {
          allResults.get(agentName).push(result);
          if (result.exitCode !== 0) {
            errors.push(`${agentName} (iteration ${iteration + 1}): ${result.error || `exit code ${result.exitCode}`}`);
          }
        }
      }
      const status = errors.length > 0 ? "failed" : "completed";
      await this.#stateTracker.updatePipeline({ status, completedAt: Date.now() });
      await this.#stateTracker.appendOrchestratorLog(`Pipeline ${status} (${errors.length} errors)`);
      return { status, iterations: targetCount, agentResults: allResults, errors };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
      await this.#stateTracker.appendOrchestratorLog(`Pipeline fatal error: ${error}`);
      errors.push(error);
      return { status: "failed", iterations: 0, agentResults: allResults, errors };
    }
  }
  async#runIteration(iteration, options) {
    const results = new Map;
    let agentIndex = 0;
    for (let waveIdx = 0;waveIdx < this.#waves.length; waveIdx++) {
      const wave = this.#waves[waveIdx];
      if (options.signal?.aborted)
        break;
      await this.#stateTracker.appendOrchestratorLog(`Wave ${waveIdx + 1}/${this.#waves.length}: [${wave.join(", ")}]`);
      for (const agentName of wave) {
        await this.#stateTracker.updateAgent(agentName, {
          status: "waiting",
          iteration,
          wave: waveIdx
        });
      }
      options.emitProgress(waveIdx);
      const waveResults = await Promise.all(wave.map(async (agentName) => {
        const agent = this.#def.agents.get(agentName);
        const currentIndex = agentIndex++;
        try {
          const result = await executeSwarmAgent(agent, currentIndex, {
            workspace: options.workspace,
            swarmName: this.#def.name,
            iteration,
            modelOverride: agent.model ?? this.#def.model,
            signal: options.signal,
            onProgress: (_name, _progress) => {
              options.emitProgress(waveIdx);
            },
            modelRegistry: options.modelRegistry,
            settings: options.settings,
            stateTracker: this.#stateTracker
          });
          return { agentName, result };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const failResult = {
            index: currentIndex,
            id: `swarm-${this.#def.name}-${agentName}-${iteration}`,
            agent: agentName,
            agentSource: "project",
            task: agent.task,
            exitCode: 1,
            output: "",
            stderr: error,
            truncated: false,
            durationMs: 0,
            tokens: 0,
            requests: 0,
            error
          };
          return { agentName, result: failResult };
        }
      }));
      for (const { agentName, result } of waveResults) {
        results.set(agentName, result);
      }
      options.emitProgress(waveIdx);
    }
    return results;
  }
  #buildProgressSnapshot() {
    const snapshot = {};
    for (const [name, agent] of Object.entries(this.#stateTracker.state.agents)) {
      snapshot[name] = { status: agent.status, iteration: agent.iteration };
    }
    return snapshot;
  }
}
var STATUS_LABELS = {
  completed: "[done]",
  running: "[....]",
  failed: "[FAIL]",
  pending: "[    ]",
  waiting: "[wait]",
  idle: "[idle]",
  aborted: "[stop]"
};
function renderSwarmProgress(state) {
  const lines = [];
  const statusLabel = state.status.toUpperCase();
  lines.push(`Swarm: ${state.name} [${statusLabel}]`);
  lines.push(`Mode: ${state.mode} | Iteration: ${state.iteration + 1}/${state.targetCount}`);
  lines.push("");
  const agents = Object.values(state.agents);
  if (agents.length === 0) {
    lines.push("  (no agents)");
    return lines;
  }
  for (const agent of agents) {
    const icon = STATUS_LABELS[agent.status] ?? "[????]";
    const duration = formatAgentDuration(agent);
    const errorSuffix = agent.error ? ` - ${truncate(agent.error, 60)}` : "";
    lines.push(`  ${icon} ${agent.name}: ${agent.status}${duration}${errorSuffix}`);
  }
  const completed = agents.filter((a) => a.status === "completed").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const running = agents.filter((a) => a.status === "running").length;
  lines.push("");
  const parts = [`${completed}/${agents.length} done`];
  if (running > 0)
    parts.push(`${running} running`);
  if (failed > 0)
    parts.push(`${failed} failed`);
  if (state.startedAt) {
    parts.push(`elapsed: ${formatDuration(Date.now() - state.startedAt)}`);
  }
  lines.push(`  ${parts.join(" | ")}`);
  return lines;
}
function formatAgentDuration(agent) {
  if (agent.startedAt && agent.completedAt) {
    return ` (${formatDuration(agent.completedAt - agent.startedAt)})`;
  }
  if (agent.startedAt && (agent.status === "running" || agent.status === "waiting")) {
    return ` (${formatDuration(Date.now() - agent.startedAt)}...)`;
  }
  return "";
}
var VALID_MODES = new Set(["pipeline", "parallel", "sequential"]);
var VALID_SWARM_NAME = /^[a-zA-Z0-9._-]+$/;
function parseSwarmYaml(content) {
  const raw = Bun.YAML.parse(content);
  if (!raw?.swarm) {
    throw new Error("YAML must have a top-level 'swarm' key");
  }
  const swarm = raw.swarm;
  if (!swarm.name || typeof swarm.name !== "string") {
    throw new Error("swarm.name is required and must be a string");
  }
  if (!VALID_SWARM_NAME.test(swarm.name)) {
    throw new Error("swarm.name may only contain letters, numbers, dot, underscore, and dash");
  }
  if (!swarm.workspace || typeof swarm.workspace !== "string") {
    throw new Error("swarm.workspace is required and must be a string");
  }
  if (!swarm.agents || typeof swarm.agents !== "object" || Object.keys(swarm.agents).length === 0) {
    throw new Error("swarm.agents must contain at least one agent");
  }
  const mode = swarm.mode ?? "sequential";
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode '${mode}'. Must be one of: ${[...VALID_MODES].join(", ")}`);
  }
  const agentOrder = [];
  const agents = new Map;
  for (const [name, config] of Object.entries(swarm.agents)) {
    if (!config.role || typeof config.role !== "string") {
      throw new Error(`Agent '${name}': 'role' is required`);
    }
    if (!config.task || typeof config.task !== "string") {
      throw new Error(`Agent '${name}': 'task' is required`);
    }
    agentOrder.push(name);
    agents.set(name, {
      name,
      role: config.role,
      task: config.task.trim(),
      extraContext: config.extra_context?.trim(),
      reportsTo: Array.isArray(config.reports_to) ? config.reports_to : [],
      model: typeof config.model === "string" ? config.model.trim() : undefined,
      waitsFor: Array.isArray(config.waits_for) ? config.waits_for : []
    });
  }
  return {
    name: swarm.name,
    workspace: swarm.workspace,
    mode,
    targetCount: swarm.target_count ?? 1,
    model: typeof swarm.model === "string" ? swarm.model.trim() : undefined,
    agents,
    agentOrder
  };
}
function validateSwarmDefinition(def) {
  const errors = [];
  const agentNames = new Set(def.agents.keys());
  if (def.model !== undefined && def.model.length === 0) {
    errors.push("swarm.model must not be empty when provided");
  }
  for (const [name, agent] of def.agents) {
    for (const dep of agent.waitsFor) {
      if (!agentNames.has(dep)) {
        errors.push(`Agent '${name}' waits_for unknown agent '${dep}'`);
      }
      if (dep === name) {
        errors.push(`Agent '${name}' cannot wait for itself`);
      }
    }
    for (const target of agent.reportsTo) {
      if (!agentNames.has(target)) {
        errors.push(`Agent '${name}' reports_to unknown agent '${target}'`);
      }
      if (target === name) {
        errors.push(`Agent '${name}' cannot report to itself`);
      }
    }
    if (agent.model !== undefined && agent.model.length === 0) {
      errors.push(`Agent '${name}' model must not be empty when provided`);
    }
  }
  if (def.targetCount < 1) {
    errors.push("target_count must be at least 1");
  }
  if (def.mode !== "pipeline" && def.targetCount !== 1) {
    errors.push("target_count is only supported in pipeline mode");
  }
  return errors;
}

class StateTracker {
  #swarmDir;
  #state;
  constructor(workspaceDir, name) {
    this.#swarmDir = path2.join(workspaceDir, `.swarm_${name}`);
    this.#state = {
      name,
      status: "idle",
      mode: "sequential",
      iteration: 0,
      targetCount: 1,
      agents: {},
      startedAt: Date.now()
    };
  }
  get swarmDir() {
    return this.#swarmDir;
  }
  get state() {
    return this.#state;
  }
  async init(agentNames, targetCount, mode) {
    await fs.mkdir(path2.join(this.#swarmDir, "state"), { recursive: true });
    await fs.mkdir(path2.join(this.#swarmDir, "logs"), { recursive: true });
    await fs.mkdir(path2.join(this.#swarmDir, "context"), { recursive: true });
    this.#state.targetCount = targetCount;
    this.#state.mode = mode;
    this.#state.status = "running";
    this.#state.startedAt = Date.now();
    for (const name of agentNames) {
      this.#state.agents[name] = {
        name,
        status: "pending",
        iteration: 0,
        wave: 0
      };
    }
    await this.#persist();
  }
  async updateAgent(name, update) {
    const agent = this.#state.agents[name];
    if (!agent)
      return;
    Object.assign(agent, update);
    await this.#persist();
  }
  async updatePipeline(update) {
    Object.assign(this.#state, update);
    await this.#persist();
  }
  async appendLog(agentName, message) {
    const logPath = path2.join(this.#swarmDir, "logs", `${agentName}.log`);
    const timestamp = new Date().toISOString();
    await fs.appendFile(logPath, `[${timestamp}] ${message}
`);
  }
  async appendOrchestratorLog(message) {
    const logPath = path2.join(this.#swarmDir, "logs", "orchestrator.log");
    const timestamp = new Date().toISOString();
    await fs.appendFile(logPath, `[${timestamp}] ${message}
`);
  }
  async load() {
    const statePath = path2.join(this.#swarmDir, "state", "pipeline.json");
    try {
      const content = await Bun.file(statePath).text();
      this.#state = JSON.parse(content);
      return this.#state;
    } catch {
      return null;
    }
  }
  async#persist() {
    await Bun.write(path2.join(this.#swarmDir, "state", "pipeline.json"), JSON.stringify(this.#state, null, 2));
  }
}
function swarmExtension(pi) {
  pi.setLabel("Swarm Orchestrator");
  pi.registerCommand("swarm", {
    description: "Run a multi-agent swarm pipeline from YAML",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["run", "status", "help"];
      if (!prefix)
        return subcommands.map((s) => ({ label: s, value: s }));
      return subcommands.filter((s) => s.startsWith(prefix)).map((s) => ({ label: s, value: s }));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] ?? "help";
      switch (subcommand) {
        case "run": {
          const yamlPath = parts[1];
          if (!yamlPath) {
            ctx.ui.notify("Usage: /swarm run <path/to/pipeline.yaml>", "error");
            return;
          }
          await handleRun(yamlPath, ctx, pi);
          return;
        }
        case "status": {
          await handleStatus(parts[1], ctx);
          return;
        }
        default:
          ctx.ui.notify([
            "Swarm \u2014 multi-agent pipeline orchestrator",
            "",
            "  /swarm run <file.yaml>     Run a pipeline",
            "  /swarm status [name]       Show pipeline status",
            "  /swarm help                Show this help"
          ].join(`
`), "info");
          return;
      }
    }
  });
}
async function handleRun(yamlPath, ctx, pi) {
  const resolvedPath = path3.isAbsolute(yamlPath) ? yamlPath : path3.resolve(ctx.cwd, yamlPath);
  let content = "";
  try {
    content = await Bun.file(resolvedPath).text();
  } catch {
    ctx.ui.notify(`Cannot read file: ${resolvedPath}`, "error");
    return;
  }
  let def;
  try {
    def = parseSwarmYaml(content);
  } catch (err) {
    ctx.ui.notify(`YAML error: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  const validationErrors = validateSwarmDefinition(def);
  if (validationErrors.length > 0) {
    ctx.ui.notify(`Validation errors:
${validationErrors.map((e) => `  - ${e}`).join(`
`)}`, "error");
    return;
  }
  const deps = buildDependencyGraph(def);
  const cycleNodes = detectCycles(deps);
  if (cycleNodes) {
    ctx.ui.notify(`Cycle detected in agent dependencies: [${cycleNodes.join(", ")}]`, "error");
    return;
  }
  const waves = buildExecutionWaves(deps);
  const workspace = path3.isAbsolute(def.workspace) ? def.workspace : path3.resolve(path3.dirname(resolvedPath), def.workspace);
  await fs2.mkdir(workspace, { recursive: true });
  const stateTracker = new StateTracker(workspace, def.name);
  await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);
  const agentList = [...def.agents.keys()].join(", ");
  const waveDesc = waves.map((w, i) => `wave ${i + 1}: [${w.join(", ")}]`).join("; ");
  pi.logger.debug("Swarm starting", {
    name: def.name,
    mode: def.mode,
    agents: agentList,
    waves: waveDesc,
    workspace
  });
  ctx.ui.notify(`Starting swarm '${def.name}': ${def.agents.size} agents, ${waves.length} waves, ${def.targetCount} iteration(s)`, "info");
  const widgetKey = `swarm-${def.name}`;
  const updateWidget = () => {
    const lines = renderSwarmProgress(stateTracker.state);
    ctx.ui.setWidget(widgetKey, lines);
  };
  updateWidget();
  const controller = new PipelineController(def, waves, stateTracker);
  const result = await controller.run({
    workspace,
    onProgress: () => updateWidget(),
    modelRegistry: ctx.modelRegistry,
    settings: pi.pi.settings
  });
  ctx.ui.setWidget(widgetKey, undefined);
  const elapsed = stateTracker.state.completedAt ? formatDuration2(stateTracker.state.completedAt - stateTracker.state.startedAt) : "unknown";
  const summaryParts = [
    `Swarm '${def.name}' ${result.status}`,
    `${result.iterations}/${def.targetCount} iterations`,
    `elapsed: ${elapsed}`
  ];
  if (result.errors.length > 0) {
    summaryParts.push(`${result.errors.length} error(s)`);
  }
  const summaryType = result.status === "completed" ? "info" : "error";
  ctx.ui.notify(summaryParts.join(" | "), summaryType);
  if (result.errors.length > 0) {
    pi.logger.warn("Swarm completed with errors", { errors: result.errors });
  }
  const summaryMessage = buildSummaryMessage(def, result, stateTracker, workspace);
  pi.sendMessage({
    customType: "swarm-result",
    content: [{ type: "text", text: summaryMessage }],
    display: true,
    details: {
      swarmName: def.name,
      status: result.status,
      iterations: result.iterations,
      errorCount: result.errors.length
    }
  }, { triggerTurn: false });
}
async function handleStatus(name, ctx) {
  if (!name) {
    ctx.ui.notify("Usage: /swarm status <name>  (reads .swarm_<name>/state/pipeline.json from cwd)", "info");
    return;
  }
  const stateTracker = new StateTracker(ctx.cwd, name);
  const state = await stateTracker.load();
  if (!state) {
    ctx.ui.notify(`No state found for swarm '${name}' in ${ctx.cwd}`, "error");
    return;
  }
  const lines = renderSwarmProgress(state);
  ctx.ui.notify(lines.join(`
`), "info");
}
function buildSummaryMessage(def, result, stateTracker, workspace) {
  const lines = [];
  lines.push(`## Swarm Pipeline: ${def.name}`);
  lines.push("");
  lines.push(`- **Status**: ${result.status}`);
  lines.push(`- **Mode**: ${def.mode}`);
  lines.push(`- **Iterations**: ${result.iterations}/${def.targetCount}`);
  lines.push(`- **Workspace**: ${workspace}`);
  lines.push(`- **State dir**: ${stateTracker.swarmDir}`);
  lines.push("");
  lines.push("### Agent Results");
  lines.push("");
  for (const [name, agent] of Object.entries(stateTracker.state.agents)) {
    const duration = agent.startedAt && agent.completedAt ? formatDuration2(agent.completedAt - agent.startedAt) : "n/a";
    lines.push(`- **${name}**: ${agent.status} (${duration})${agent.error ? ` \u2014 ${agent.error}` : ""}`);
  }
  if (result.errors.length > 0) {
    lines.push("");
    lines.push("### Errors");
    lines.push("");
    for (const error of result.errors) {
      lines.push(`- ${error}`);
    }
  }
  return lines.join(`
`);
}
export {
  swarmExtension as default
};

# Plan: Upstream Parity Cherry-Pick (v15.6.0 -> v15.7.2)

**Status:** PENDING APPROVAL
**Mode:** RALPLAN-DR (deliberate)
**Iteration:** 1 of max 5
**Scope target:** packages/coding-agent, packages/mnemosyne in `/Users/davidandrews/PycharmProjects/lex`
**Created:** 2026-05-31
**Author:** Antigravity (Assistant)

---

## 1. Context

We are running a fork of OMP named `lex` with custom architecture (unified background agents, OMLX model bindings on port 18790, custom configuration paths, and custom shell filters). We want to cherry-pick the key improvements landed upstream between `v15.6.0` and `v15.7.2` to maximize execution speed, CPU/memory performance, token savings, and command-line ergonomics.

This plan details the selective porting of these features without regressing or modifying any unique `lex` architectural invariants.

---

## 2. Architecture Comparison & Guardrails

### A. Where Upstream Improvements Must Be Adopted
1. **Startup Performance**: Deferred loading of `fastembed` (FlagEmbedding) prevents eager C++ native bindings allocation on startup, eliminating segfault risks and reducing CLI boot latency to <50ms.
2. **Interpreter Resilience**: Priority-based Python runtime enumeration (`venv` -> `managed` -> `system`) instead of single-candidate fail-hard checking.
3. **Token Efficiency**: Code block stripping for titles (wipes large fenced code dumps before titling) + strict tight-range editing rules.
4. **Local Acceleration**: Persistent GPU execution provider settings (`PI_TINY_DEVICE` / Metal/CUDA/DirectML) with seamless fallback to CPU for embeddings and title workers.
5. **Algorithmic Correctness**: Linking cyclic local module graphs in JS VM kernel in a single pass to prevent infinite recursion/linker lock.
6. **Editing Parity**: grammar/parser-level `replace block N:` AST structural replace syntax.

### B. Where Lex Architecture Is Superior & Preserved (Guardrails)
*   **Model Routing**: Do NOT clobber the `opencode-antigravity` auth routing. Lex disables native `google-antigravity` in favor of the auth-broker adapter. Keep this intact.
*   **Volatile Mailboxes & Unified Background Agents**: Lex features process-wide Actor Mailboxes (`packages/coding-agent/src/registry/mailbox.ts`) with autonomous background polling and offline buffering. Do NOT clobber this system or replace it with serial execution loops.
*   **Local OMLX Port**: Local model configuration must preserve port `18790` and reasoning flags.
*   **Shell Output Minimizer**: Preserve Lex-specific minimizer logic: `filter: "too-large"` on capture overflows, output reduction ratio optimizations.
*   **Build Pipeline**: All compiled binaries and workspace checks must execute via `./rebuild-lex.zsh` rather than upstream build commands.
*   **Settings Namespace**: Keep configuration state under `~/.omp/settings.json` and project directories under `.omp/` (resolving fork naming debt).

---

## 3. Decision Drivers

1. **Zero-Regression Porting**: Any cherry-pick must be syntactically isolated and verified via local package tests.
2. **Aggressive Token Savings**: Prompt rules and worker code block stripping are cheap to adopt and yield instant, high-multiplier token reductions.
3. **Robust Local-First Tooling**: Lazy loader patterns for embeddings are critical to keep Lex lightweight and fast as a developer utility.

---

## 4. Plan Phases & Task Flow

```
                  ┌───────────────────────┐
                  │ T0: Create Work Branch │
                  └───────────┬───────────┘
                              ▼
        ┌───────────────────────────────────────────┐
        │ T1: Parallel Swarm Agent Implementation   │
        ├─────────────────────┬─────────────────────┤
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  A1: Speed   │      │ A2: Efficiency│     │   A3: UX &   │
│ & Performance│      │  & Tokens    │      │ Clean-up     │
└────────┬──────┘      └──────┬───────┘      └──────┬───────┘
         │                    │                     │
         └────────────────────┼─────────────────────┘
                              ▼
                  ┌───────────────────────┐
                  │ T2: Build & Synthesize│
                  └───────────┬───────────┘
                              ▼
                  ┌───────────────────────┐
                  │ T3: Run Verification  │
                  └───────────────────────┘
```

### Phase A1: Speed & Performance (`fastembed_deferrer`)
*   **Work**:
    1. Import `FlagEmbedding` lazily inside local embedding execution blocks in `packages/mnemosyne/src/core/embeddings.ts` and related files.
    2. Incorporate `enumeratePythonRuntimes` sequence in `packages/coding-agent/src/exec/python-runtime.ts`.
    3. Update tiny-model device preference logic to default to CPU with GPU heuristic detection in `packages/coding-agent/src/tiny/device.ts`.

### Phase A2: Efficiency & Token Savings (`hashline_updater` & `thinking_implementer`)
*   **Work**:
    1. Extend hashline section parser in `packages/hashline` with `replace block N:` syntax.
    2. Add `stripCodeBlocks` in `packages/coding-agent/src/tiny/text.ts` and integrate it into title generation.
    3. Add `AUTO_THINKING` effort parameter support and per-turn classification prompts.

### Phase A3: UX & Clean-up (`ux_cleanup`)
*   **Work**:
    1. Implement bash/eval TUI clock-like pending border.
    2. Add `/switch` slash command to `packages/coding-agent/src/slash-commands/builtin-registry.ts`.
    3. Delete `RecipeTool`, task runner implementations, prompts, and types entirely.

### Phase T2: Build & Synthesize (`synthesizer`)
*   **Work**:
    1. Run `./rebuild-lex.zsh` to compile native bindings, TypeScript dependencies, and CLI binary.
    2. Perform static analysis checks via `bun run check`.

---

## 5. Verification Plan

1. **Startup Check**:
   *   Command: `lex --version` or launch the interactive CLI.
   *   Assertion: Startup time is instantaneous (<50ms) and does not throw segmentation faults.
2. **Python Environment Resiliency**:
   *   Action: Simulate a broken managed environment by pointing `PI_PYTHON_PATH` to a non-existent route.
   *   Assertion: The runner automatically falls back to system Python and functions correctly.
3. **Token Savings Check**:
   *   Action: Generate a title for a session containing a large code block.
   *   Assertion: Observe title payload lacks fenced code blocks, significantly reducing prompt token count.
4. **TUI Pending Visuals**:
   *   Action: Execute a slow bash job like `sleep 2` in TUI.
   *   Assertion: Animated clock-like borders render framing the command block while pending.
5. **Full Unit/Integration Test Suite**:
   *   Command: `bun run test` inside `packages/mnemosyne`, `packages/hashline`, and `packages/coding-agent`.
   *   Assertion: All existing tests continue to pass with zero regressions.

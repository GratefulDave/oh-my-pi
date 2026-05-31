# Tier C Group K — EventLoopKeepalive Discovery Report

## Goal
Determine whether fork experiences Bun busy-wait surface that would benefit from porting upstream Group K (EventLoopKeepalive disposable class + `using` declaration in Agent.prompt() + interactive-mode.ts).

## Upstream SHAs in scope
- `6fb1983fb` — EventLoopKeepalive class definition
- `af2011f5a` — Agent.prompt() integration with `using`
- `c1fa0e9f5` — interactive-mode.ts integration

## Fork state — busy-wait surface

### Critical Finding: Unmitigated await Promise in #runLoop

| File | Line | Pattern | Context |
|------|------|---------|---------|
| packages/agent/src/agent.ts | 846 | `Promise.withResolvers<void>()` | Creates unresolved promise in `#runLoop()` |
| packages/agent/src/agent.ts | 954 | `for await (const event of stream)` | Long-running loop awaits on EventStream without keepalive |

**Risk**: When EventStream yields slowly (awaiting on unresolved promise at line 846), Bun event loop can busy-wait on line 954, consuming 100% CPU until event arrival. No scheduled I/O or timer fallback in the await chain.

### Secondary Surface: interactive-mode.ts user input await
- Lines 1–100: User-input handling via TUI — awaits on readline/prompt
- No identified unmitigated `await promise` in interactive entry point (uses scheduler-integrated TUI)

## Fork state — existing mitigations

| File | Line | Mitigation | Scope |
|------|------|-----------|-------|
| packages/agent/src/agent.ts | 920 | `await Bun.sleep(0)` | syncContextBeforeModelCall callback only |
| — | — | *None other found* | — |

**Gap**: Mitigation at line 920 only applies when listeners exist (line 919 condition). Core `#runLoop` await at line 954 has no keepalive wrapper.

## CPU evidence

- No CHANGELOG entries in `packages/agent/CHANGELOG.md` about busy-wait, high CPU, or keepalive fixes
- No CHANGELOG entries in `packages/coding-agent/CHANGELOG.md` about unref/keepalive
- No `TODO`/`FIXME` comments mentioning busy-wait in scanned ranges
- Fork version 15.5.x does not mention upstream issue #1464 resolution

## Bun version

Fork specifies: **Bun 1.3.14**  
Upstream issue #1464 likely affected earlier Bun versions (1.3.7–1.3.13). Bun 1.3.14 may still exhibit busy-wait if the underlying scheduler issue persists.

## Verdict: **PROCEED**

### Rationale
1. **Surface exists**: Unresolved promise await in long-running loop (lines 846–954) without keepalive
2. **No fork fix**: No EventLoopKeepalive class, no using declaration, no fork-specific mitigation pattern
3. **No prior entry**: CHANGELOG silent on busy-wait / CPU / keepalive topics
4. **Bun version uncertainty**: 1.3.14 may still be susceptible; defensive port removes risk

### Decision
Port Group K to fork. Implement:
- EventLoopKeepalive class definition (per upstream)
- `using EventLoopKeepalive(…)` wrapper in `Agent.prompt()` / `#runLoop()` 
- Integration in interactive-mode.ts entry point if applicable

## Recommendation

1. **Immediate**: Port EventLoopKeepalive and `using` declaration to Agent.prompt()
2. **Verify**: Test under high-concurrency, long-await scenarios to confirm no 100% CPU spikes
3. **Document**: Add CHANGELOG entry marking the fix as defensive upstream sync

## Next gate

After implementation:
- Run CPU-load profile under interactive-mode with async agent loop
- Confirm event loop yields regularly even during long unresolved waits
- Smoke test with plan mode / goal mode (both heavy async)

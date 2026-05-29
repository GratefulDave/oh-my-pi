/**
 * Shared types for swarm internals.
 *
 * RunSubprocessFn is extracted as a type alias so swarm code never
 * needs a runtime import of @oh-my-pi/pi-coding-agent — the concrete
 * function is threaded in from the extension entry via pi.pi.runSubprocess.
 */
import type { ExecutorOptions, SingleResult } from "@oh-my-pi/pi-coding-agent";

/** Signature of runSubprocess, injected at activation time. */
export type RunSubprocessFn = (options: ExecutorOptions) => Promise<SingleResult>;

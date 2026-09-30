/**
 * One guarded tool call, as a RESULT rather than an exception — the shape both drivers (scripted
 * and LLM) want. `ViaGuard.call` throws `ViaDeniedError` on a deny and rethrows tool errors after
 * reporting them, so every caller would otherwise write this same try/catch.
 */
import { ViaDeniedError, type ViaGuard } from '@humanos/agent-sdk';
import type { Step, World } from './agent.js';

export interface StepResult {
  tool: string;
  args: Record<string, unknown>;
  decision: 'allow' | 'deny';
  /** Why it was denied (`rule_failed`, `stepup_declined`, …). */
  reason?: string;
  /** The rules that failed, on a rule deny. */
  failedRules?: string[];
  /** What the tool returned, when it ran. */
  result?: unknown;
  /** The tool ran and threw; the guard reported ACTION_FAILED. */
  error?: string;
}

export async function guardedCall(guard: ViaGuard, world: World, tool: string, args: Record<string, unknown>): Promise<StepResult> {
  const impl = world.impls[tool];
  if (!impl) return { tool, args, decision: 'deny', reason: 'unknown_tool' };
  try {
    const out = await guard.call(tool, args, impl);
    return { tool, args, decision: out.decision, ...(out.reason ? { reason: out.reason } : {}), result: out.result };
  } catch (e) {
    if (e instanceof ViaDeniedError) {
      const failed = e.evaluations.filter((ev) => ev.result === 'fail' || ev.result === 'error').map((ev) => ev.rule);
      return { tool, args, decision: 'deny', reason: e.reason ?? 'denied', ...(failed.length ? { failedRules: failed } : {}) };
    }
    // The verifier allowed it and the tool itself failed — already reported as ACTION_FAILED.
    return { tool, args, decision: 'allow', error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runSteps(
  guard: ViaGuard,
  world: World,
  steps: Step[],
  log: (line: string) => void = () => {},
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    log(`→ ${step.note}`);
    const r = await guardedCall(guard, world, step.tool, step.args);
    log(`  ${describe(r)}`);
    results.push(r);
  }
  return results;
}

export function describe(r: StepResult): string {
  const call = `${r.tool}(${JSON.stringify(r.args)})`;
  if (r.decision === 'deny') return `${call} → DENIED (${r.reason}${r.failedRules ? `: ${r.failedRules.join(', ')}` : ''}) — the tool never ran`;
  if (r.error) return `${call} → allowed, tool failed: ${r.error}`;
  return `${call} → allowed · ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`;
}

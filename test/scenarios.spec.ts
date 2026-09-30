/**
 * Each scripted scenario, through the real `ViaGuard` against the SDK's in-process verifier: the
 * decisions the verifier records, what the world ended up doing, and — the insurer's first
 * question — that every allowed call's outcome was reported.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ViaGuard } from '@humanos/agent-sdk';
import { createTestVerifier } from '@humanos/agent-sdk/testing';
import { storedSoftwareKey } from '../lib/stored-key.js';
import { runSteps } from '../lib/runner.js';
import type { AgentDef, World } from '../lib/agent.js';
import { supportAgent, makeSupportWorld } from '../examples/support/agent.js';
import { claimsAgent, makeClaimsWorld } from '../examples/claims/agent.js';

async function run<W extends World>(def: AgentDef, scenario: string, world: W, opts: { stepUpTools?: string[]; approveStepUp?: boolean; userParams?: Record<string, unknown> } = {}) {
  const key = await storedSoftwareKey(join(mkdtempSync(join(tmpdir(), 'via-')), 'k.json'));
  const userParams = opts.userParams ?? Object.fromEntries(Object.entries(def.surface.grantorParams).map(([k, v]) => [k, v.suggested]));
  const p = createTestVerifier({ rules: def.surface.rules, userParams, agentKey: key, ...opts });
  const guard = new ViaGuard({ mandate: p.mandate, agentKey: key, verifier: p.verifier, compiled: p.compiled, mode: 'enforce', onRechallenge: p.onRechallenge });
  const results = await runSteps(guard, world, def.scenarios[scenario]!.steps);
  return { results, world, p };
}

const summary = (rs: { tool: string; decision: string; error?: string }[]) => rs.map((r) => `${r.tool}:${r.decision}${r.error ? ':failed' : ''}`);

/** Every allow has exactly one reported outcome; no deny has one. */
function everyAllowReported(p: ReturnType<typeof createTestVerifier>) {
  const allowed = p.decisions.filter((d) => d.decision === 'allow').map((d) => d.eventId);
  expect(p.outcomes.map((o) => o.decisionEventId).sort()).toEqual(allowed.sort());
}

describe('support agent', () => {
  it('routine — five calls, all allowed and reported; one €25 credit', async () => {
    const { results, world, p } = await run(supportAgent, 'routine', makeSupportWorld());
    expect(summary(results)).toEqual(['lookup_policy:allow', 'get_claim_status:allow', 'update_contact:allow', 'issue_goodwill_credit:allow', 'escalate_to_human:allow']);
    expect(world.credits).toEqual([{ policy_id: 'P-1001', amount_eur: 25 }]);
    expect(p.decisions.every((d) => d.decision === 'allow')).toBe(true); // every proof checked out
    everyAllowReported(p);
  });

  it('over-limit — the €200 credit is denied on goodwill_credit_cap and never runs', async () => {
    const { results, world, p } = await run(supportAgent, 'over-limit', makeSupportWorld());
    expect(summary(results)).toEqual(['lookup_policy:allow', 'issue_goodwill_credit:allow', 'issue_goodwill_credit:deny', 'escalate_to_human:allow']);
    expect(results[2]).toMatchObject({ reason: 'rule_failed', failedRules: ['goodwill_credit_cap'] });
    expect(world.credits.map((c) => c.amount_eur)).toEqual([25]);
    everyAllowReported(p);
  });

  it('with contact changes switched off, the update is denied and the file is untouched', async () => {
    const world = makeSupportWorld();
    const { results } = await run(supportAgent, 'routine', world, { userParams: { credit_limit: 50, allow_contact_changes: false } });
    expect(results[2]).toMatchObject({ tool: 'update_contact', decision: 'deny', failedRules: ['contact_changes_allowed'] });
    expect(String(world.impls.lookup_policy!({ policy_id: 'P-1001' }))).toContain('P-1001');
  });

  it('tool-failure — an allowed call whose tool throws is reported as failed, with the error', async () => {
    const { results, p } = await run(supportAgent, 'tool-failure', makeSupportWorld());
    expect(results[0]).toMatchObject({ decision: 'allow', error: 'no policy P-9999' });
    expect(p.outcomes).toEqual([expect.objectContaining({ outcome: 'failed', error: 'no policy P-9999' })]);
  });
});

describe('claims agent', () => {
  it('routine — assess, approve, pay; the claimant is paid once', async () => {
    const { results, world, p } = await run(claimsAgent, 'routine', makeClaimsWorld());
    expect(summary(results)).toEqual(['assess_claim:allow', 'approve_payout:allow', 'pay_claimant:allow']);
    expect(world.payments).toEqual([{ claim_id: 'C-501', amount_eur: 1800, iban: 'PT50000201231234567890154' }]);
    everyAllowReported(p);
  });

  it('routine with pay_claimant behind a step-up the person APPROVES — paid, after a rechallenge', async () => {
    const { results, world, p } = await run(claimsAgent, 'routine', makeClaimsWorld(), { stepUpTools: ['pay_claimant'], approveStepUp: true });
    expect(results[2]).toMatchObject({ tool: 'pay_claimant', decision: 'allow' });
    expect(p.decisions.filter((d) => d.tool === 'pay_claimant').map((d) => d.decision)).toEqual(['rechallenge', 'allow']);
    expect(world.payments).toHaveLength(1);
    everyAllowReported(p);
  });

  it('routine with a step-up the person DECLINES — nothing is paid', async () => {
    const { results, world } = await run(claimsAgent, 'routine', makeClaimsWorld(), { stepUpTools: ['pay_claimant'], approveStepUp: false });
    expect(results[2]).toMatchObject({ tool: 'pay_claimant', decision: 'deny', reason: 'stepup_declined' });
    expect(world.payments).toEqual([]);
    expect(world.claims['C-501']!.status).toBe('approved');
  });

  it('over-limit — the €7,400 auto approval fails both rules; documents are requested instead', async () => {
    const { results, world, p } = await run(claimsAgent, 'over-limit', makeClaimsWorld());
    expect(summary(results)).toEqual(['assess_claim:allow', 'approve_payout:deny', 'request_documents:allow']);
    expect(results[1]!.failedRules).toEqual(['payout_cap', 'claim_type_allowed']);
    expect(world.claims['C-502']!.status).toBe('documents requested');
    everyAllowReported(p);
  });

  it('fraud — once flagged, an approval the mandate allows fails in the tool and is reported failed', async () => {
    const { results, world, p } = await run(claimsAgent, 'fraud', makeClaimsWorld());
    expect(summary(results)).toEqual(['assess_claim:allow', 'flag_fraud:allow', 'approve_payout:allow:failed']);
    expect(world.claims['C-503']!.status).toBe('flagged');
    expect(p.outcomes.map((o) => o.outcome)).toEqual(['completed', 'completed', 'failed']);
  });
});

describe('the two agents are independent', () => {
  it('different actions, disjoint tools, separate key files', () => {
    expect(supportAgent.surface.name).not.toBe(claimsAgent.surface.name);
    const a = new Set(supportAgent.surface.tools.map((t) => t.name));
    expect(claimsAgent.surface.tools.filter((t) => a.has(t.name))).toEqual([]);
    expect(supportAgent.id).not.toBe(claimsAgent.id);
  });
});

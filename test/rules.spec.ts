/**
 * The CEL each agent proposes, evaluated by the same evaluator the verifier runs: in
 * limit passes, over limit fails, and a rule written for one tool never blocks another.
 */
import { describe, expect, it } from 'vitest';
import { evaluateRules, validateCelExpression } from '@humanos/agent-sdk/testing';
import { SUPPORT_SURFACE } from '../examples/support/agent.js';
import { CLAIMS_SURFACE } from '../examples/claims/agent.js';
import type { AgentSurface } from '../lib/surface.js';

const suggested = (s: AgentSurface) => Object.fromEntries(Object.entries(s.grantorParams).map(([k, v]) => [k, v.suggested]));
const decide = (s: AgentSurface, params: Record<string, unknown>, userParams = suggested(s)) => evaluateRules(s.rules, { userParams, executionParams: params });
const failed = (r: ReturnType<typeof decide>) => r.evaluations.filter((e) => e.result !== 'pass' && e.result !== 'skip').map((e) => e.rule);

describe.each([SUPPORT_SURFACE, CLAIMS_SURFACE])('$name — the proposal is well formed', (s) => {
  it('every rule parses and every grantor param has a plain-language description and a suggestion', () => {
    for (const r of s.rules) expect(validateCelExpression(r.expression), r.name).toEqual({ ok: true });
    for (const [k, p] of Object.entries(s.grantorParams)) {
      expect(p.description.length, k).toBeGreaterThan(20);
      expect(p.suggested, k).toBeDefined();
    }
  });

  it('every rule names only parameters the surface declares', () => {
    const exec = new Set(s.tools.flatMap((t) => Object.keys(t.params)).concat('tool'));
    for (const r of s.rules) {
      for (const [, p] of r.expression.matchAll(/executionParams\.(\w+)/g)) expect(exec.has(p!), `${r.name}: ${p}`).toBe(true);
      for (const [, p] of r.expression.matchAll(/userParams\.(\w+)/g)) expect(p! in s.grantorParams, `${r.name}: ${p}`).toBe(true);
    }
  });
});

describe('support rules', () => {
  const s = SUPPORT_SURFACE;
  it('a credit inside the limit passes, above it fails on goodwill_credit_cap', () => {
    expect(decide(s, { tool: 'issue_goodwill_credit', policy_id: 'P-1', amount_eur: 50, reason: 'x' }).decision).toBe('allow');
    expect(decide(s, { tool: 'issue_goodwill_credit', policy_id: 'P-1', amount_eur: 12.5, reason: 'x' }).decision).toBe('allow');
    const over = decide(s, { tool: 'issue_goodwill_credit', policy_id: 'P-1', amount_eur: 50.01, reason: 'x' });
    expect(over.decision).toBe('deny');
    expect(failed(over)).toEqual(['goodwill_credit_cap']);
  });

  it('contact changes follow the person\'s switch; reads are never blocked by it', () => {
    const off = { ...suggested(s), allow_contact_changes: false };
    expect(decide(s, { tool: 'update_contact', policy_id: 'P-1', phone: '1' }).decision).toBe('allow');
    expect(failed(decide(s, { tool: 'update_contact', policy_id: 'P-1', phone: '1' }, off))).toEqual(['contact_changes_allowed']);
    expect(decide(s, { tool: 'lookup_policy', policy_id: 'P-1' }, off).decision).toBe('allow');
  });
});

describe('claims rules', () => {
  const s = CLAIMS_SURFACE;
  it('approve: within the limit and an allowed type passes', () => {
    expect(decide(s, { tool: 'approve_payout', claim_id: 'C', claim_type: 'home', amount_eur: 2500 }).decision).toBe('allow');
  });

  it('approve: too large fails payout_cap, a type not handed over fails claim_type_allowed — both reported', () => {
    expect(failed(decide(s, { tool: 'approve_payout', claim_id: 'C', claim_type: 'home', amount_eur: 2500.5 }))).toEqual(['payout_cap']);
    expect(failed(decide(s, { tool: 'approve_payout', claim_id: 'C', claim_type: 'auto', amount_eur: 100 }))).toEqual(['claim_type_allowed']);
    expect(failed(decide(s, { tool: 'approve_payout', claim_id: 'C', claim_type: 'auto', amount_eur: 7400 }))).toEqual(['payout_cap', 'claim_type_allowed']);
  });

  it('pay is capped too, so a payment cannot exceed what approval could', () => {
    expect(failed(decide(s, { tool: 'pay_claimant', claim_id: 'C', amount_eur: 9000, iban: 'X' }))).toEqual(['payout_cap']);
  });

  it('non-money tools pass whatever the limits are', () => {
    const tight = { payout_limit: 0, allowed_claim_types: [] };
    for (const tool of ['open_claim', 'request_documents', 'assess_claim', 'flag_fraud']) {
      expect(decide(s, { tool, claim_id: 'C' }, tight).decision, tool).toBe('allow');
    }
  });
});

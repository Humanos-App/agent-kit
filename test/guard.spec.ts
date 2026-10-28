/**
 * The guard `run` and `chat` call through, against a connector double: the organization's policy decides each call,
 * a held mandate is presented only for a tool it leaves to one, and the kit names the agent on every call because it
 * connects with the organization's key.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViaMcpClient, ViaToolResult } from '@humanos/agent-sdk';
import { guardFor } from '../lib/guard.js';
import { describe as describeResult, guardedCall } from '../lib/runner.js';
import { toolMessage } from '../lib/llm.js';
import { storedSoftwareKey } from '../lib/stored-key.js';
import type { ToolAccess } from '../lib/connector.js';
import { makeSupportWorld, supportAgent } from '../examples/support/agent.js';

const json = (v: unknown): ViaToolResult => ({ text: JSON.stringify(v), isError: false });

const WITH_POLICY = ['get_policy', 'get_mandate', 'challenge', 'verify', 'report_outcome'];
const POLICY = 'urn:via:policy:org:3';
const SUPPORT_DESK = 'urn:via:action:support-desk:2';

/** A held mandate, as `get_mandate` answers it: only what the kit reads before a call, its action listing its tools. */
const held = (id: string, name: string, tools = supportAgent.surface.tools.map((t) => t.name)) => ({
  mandate: { id, credentialSubject: { mandate: { userParams: {} } } },
  action: { urn: `urn:via:action:${name}`, content: { name, tools, rules: [] } },
});

function connector(opts: { tools?: string[]; held?: unknown[]; access?: Record<string, ToolAccess>; verify?: (args: Record<string, unknown>) => unknown } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'fake', version: '0' }, protocolVersion: '2025-11-25' }),
    listTools: async () => (opts.tools ?? WITH_POLICY).map((name) => ({ name, inputSchema: { type: 'object' } })) as never,
    callTool: async (name, args = {}) => {
      calls.push({ name, args });
      if (name === 'get_policy') {
        const tools = Object.entries(opts.access ?? {}).map(([tool, access]) => ({ tool, access, meaning: '' }));
        return json({ agent: args.agentDid, policy: { id: POLICY, version: 1, default: 'allow' }, tools });
      }
      if (name === 'get_mandate') return json(opts.held ?? []);
      if (name === 'challenge') return json({ nonce: `n-${calls.length}`, aud: 'did:web:humanos.tech', ttl: 120, iat: 1, policy: POLICY });
      if (name === 'verify') return json(opts.verify?.(args) ?? { decision: 'allow', evaluations: [], decisionEventId: 'urn:via:event:d1' });
      if (name === 'report_outcome') return json({ recorded: {} });
      return { text: `no tool ${name}`, isError: true };
    },
  };
  return { client, calls };
}

async function registeredKey() {
  const key = await storedSoftwareKey(join(mkdtempSync(join(tmpdir(), 'via-')), 'k.json'));
  key.save('did:web:humanos.tech:agent:a1');
  return key;
}

describe('guardFor', () => {
  it('a tool the policy does not leave to a mandate goes on the policy: challenge, verify and report name the agent and the policy', async () => {
    const key = await registeredKey();
    const { client, calls } = connector({ held: [held('urn:m:mine', supportAgent.surface.name)], access: { lookup_policy: 'allow' } });
    const guarded = await guardFor(client, key);
    expect(guarded.mandateId).toBeUndefined();

    const r = await guardedCall(guarded.guard, makeSupportWorld(), 'lookup_policy', { policy_id: 'P-1001' });
    expect(r).toMatchObject({ decision: 'allow', result: expect.stringContaining('P-1001') });
    expect(calls.map((c) => c.name)).toEqual(['get_policy', 'get_mandate', 'challenge', 'verify', 'challenge', 'report_outcome']);
    expect(calls[2]!.args).toEqual({ agentDid: key.did });
    expect(calls[3]!.args).toMatchObject({ policy: POLICY, agentDid: key.did, tool: 'lookup_policy', params: { policy_id: 'P-1001', tool: 'lookup_policy' }, pop: expect.stringMatching(/^ey/) });
    expect(calls[3]!.args).not.toHaveProperty('mandateId');
    expect(calls[5]!.args).toMatchObject({ policy: POLICY, agentDid: key.did, decisionEventId: 'urn:via:event:d1', outcome: 'completed' });
  });

  it('a Delegate tool presents a held mandate, and reports under it', async () => {
    const key = await registeredKey();
    const { client, calls } = connector({ held: [held('urn:m:mine', supportAgent.surface.name)], access: { issue_goodwill_credit: 'mandate' } });
    await guardedCall((await guardFor(client, key)).guard, makeSupportWorld(), 'issue_goodwill_credit', { policy_id: 'P-1001', amount_eur: 25 });
    const verify = calls.find((c) => c.name === 'verify')!;
    expect(verify.args).toMatchObject({ mandateId: 'urn:m:mine', agentDid: key.did });
    expect(verify.args).not.toHaveProperty('policy');
    expect(calls.find((c) => c.name === 'report_outcome')!.args).toMatchObject({ mandateId: 'urn:m:mine' });
  });

  it('--mandate names the one a Delegate tool presents', async () => {
    const key = await registeredKey();
    const mandates = [held('urn:m:mine', supportAgent.surface.name), held('urn:m:other', 'Claims', [])];
    const { client, calls } = connector({ held: mandates, access: { issue_goodwill_credit: 'mandate' } });
    const guarded = await guardFor(client, key, { mandateId: 'urn:m:other' });
    expect(guarded.mandateId).toBe('urn:m:other');
    await guardedCall(guarded.guard, makeSupportWorld(), 'issue_goodwill_credit', { policy_id: 'P-1001', amount_eur: 25 });
    expect(calls.find((c) => c.name === 'verify')!.args).toMatchObject({ mandateId: 'urn:m:other' });
  });

  it('refuses what it cannot do: an unheld mandate, a connector that does not decide on the policy', async () => {
    const key = await registeredKey();
    await expect(guardFor(connector().client, key, { mandateId: 'urn:m:x' })).rejects.toThrow('mandate urn:m:x is not held');
    const mandatesOnly = { tools: ['get_mandate', 'challenge', 'verify', 'report_outcome'] };
    await expect(guardFor(connector(mandatesOnly).client, key)).rejects.toThrow('serves get_policy');
  });
});

describe('a deny on the policy', () => {
  it.each([
    ['Deny', { decision: 'deny', reason: 'policy_denied', evaluations: [] }, { reason: 'policy_denied' }],
    ['Restrict, a rule broken', { decision: 'deny', reason: 'policy_denied', evaluations: [{ rule: 'credit_cap', result: 'fail' }] }, { reason: 'policy_denied', failedRules: ['credit_cap'] }],
    ['Delegate', { decision: 'deny', reason: 'mandate_required', evaluations: [], under: [{ id: SUPPORT_DESK }] }, { reason: 'mandate_required', under: [SUPPORT_DESK] }],
  ])('%s — the tool never runs, and the result says why', async (_access, answer, expected) => {
    const world = makeSupportWorld();
    const { client, calls } = connector({ verify: () => answer });
    const r = await guardedCall((await guardFor(client, await registeredKey())).guard, world, 'issue_goodwill_credit', { policy_id: 'P-1001', amount_eur: 25 });
    expect(r).toMatchObject({ decision: 'deny', ...expected });
    expect(world.credits).toEqual([]);
    expect(calls.map((c) => c.name)).not.toContain('report_outcome');
  });

  it('mandate_required names the controls, in the run log and to the model', () => {
    const r = { tool: 'issue_goodwill_credit', args: {}, decision: 'deny' as const, reason: 'mandate_required', under: [SUPPORT_DESK] };
    expect(describeResult(r)).toContain(`DENIED (mandate_required) — a mandate under ${SUPPORT_DESK} — the tool never ran`);
    expect(toolMessage(r)).toMatch(new RegExp(`^BLOCKED by Humanos \\(mandate_required\\)\\. It needs a person's mandate under one of: ${SUPPORT_DESK}\\.`));
  });
});

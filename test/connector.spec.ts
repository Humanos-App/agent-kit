/**
 * The typed connector calls, against a client double that records what goes on the wire.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViaMcpClient, ViaToolResult } from '@humanos/agent-sdk';
import { ConnectorRefusal, call, proposeAction, registerAgent, requestPolicyMandate, waitForStepUp } from '../lib/connector.js';
import { suggestedUserParams } from '../lib/surface.js';
import { storedSoftwareKey } from '../lib/stored-key.js';
import { loadEnv } from '../lib/env.js';
import { writeFileSync } from 'node:fs';
import { CLAIMS_SURFACE } from '../examples/claims/agent.js';
import { SUPPORT_SURFACE } from '../examples/support/agent.js';

const json = (v: unknown): ViaToolResult => ({ text: JSON.stringify(v), isError: false });

function fakeClient(answer: (name: string, args: Record<string, unknown>) => ViaToolResult) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'fake', version: '0' }, protocolVersion: '2025-11-25' }),
    listTools: async () => [],
    callTool: async (name, args = {}) => {
      calls.push({ name, args });
      return answer(name, args);
    },
  };
  return { client, calls };
}

describe('connector', () => {
  it('call: a refusal is a ConnectorRefusal carrying the server\'s words', async () => {
    const { client } = fakeClient(() => ({ text: 'no such agent', isError: true }));
    await expect(call(client, 'get_actor')).rejects.toThrow(ConnectorRefusal);
    await expect(call(client, 'get_actor')).rejects.toThrow('get_actor refused: no such agent');
  });

  it('registerAgent: challenge, then the public key + nonce-bound evidence + the declared tools', async () => {
    const key = await storedSoftwareKey(join(mkdtempSync(join(tmpdir(), 'via-')), 'k.json'));
    const { client, calls } = fakeClient((name) =>
      name === 'register_challenge' ? json({ regNonce: 'n-1' }) : json({ did: 'did:x', keyId: 'k', granted: { assurance: 'pop', binding: 'self' }, existing: false }),
    );
    const reg = await registerAgent(client, key, CLAIMS_SURFACE);
    expect(reg.did).toBe('did:x');
    expect(calls.map((c) => c.name)).toEqual(['register_challenge', 'register']);
    const args = calls[1]!.args as { publicKeyJwk: Record<string, string>; regNonce: string; evidence: unknown; tools: { name: string }[] };
    expect(args.regNonce).toBe('n-1');
    expect(args.evidence).toEqual({ type: 'none' });
    expect(args.publicKeyJwk).not.toHaveProperty('d'); // the private half never leaves
    expect(args.tools.map((t) => t.name)).toEqual(CLAIMS_SURFACE.tools.map((t) => t.name));
  });

  it('proposeAction: the surface with its grantor params and rules, for this agent', async () => {
    const { client, calls } = fakeClient(() => json({ actionId: 'a', status: 'DRAFT', userParams: [], executionParams: [], next: '' }));
    await proposeAction(client, 'did:x', SUPPORT_SURFACE);
    expect(calls[0]!.args).toMatchObject({ name: SUPPORT_SURFACE.name, did: 'did:x', rules: SUPPORT_SURFACE.rules });
    expect(Object.keys(calls[0]!.args.grantorParams as object)).toEqual(['credit_limit', 'allow_contact_changes']);
  });

  it('requestPolicyMandate: a policy request carrying the §20 description the person reads', async () => {
    const { client, calls } = fakeClient(() => json({ mandateId: 'm', status: 'DRAFT', consentCard: { terms: '', grantor: 'a@b', expiresAt: '', note: '' } }));
    await requestPolicyMandate(client, { did: 'did:x', actionId: 'act', userParams: { credit_limit: 50 }, contact: 'a@b', name: 'N', description: 'D' });
    expect(calls[0]!.args).toEqual({ kind: 'policy', actionId: 'act', userParams: { credit_limit: 50 }, grantor: { contact: 'a@b' }, name: 'N', description: 'D', did: 'did:x' });
  });

  it('suggestedUserParams keeps only what the published policy has', () => {
    expect(suggestedUserParams(SUPPORT_SURFACE, { credit_limit: {} })).toEqual({ credit_limit: 50 });
    expect(suggestedUserParams(SUPPORT_SURFACE)).toEqual({ credit_limit: 50, allow_contact_changes: true });
  });

  it('waitForStepUp: polls while pending, returns the decision', async () => {
    const states = ['pending', 'pending', 'approved'];
    const { client, calls } = fakeClient(() => json({ status: states.shift() }));
    expect(await waitForStepUp(client, 's1', { sleep: async () => {} })).toBe('approved');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ name: 'stepup_status', args: { id: 's1' } });
  });

  it('waitForStepUp: gives up at the deadline', async () => {
    const { client } = fakeClient(() => json({ status: 'pending' }));
    expect(await waitForStepUp(client, 's1', { timeoutMs: 0, sleep: async () => {} })).toBe('timeout');
  });
});

describe('env', () => {
  it('earlier files win, existing env wins over files, comments and quotes handled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-env-'));
    writeFileSync(join(dir, 'a'), '# c\nA="1"\nB=2\n');
    writeFileSync(join(dir, 'b'), 'B=3\nC=4\n#D=5\n');
    const env: NodeJS.ProcessEnv = { C: 'kept' };
    loadEnv([join(dir, 'a'), join(dir, 'missing'), join(dir, 'b')], env);
    expect(env).toEqual({ A: '1', B: '2', C: 'kept' });
  });
});

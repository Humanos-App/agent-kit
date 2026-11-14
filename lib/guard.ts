/**
 * The guard `run` and `chat` call through: one per agent. The organization's policy decides each call first
 * (v0.3 §21.3), by the tool's access — allowed, within a control's rules, denied, or left to a person's mandate — and
 * a mandate the agent holds is presented only for a tool the policy leaves to one.
 */
import { McpGuardVerifier, ViaGuard, policyMandates, type ViaMcpClient } from '@humanos/agent-sdk';
import { serves } from './connector.js';
import type { StoredKey } from './stored-key.js';

export interface Guarded {
  guard: ViaGuard;
  /** The mandate `--mandate` named, presented for every tool the policy leaves to one; absent, chosen per call. */
  mandateId?: string;
}

/**
 * `mandateId` names the held mandate a tool the policy leaves to a mandate presents. Otherwise `policyMandates`
 * chooses per call: one on the control the policy names, else any covering the tool.
 */
export async function guardFor(
  client: ViaMcpClient,
  key: StoredKey,
  opts: { mandateId?: string } = {},
): Promise<Guarded> {
  if (!key.did) throw new Error('not registered — run `register` first');
  if (!(await serves(client, 'get_policy'))) {
    throw new Error("this connector does not decide calls on the organization's policy: the kit needs one that serves get_policy");
  }
  const named = opts.mandateId;
  const mandates = policyMandates(client, key.did, named ? { pick: (_call, held) => held.find((h) => h.mandate.id === named) } : {});
  if (named && !(await mandates.read()).held.some((h) => h.mandate.id === named)) throw new Error(`mandate ${named} is not held`);
  // The kit connects with the organization's API key, not a credential of the agent's own, so the guard names it.
  return {
    guard: new ViaGuard({ agentKey: key, agentDid: key.did, verifier: new McpGuardVerifier(client), mandates, mode: 'enforce' }),
    ...(named ? { mandateId: named } : {}),
  };
}

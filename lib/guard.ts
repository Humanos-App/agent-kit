/**
 * The guard `run` and `chat` call through: under a mandate the agent holds, or, with none, on the
 * organization's policy (v0.3 §21.4), which decides each call by the tool's access — allowed,
 * within a control's rules, a person's mandate required, or denied.
 */
import { McpGuardVerifier, ViaGuard, getMandates, type ViaMcpClient } from '@humanos/agent-sdk';
import { serves } from './connector.js';
import type { AgentDef } from './agent.js';
import type { StoredKey } from './stored-key.js';

export interface Guarded {
  guard: ViaGuard;
  /** The mandate the calls are made under; absent on the organization's policy. */
  mandateId?: string;
}

/**
 * `mandateId` picks a held mandate; `policy` skips them. Otherwise the mandate held for the agent's own action (or
 * the first held), and with none the organization's policy, where the connector has one.
 */
export async function guardFor(
  def: AgentDef,
  client: ViaMcpClient,
  key: StoredKey,
  opts: { mandateId?: string; policy?: boolean } = {},
): Promise<Guarded> {
  if (!key.did) throw new Error('not registered — run `register` first');
  if (opts.mandateId && opts.policy) throw new Error('--mandate and --policy: choose one');
  const verifier = new McpGuardVerifier(client);

  if (!opts.policy) {
    const held = await getMandates(client, key.did);
    const chosen = opts.mandateId
      ? held.find((h) => h.mandate.id === opts.mandateId)
      : (held.find((h) => (h.action?.content as { name?: string } | undefined)?.name === def.surface.name) ?? held[0]);
    if (opts.mandateId && !chosen) throw new Error(`mandate ${opts.mandateId} is not held`);
    if (chosen) {
      return {
        guard: new ViaGuard({ mandate: chosen.mandate, agentKey: key, verifier, compiled: chosen.compiled, mode: 'enforce' }),
        mandateId: chosen.mandate.id,
      };
    }
  }

  if (!(await serves(client, 'get_policy'))) {
    throw new Error(
      opts.policy
        ? "this connector has no organization policy to verify a call on — it verifies mandates only"
        : 'no ACTIVE mandate — `request <contact>`, and have the person accept',
    );
  }
  // The kit connects with the organization's API key, not a credential of the agent's own, so the guard names it.
  return { guard: new ViaGuard({ agentKey: key, agentDid: key.did, verifier, mode: 'enforce' }) };
}

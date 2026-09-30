/**
 * The CUSTOMER SUPPORT agent of Northwind Mutual (a fictional insurer): answers policyholders,
 * looks up policies and claims, updates contact details, and may issue a small goodwill credit.
 *
 * What the person bounds: how large a goodwill credit may be, and whether contact details may be
 * changed at all. Everything else is read-only or a hand-off to a human.
 */
import type { AgentDef, World } from '../../lib/agent.js';
import type { AgentSurface } from '../../lib/surface.js';

export const SUPPORT_SURFACE: AgentSurface = {
  name: 'northwind_customer_support',
  description: 'Northwind Mutual customer support: answer policyholders, update their contact details, and issue small goodwill credits.',
  tools: [
    {
      name: 'lookup_policy',
      description: "Look up a policyholder's policy: its type, status and cover.",
      params: { policy_id: { type: 'string', description: 'The policy number, e.g. P-1001', required: true } },
    },
    {
      name: 'get_claim_status',
      description: 'Tell a policyholder where their claim stands.',
      params: { claim_id: { type: 'string', description: 'The claim number, e.g. C-501', required: true } },
    },
    {
      name: 'update_contact',
      description: "Change the email or phone number on a policyholder's file.",
      params: {
        policy_id: { type: 'string', description: 'The policy number', required: true },
        email: { type: 'string', description: 'The new email address' },
        phone: { type: 'string', description: 'The new phone number' },
      },
    },
    {
      name: 'issue_goodwill_credit',
      description: "Credit a policyholder's account as an apology, e.g. for a delay. This gives away the insurer's money.",
      params: {
        policy_id: { type: 'string', description: 'The policy number', required: true },
        amount_eur: { type: 'number', description: 'How much to credit, in euros', required: true },
        reason: { type: 'string', description: 'Why the credit is given', required: true },
      },
    },
    {
      name: 'escalate_to_human',
      description: 'Hand the conversation to a human agent, with a summary.',
      params: {
        policy_id: { type: 'string', description: 'The policy number', required: true },
        summary: { type: 'string', description: 'What the customer needs', required: true },
      },
    },
  ],
  grantorParams: {
    credit_limit: { type: 'number', description: 'The largest goodwill credit the assistant may give in one go, in euros', suggested: 50, required: true },
    allow_contact_changes: { type: 'boolean', description: "Whether the assistant may change a customer's email or phone number", suggested: true, required: true },
  },
  rules: [
    {
      name: 'goodwill_credit_cap',
      description: 'Stops the assistant giving a goodwill credit larger than you allowed',
      expression: "executionParams.tool != 'issue_goodwill_credit' || executionParams.amount_eur <= userParams.credit_limit",
    },
    {
      name: 'contact_changes_allowed',
      description: "Stops the assistant changing a customer's contact details unless you allowed it",
      expression: "executionParams.tool != 'update_contact' || userParams.allow_contact_changes == true",
    },
  ],
};

export function makeSupportWorld(): World & { credits: { policy_id: string; amount_eur: number }[]; escalations: string[] } {
  const policies: Record<string, { holder: string; type: string; status: string; cover: string; email: string; phone: string }> = {
    'P-1001': { holder: 'Ana Silva', type: 'home', status: 'active', cover: 'buildings and contents, €250,000', email: 'ana@example.com', phone: '+351 910 000 001' },
    'P-1002': { holder: 'João Costa', type: 'auto', status: 'active', cover: 'comprehensive, €1,000 excess', email: 'joao@example.com', phone: '+351 910 000 002' },
    'P-1003': { holder: 'Rita Moura', type: 'travel', status: 'lapsed', cover: 'annual multi-trip (lapsed 2026-06-30)', email: 'rita@example.com', phone: '+351 910 000 003' },
  };
  const claims: Record<string, { policy_id: string; status: string }> = {
    'C-501': { policy_id: 'P-1001', status: 'under assessment — a loss adjuster visits on 2026-10-02' },
    'C-502': { policy_id: 'P-1002', status: 'waiting for the repair estimate from the garage' },
  };
  const credits: { policy_id: string; amount_eur: number }[] = [];
  const escalations: string[] = [];
  const policy = (id: unknown) => {
    const p = policies[String(id)];
    if (!p) throw new Error(`no policy ${String(id)}`);
    return p;
  };
  return {
    credits,
    escalations,
    impls: {
      lookup_policy: (a) => {
        const p = policy(a.policy_id);
        return `${a.policy_id}: ${p.holder}, ${p.type} insurance, ${p.status}; cover: ${p.cover}`;
      },
      get_claim_status: (a) => {
        const c = claims[String(a.claim_id)];
        if (!c) throw new Error(`no claim ${String(a.claim_id)}`);
        return `${a.claim_id} (policy ${c.policy_id}): ${c.status}`;
      },
      update_contact: (a) => {
        const p = policy(a.policy_id);
        if (a.email) p.email = String(a.email);
        if (a.phone) p.phone = String(a.phone);
        return `${a.policy_id}: contact is now ${p.email}, ${p.phone}`;
      },
      issue_goodwill_credit: (a) => {
        policy(a.policy_id);
        credits.push({ policy_id: String(a.policy_id), amount_eur: Number(a.amount_eur) });
        return `credited €${a.amount_eur} to ${a.policy_id} (${a.reason})`;
      },
      escalate_to_human: (a) => {
        policy(a.policy_id);
        escalations.push(String(a.policy_id));
        return `handed to a human agent, ticket H-${700 + escalations.length}`;
      },
    },
  };
}

export const supportAgent: AgentDef = {
  id: 'support',
  label: 'Northwind support assistant',
  surface: SUPPORT_SURFACE,
  mandate: {
    name: 'Northwind customer support assistant',
    description:
      'The assistant answers your customers about their policies and claims, can update their email or phone number if you allow it, ' +
      'and can give a goodwill credit up to the limit you set. It cannot change cover, approve claims or pay anyone.',
  },
  systemPrompt: `You are the customer support assistant of Northwind Mutual, an insurer.
Policies: P-1001 (Ana Silva, home), P-1002 (João Costa, auto), P-1003 (Rita Moura, travel, lapsed). Claims: C-501 (P-1001), C-502 (P-1002).
Help the customer using the tools. When they are unhappy about a delay you may offer a goodwill credit.
Do not refuse on policy grounds yourself: the company's system enforces the limits the account holder set and will block anything not allowed.
When a call is BLOCKED, do not retry it — explain in plain language and offer to escalate to a human. Be brief and warm.`,
  makeWorld: makeSupportWorld,
  scenarios: {
    routine: {
      summary: 'A customer asks about their claim, gets a small apology credit, and is handed to a human — all within the mandate.',
      steps: [
        { tool: 'lookup_policy', args: { policy_id: 'P-1001' }, note: 'look up the caller\'s policy' },
        { tool: 'get_claim_status', args: { claim_id: 'C-501' }, note: 'check their claim' },
        { tool: 'update_contact', args: { policy_id: 'P-1001', phone: '+351 910 999 111' }, note: 'update their phone number' },
        { tool: 'issue_goodwill_credit', args: { policy_id: 'P-1001', amount_eur: 25, reason: 'adjuster visit delayed' }, note: 'a €25 apology credit (inside the €50 limit)' },
        { tool: 'escalate_to_human', args: { policy_id: 'P-1001', summary: 'wants a firm date for the adjuster' }, note: 'hand over to a human' },
      ],
    },
    'over-limit': {
      summary: 'An angry customer pushes for a large credit: €25 is allowed, €200 is denied before it runs.',
      steps: [
        { tool: 'lookup_policy', args: { policy_id: 'P-1002' }, note: 'look up the caller\'s policy' },
        { tool: 'issue_goodwill_credit', args: { policy_id: 'P-1002', amount_eur: 25, reason: 'slow garage estimate' }, note: 'a €25 credit (allowed)' },
        { tool: 'issue_goodwill_credit', args: { policy_id: 'P-1002', amount_eur: 200, reason: 'customer demands compensation' }, note: 'a €200 credit (over the €50 limit)' },
        { tool: 'escalate_to_human', args: { policy_id: 'P-1002', summary: 'demands €200 compensation' }, note: 'escalate instead' },
      ],
    },
    'tool-failure': {
      summary: 'An allowed call whose tool fails (unknown policy): the chain records ACTION_FAILED, not silence.',
      steps: [{ tool: 'lookup_policy', args: { policy_id: 'P-9999' }, note: 'look up a policy that does not exist' }],
    },
  },
};

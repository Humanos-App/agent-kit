/**
 * The command line every agent shares. The agent supplies its definition; this does the
 * platform lifecycle, over the connector, with the organization's API key:
 *
 *   status                       who we are on the platform, and the mandates we hold
 *   register                     mint (or load) the agent's key and register it (v0.3 §16.5)
 *   propose                      propose the agent's action for the organization to publish
 *   request <contact> [--wait]   ask a person for a policy mandate under the published action
 *   wait <mandateId>             poll until the person decides
 *   scenarios                    list the scripted scenarios (offline)
 *   run <scenario>               a scripted, reproducible run under the held mandate
 *   chat                         a real LLM drives the tools; every call is verified
 */
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { McpGuardVerifier, ViaGuard, getMandates, type ViaMcpClient } from '@humanos/agent-sdk';
import { ROOT, loadEnv, must } from './env.js';
import { storedSoftwareKey, type StoredKey } from './stored-key.js';
import {
  call,
  connect,
  getActor,
  mandateKinds,
  mandateStatus,
  proposeAction,
  registerAgent,
  requestPolicyMandate,
  waitForStepUp,
  type ServerInfo,
} from './connector.js';
import { suggestedUserParams, toLlmTools } from './surface.js';
import { describe as describeResult, guardedCall, runSteps } from './runner.js';
import { chatTurn, openRouter, type ModelMessage } from './llm.js';
import type { AgentDef } from './agent.js';

const log = (line = ''): void => console.log(line);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function pollMandate(client: ViaMcpClient, mandateId: string): Promise<void> {
  for (;;) {
    const s = await mandateStatus(client, mandateId);
    if (s.phase !== 'PENDING') {
      log(`${mandateId}: ${s.phase}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/** A guard over the mandate this agent holds for its own action. */
async function guardFor(def: AgentDef, client: ViaMcpClient, key: StoredKey, mandateId?: string): Promise<{ guard: ViaGuard; mandateId: string }> {
  if (!key.did) throw new Error('not registered — run `register` first');
  const held = await getMandates(client, key.did);
  const chosen = mandateId
    ? held.find((h) => h.mandate.id === mandateId)
    : (held.find((h) => (h.action?.content as { name?: string } | undefined)?.name === def.surface.name) ?? held[0]);
  if (!chosen) throw new Error(held.length ? `mandate ${mandateId} is not held` : 'no ACTIVE mandate — `request <contact>`, and have the person accept');
  const guard = new ViaGuard({
    mandate: chosen.mandate,
    agentKey: key,
    verifier: new McpGuardVerifier(client),
    compiled: chosen.compiled,
    mode: 'enforce',
    onRechallenge: async ({ tool, stepUp }) => {
      if (!stepUp) return false;
      log(`  ${tool} needs the person's approval (${stepUp.method ?? 'step-up'}): ${stepUp.approveLink ?? '(link sent to their channel)'}`);
      const state = await waitForStepUp(client, stepUp.id);
      log(`  step-up ${state}`);
      return state === 'approved';
    },
  });
  return { guard, mandateId: chosen.mandate.id };
}

export async function runCli(def: AgentDef, argv: string[] = process.argv.slice(2)): Promise<void> {
  loadEnv();
  const [cmd = 'status', ...rest] = argv;

  if (cmd === 'scenarios') {
    for (const [name, s] of Object.entries(def.scenarios)) log(`${name.padEnd(14)} ${s.summary}`);
    return;
  }

  const client = connect();
  await client.initialize();
  const key = await storedSoftwareKey(join(ROOT, `.agent-key-${def.id}.json`));
  if (key.minted) log(`minted a new P-256 key for ${def.label}`);

  switch (cmd) {
    case 'status': {
      const info = await call<ServerInfo>(client, 'server_info');
      log(`connected as ${info.subject} (org ${info.credential.organization}, signs decisions: ${info.credential.canSignDecisions})`);
      if (!key.did) {
        log(`${def.label}: not registered — run \`register\``);
      } else {
        const a = await getActor(client, key.did);
        const op = a.operator ? `operated by ${a.operator.org}${a.operator.relation ? ` (${a.operator.relation})` : ''}` : 'no AFFILIATION yet';
        log(`${def.label} ${key.did}: ${a.actorType}, ${a.status}, ${a.assurance ?? '?'}/${a.binding ?? '?'}, ${op}`);
        const held = await getMandates(client, key.did);
        log(held.length ? `holds ${held.map((h) => h.mandate.id).join(', ')}` : 'holds no mandate');
      }
      const kinds = await mandateKinds(client);
      const mine = kinds.policies.find((p) => p.name === def.surface.name);
      const draft = kinds.drafts.find((d) => d.name === def.surface.name);
      log(`action "${def.surface.name}": ${mine ? `published v${mine.version}` : draft ? 'proposed, awaiting publication in the dashboard' : 'not proposed'}`);
      return;
    }

    case 'register': {
      if (key.did) return log(`already registered as ${key.did}`);
      const reg = await registerAgent(client, key, def.surface);
      key.save(reg.did);
      log(`registered ${reg.did} — ${reg.granted.assurance}/${reg.granted.binding}${reg.degradedFrom ? ` (degraded from ${reg.degradedFrom})` : ''}`);
      return;
    }

    case 'propose': {
      if (!key.did) throw new Error('register first');
      const r = await proposeAction(client, key.did, def.surface);
      log(`${r.unchanged ? 'already proposed' : 'proposed'} "${def.surface.name}" → ${r.actionId} [${r.status}]`);
      log(`  the person sets: ${r.userParams.join(', ') || '—'} · the agent supplies: ${r.executionParams.join(', ') || '—'}`);
      log(`  next: ${r.next}`);
      return;
    }

    case 'request': {
      if (!key.did) throw new Error('register first');
      const contact = rest.find((a) => !a.startsWith('--'));
      if (!contact) throw new Error('request <contact> — the email or phone of the person who authorizes');
      const policy = (await mandateKinds(client)).policies.find((p) => p.name === def.surface.name);
      if (!policy) throw new Error(`"${def.surface.name}" is not published — the organization publishes the proposed draft in the dashboard first`);
      const req = await requestPolicyMandate(client, {
        did: key.did,
        actionId: policy.id,
        userParams: suggestedUserParams(def.surface, policy.userParams),
        contact,
        name: def.mandate.name,
        description: def.mandate.description,
      });
      log(`asked ${req.consentCard.grantor} for ${req.mandateId} [${req.status}]`);
      log(`  terms: ${req.consentCard.terms}`);
      log(`  approve at: ${req.consentCard.link ?? '(link sent to their channel)'} (until ${req.consentCard.expiresAt})`);
      if (rest.includes('--wait')) await pollMandate(client, req.mandateId);
      return;
    }

    case 'wait': {
      const id = rest[0];
      if (!id) throw new Error('wait <mandateId>');
      return pollMandate(client, id);
    }

    case 'run': {
      const name = rest.find((a) => !a.startsWith('--')) ?? 'routine';
      const scenario = def.scenarios[name];
      if (!scenario) throw new Error(`no scenario "${name}" — try \`scenarios\``);
      const { guard, mandateId } = await guardFor(def, client, key, flag(rest, '--mandate'));
      log(`${def.label} · scenario "${name}": ${scenario.summary}`);
      log(`acting under ${mandateId}`);
      const results = await runSteps(guard, def.makeWorld(), scenario.steps, log);
      const denied = results.filter((r) => r.decision === 'deny').length;
      log(`done: ${results.length - denied} allowed, ${denied} denied — every decision and outcome is on the mandate's chain`);
      return;
    }

    case 'chat': {
      const { guard, mandateId } = await guardFor(def, client, key, flag(rest, '--mandate'));
      const callModel = openRouter({ apiKey: must('OPENROUTER_API_KEY'), model: process.env.VIA_AGENT_MODEL, title: def.label });
      const world = def.makeWorld();
      const tools = toLlmTools(def.surface);
      const history: ModelMessage[] = [{ role: 'system', content: def.systemPrompt }];
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      log(`${def.label} — acting under ${mandateId}. Empty line to quit.`);
      try {
        for (;;) {
          const text = (await rl.question('\nyou> ')).trim();
          if (!text) break;
          const { reply, calls } = await chatTurn(history, text, { callModel, tools, execute: (t, a) => guardedCall(guard, world, t, a) });
          for (const c of calls) log(`  [via] ${describeResult(c)}`);
          log(`\n${def.id}> ${reply}`);
        }
      } finally {
        rl.close();
      }
      return;
    }

    default:
      throw new Error(`unknown command "${cmd}" — status | register | propose | request <contact> | wait <id> | scenarios | run <scenario> | chat`);
  }
}

export function main(def: AgentDef): void {
  runCli(def).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

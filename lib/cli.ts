/**
 * The command line every agent shares. The agent supplies its definition; this does the
 * platform lifecycle, over the connector, with the organization's API key:
 *
 *   status                       who we are on the platform, the mandates we hold, each tool's access
 *   register                     mint (or load) the agent's key and register it (v0.3 §16.5)
 *   propose                      propose the agent's action for the organization to publish
 *   request <contact> [--wait]   ask a person for a policy mandate under the published action
 *   wait <mandateId>             poll until the person decides
 *   scenarios                    list the scripted scenarios (offline)
 *   run <scenario>               a scripted, reproducible run: under the held mandate, or with none
 *                                on the organization's policy (`--mandate <id>`, `--policy` to choose)
 *   chat                         a real LLM drives the tools; every call is verified (same flags)
 */
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { getMandates, type ViaMcpClient } from '@humanos/agent-sdk';
import { ROOT, loadEnv, must } from './env.js';
import { storedSoftwareKey } from './stored-key.js';
import {
  call,
  connect,
  getActor,
  getPolicy,
  mandateKinds,
  mandateStatus,
  proposeAction,
  registerAgent,
  requestPolicyMandate,
  serves,
  type AgentPolicyView,
  type MandateKinds,
  type ServerInfo,
  type ToolAccess,
} from './connector.js';
import { guardFor, type Guarded } from './guard.js';
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

/** `run` and `chat` choose the guard by `--mandate <id>` or `--policy`. */
function guardOpts(args: string[]): { mandateId?: string; policy: boolean } {
  const mandateId = flag(args, '--mandate');
  return { ...(mandateId ? { mandateId } : {}), policy: args.includes('--policy') };
}

function acting(g: Guarded): string {
  return g.mandateId ? `acting under ${g.mandateId}` : "acting with no mandate, on the organization's policy";
}

/** The dashboard's names for a tool's access. */
const ACCESS: Record<ToolAccess, string> = { allow: 'Allow', rules: 'Restrict', mandate: 'Delegate', deny: 'Deny', not_set: 'not set' };

/** The policy in force, and each declared tool's access by its dashboard name, with the controls behind it. */
function logPolicy(view: AgentPolicyView): void {
  log(view.policy ? `policy v${view.policy.version} (${view.policy.id})` : "no policy published: every call needs a person's mandate");
  if (view.standing) log(`  every call is refused: ${view.standing}`);
  if (view.everyCall) log(`  every call also passes ${view.everyCall.name}`);
  const width = Math.max(0, ...view.tools.map((t) => t.tool.length));
  for (const t of view.tools) {
    const names = (t.access === 'rules' ? t.controls : t.mandateControls)?.map((c) => c.name) ?? [];
    log(`  ${t.tool.padEnd(width)}  ${ACCESS[t.access]}${names.length ? ` · ${names.join(', ')}` : ''}`);
  }
}

/** Why the agent's action is not among those a mandate can be asked under. */
function notOffered(kinds: MandateKinds): string {
  return kinds.fromPolicy
    ? 'no tool takes a mandate under it yet — publish it in the dashboard, then set one of its tools to Delegate, or leave it not set'
    : 'not published — the organization publishes the proposed draft in the dashboard first';
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
        const actor = await getActor(client, key.did);
        const a = actor?.record;
        if (!actor) {
          log(`${def.label} ${key.did}: registered (this connector does not read an agent's record)`);
        } else if (!a) {
          log(`${def.label} ${key.did}: registered, its chain not written yet`);
        } else {
          const op = a.operator ? `operated by ${a.operator.org}${a.operator.relation ? ` (${a.operator.relation})` : ''}` : 'no AFFILIATION yet';
          log(`${def.label} ${key.did}: ${a.actorType}, ${a.status}, ${a.assurance ?? '?'}/${a.binding ?? '?'}, ${op}`);
        }
        const held = await getMandates(client, key.did);
        log(held.length ? `holds ${held.map((h) => h.mandate.id).join(', ')}` : 'holds no mandate');
      }
      const kinds = await mandateKinds(client, key.did ?? '');
      const mine = kinds.policies.find((p) => p.name === def.surface.name);
      const draft = kinds.drafts.find((d) => d.name === def.surface.name);
      log(
        `action "${def.surface.name}": ${
          mine ? `published${mine.version ? ` v${mine.version}` : ''}` : draft ? 'proposed, awaiting publication in the dashboard' : kinds.fromPolicy ? notOffered(kinds) : 'not proposed'
        }`,
      );
      if (key.did && (await serves(client, 'get_policy'))) logPolicy(await getPolicy(client, key.did));
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
      const kinds = await mandateKinds(client, key.did);
      const policy = kinds.policies.find((p) => p.name === def.surface.name);
      if (!policy) throw new Error(`action "${def.surface.name}": ${notOffered(kinds)}`);
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
      const guarded = await guardFor(def, client, key, guardOpts(rest));
      log(`${def.label} · scenario "${name}": ${scenario.summary}`);
      log(acting(guarded));
      const results = await runSteps(guarded.guard, def.makeWorld(), scenario.steps, log);
      const denied = results.filter((r) => r.decision === 'deny').length;
      const chain = guarded.mandateId ? "the mandate's chain" : "the agent's chain, under the policy";
      log(`done: ${results.length - denied} allowed, ${denied} denied — every decision and outcome is on ${chain}`);
      return;
    }

    case 'chat': {
      const guarded = await guardFor(def, client, key, guardOpts(rest));
      const { guard } = guarded;
      const callModel = openRouter({ apiKey: must('OPENROUTER_API_KEY'), model: process.env.VIA_AGENT_MODEL, title: def.label });
      const world = def.makeWorld();
      const tools = toLlmTools(def.surface);
      const history: ModelMessage[] = [{ role: 'system', content: def.systemPrompt }];
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      log(`${def.label} — ${acting(guarded)}. Empty line to quit.`);
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

/**
 * What went wrong, in one line. A request that never reached the connector says only `fetch failed`, and its reason
 * (refused, unknown host, TLS) is in `cause`, so it is named with the URL it was for.
 */
export function errorLine(e: unknown, url = process.env.HUMANOS_MCP_URL): string {
  if (!(e instanceof Error)) return String(e);
  if (e.message !== 'fetch failed') return e.message;
  const why = e.cause instanceof Error ? e.cause.message : 'no reason given';
  const hint = url && /^https:\/\/(localhost|127\.0\.0\.1)\b/.test(url) ? ' — a local connector serves http, not https' : '';
  return `could not reach the connector at ${url ?? '(HUMANOS_MCP_URL unset)'}: ${why}${hint}`;
}

export function main(def: AgentDef): void {
  runCli(def).catch((e) => {
    console.error(errorLine(e));
    process.exit(1);
  });
}

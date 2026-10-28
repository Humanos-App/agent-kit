# Humanos agent kit

Put an AI agent under a **mandate** — a signed, bounded permission a person grants. Before any
tool runs, Humanos verifies the call against the mandate; every decision and every outcome is
written to a signed, hash-chained record. That record is what an insurer can score and underwrite
on: it says what the agent was allowed to do, what it tried, and what happened.

Built on [`@humanos/agent-sdk`](https://github.com/Humanos-App/agent-sdk) and the VIA protocol
SDK `@humanos/via-sdk-v03`. `npm install` fetches both from the SDK's repository, pinned to a
release tag, and builds the SDK — there is nothing else to set up.

## The examples

Two agents for **Northwind Mutual**, a fictional insurer. Each works against an in-memory back
office — nothing real is touched.

| | [`examples/support`](examples/support/agent.ts) — customer support | [`examples/claims`](examples/claims/agent.ts) — claims handling |
|---|---|---|
| Tools | `lookup_policy`, `get_claim_status`, `update_contact`, `issue_goodwill_credit`, `escalate_to_human` | `open_claim`, `request_documents`, `assess_claim`, `approve_payout`, `pay_claimant`, `flag_fraud` |
| The person sets | `credit_limit` (€50), `allow_contact_changes` | `payout_limit` (€2,500), `allowed_claim_types` (home, travel) |
| Rules | `goodwill_credit_cap`, `contact_changes_allowed` | `payout_cap`, `claim_type_allowed` |

They are independent: each has its own key, identity (DID), action and mandate, under one
organization.

## How an agent lives on Humanos

1. **Register.** The agent creates its own P-256 key and registers it. The organization vouches for
   it, and Humanos grades how the key is held.
2. **Propose.** The agent proposes its tools, the limits a person controls, and the rules that
   enforce them. The organization reviews and publishes it in the dashboard.
3. **Mandate.** A person approves on the consent screen, setting the limits, and sees in plain
   words what the agent may do.
4. **Act.** Every tool call is proved with the agent's key and verified on the organization's
   policy, and against the mandate for a tool the policy leaves to one: *allowed*, or *denied* and
   the tool never runs.
   The outcome of every allowed call is reported back.

## Run it

Requires Node.js 20 or later, and `git` (npm uses it to fetch the SDK).

```
npm install
cp .env.example .env        # fill in your organization's API key
```

The kit runs against the Humanos **staging** environment:

1. **Create your organization.** Sign up at https://apptest.humanos.tech and register your
   organization. The agents will belong to it.
2. **Create an API key** for the organization in the dashboard. Its signing secret is shown once.
3. **Put both in `.env`** as `HUMANOS_API_KEY` and `HUMANOS_SIGNATURE_SECRET`. `HUMANOS_MCP_URL`
   is already set to the staging connector, `https://mcptest.humanos.tech/mcp`.

The same dashboard is where you publish the agents' actions, and where the person who grants a
mandate approves it.

Each example has the same commands (replace `support` with `claims`):

```
npm run support -- register                  # create the agent's key and register it, with its tools
npm run support -- declare                   # declare its tools again, after changing them
npm run support -- propose                   # propose its action; publish it in the dashboard
npm run support -- request <email> --wait    # the person approves the mandate
npm run support -- status
```

Then drive it — scripted and reproducible, or with a real model:

```
npm run support -- scenarios                 # list the scripted runs
npm run support -- run routine               # everything inside the mandate
npm run support -- run over-limit            # a €200 credit, denied before it runs
npm run claims  -- run routine               # assess → approve → pay
npm run claims  -- run over-limit            # a €7,400 auto claim: two rules fail
npm run claims  -- run fraud                 # a flagged claim: the tool fails, recorded as such
npm run support -- chat                      # a model picks the tools; each call is verified
```

### The organization's policy decides first

`run` and `chat` verify each call on the organization's policy, which sets each tool's access in
the dashboard. A mandate the agent holds is presented only for a tool set to Delegate: one on the
control the policy names, else any covering the tool. `--mandate <id>` names the one to present.
`status` lists each tool's access and the policy's default.

| Access | A call |
|---|---|
| Allow | allowed |
| Restrict | allowed within the control's rules; otherwise denied (`rule_failed`, …) |
| Delegate | decided by the person's mandate; with none, denied `mandate_required`, naming the controls it must be under |
| Deny | denied, `policy_denied` |
| Not set | the policy's default: allowed, or denied `policy_denied` |

A mandate a person has just granted is picked up on the next call: a `mandate_required` deny reads
the policy and the mandates again, and the call is presented once more. A call a person would have
to approve is denied `stepup_required`: Humanos does not support approving a single call yet. It
needs a connector that decides policy first (agent-sdk 0.3, one that serves `get_policy`).

## Build your own

An agent is one definition ([`lib/agent.ts`](lib/agent.ts)): its tools, the limits the person
sets, the rules, what the person is shown, and its tool implementations. Each tool is declared to
Humanos as an MCP server describes one: a title, the service it comes from, the JSON Schema of
its input (formats, patterns, allowed values, ranges) and hints on how it behaves (read-only,
destructive, idempotent, reaching outside the organization). The organization sees them beside
the tool, and Humanos assesses its risk from them. `lib/` does the rest:

| | |
|---|---|
| [`lib/stored-key.ts`](lib/stored-key.ts) | the agent's key, kept across runs |
| [`lib/connector.ts`](lib/connector.ts) | registration, proposals, the organization's policy, mandate requests |
| [`lib/guard.ts`](lib/guard.ts) | the guard every call goes through: the policy first, a mandate for a tool it leaves to one |
| [`lib/surface.ts`](lib/surface.ts) | one tool definition → the proposal, the registration, the model's function list |
| [`lib/runner.ts`](lib/runner.ts) | a guarded call as a result: allowed, denied, or failed |
| [`lib/llm.ts`](lib/llm.ts) | the model loop; a deny goes back to the model as "do not retry" |
| [`lib/cli.ts`](lib/cli.ts) | the commands above |

## Tests

```
npm test
```

Offline, against `@humanos/agent-sdk/testing`: an in-process verifier that checks each call's
proof and evaluates the rules as Humanos does. The tests cover the rules, every scripted
scenario, a call that needs a person's approval, and that every allowed call's outcome is
reported. Calls on the organization's policy run against a connector double.

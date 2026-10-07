# Humanos agent kit

Put an AI agent under a **mandate** — a signed, bounded permission a person grants. Before any
tool runs, Humanos verifies the call against the mandate; every decision and every outcome is
written to a signed, hash-chained record. That record is what an insurer can score and underwrite
on: it says what the agent was allowed to do, what it tried, and what happened.

Built on `@humanos/agent-sdk` and the VIA protocol SDK `@humanos/via-sdk-v03`. Both ship with
this kit, packaged, in [`vendor/`](vendor) — nothing else from Humanos needs to be installed.

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
4. **Act.** Every tool call is proved with the agent's key and verified against the mandate:
   *allowed*, *denied* (the tool never runs), or *needs the person's approval* (a step-up). The
   outcome of every allowed call is reported back.

## Run it

Requires Node.js 20 or later.

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
npm run support -- register                  # create the agent's key and register it
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

To see a person approve a single payment, publish the claims action with `pay_claimant` behind a
step-up: the run pauses on it until they approve on their own device.

## Build your own

An agent is one definition ([`lib/agent.ts`](lib/agent.ts)): its tools, the limits the person
sets, the rules, what the person is shown, and its tool implementations. `lib/` does the rest:

| | |
|---|---|
| [`lib/stored-key.ts`](lib/stored-key.ts) | the agent's key, kept across runs |
| [`lib/connector.ts`](lib/connector.ts) | registration, proposals, mandate requests, step-ups |
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
scenario, the step-up approved and declined, and that every allowed call's outcome is reported.

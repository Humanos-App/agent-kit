/**
 * What an agent IS, independent of how it is driven: its surface, its world (the insurer's
 * back office, in memory), what the person is asked to sign, and the scripted scenarios.
 */
import type { AgentSurface } from './surface.js';

export type ToolImpl = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface World {
  impls: Record<string, ToolImpl>;
}

export interface Step {
  tool: string;
  args: Record<string, unknown>;
  /** What the step is for, printed as it runs. */
  note: string;
}

export interface Scenario {
  summary: string;
  steps: Step[];
}

export interface AgentDef {
  /** Short id: names the key file and the CLI. */
  id: string;
  label: string;
  surface: AgentSurface;
  /** What the person sees on the consent screen: the mandate's name and its §20 (v0.3) description. */
  mandate: { name: string; description: string };
  systemPrompt: string;
  makeWorld(): World;
  scenarios: Record<string, Scenario>;
}

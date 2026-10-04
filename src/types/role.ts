/** Role system: what an AI is supposed to do, independent of any provider (§11). */

export interface RoleDefinition {
  /** Slug identifier, e.g. "architecture-reviewer". */
  id: string;
  name: string;
  description?: string;
  responsibilities: string[];
  /** What the role is expected to return, e.g. findings, evidence, recommendations. */
  expectedOutputs: string[];
  /** Optional hint; roles remain provider- and agent-independent. */
  preferredAgents?: string[];
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

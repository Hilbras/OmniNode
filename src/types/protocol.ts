/** Agent ↔ OmniNode communication protocol (§21). */
import type { AgentStatus } from "./agent.js";
import type { Report } from "./report.js";
import type { RoleDefinition } from "./role.js";

export interface EnvelopeMeta {
  taskId?: string;
  agent?: string;
  timestamp: string;
  correlationId?: string;
}

export type AgentToNodeMessage =
  | { type: "TASK_REQUEST"; payload: { objective: string; role?: string } }
  | { type: "REPORT"; payload: Report }
  | { type: "STATUS"; payload: { state: AgentStatus; detail?: string } }
  | { type: "QUESTION"; payload: { question: string } }
  | { type: "ARTIFACT"; payload: { path: string; description?: string } }
  | { type: "COMPLETION"; payload: { summary?: string } }
  | { type: "ERROR"; payload: { code: string; message: string } };

export type NodeToAgentMessage =
  | { type: "TASK"; payload: { taskId: string; objective: string } }
  | { type: "CONTEXT"; payload: { body: string } }
  | { type: "ROLE"; payload: RoleDefinition }
  | { type: "INSTRUCTION"; payload: { text: string } }
  /** Plan schema lands in Phase 8. */
  | { type: "PLAN"; payload: unknown }
  | { type: "FEEDBACK"; payload: { text: string } }
  | { type: "VERIFICATION_RESULT"; payload: { passed: boolean; details?: string } };

export interface MessageEnvelope<T extends AgentToNodeMessage | NodeToAgentMessage> {
  meta: EnvelopeMeta;
  message: T;
}

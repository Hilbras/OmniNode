/** Structured report format so reports can be processed programmatically (§16). */

export type Confidence = "low" | "medium" | "high";

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface Finding {
  id: string;
  title: string;
  detail: string;
  severity?: FindingSeverity;
  evidence?: string[];
  /** File path or conceptual location the finding refers to. */
  location?: string;
  tags?: string[];
}

export interface Report {
  id: string;
  taskId: string;
  /** Agent name from the agent registry. */
  agent: string;
  /** Model id used, if known. */
  model?: string;
  summary: string;
  findings: Finding[];
  recommendations: string[];
  confidence?: Confidence;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

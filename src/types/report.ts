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

/** Source attribution for an aggregated finding (§17). */
export interface FindingSource {
  agent: string;
  reportId: string;
}

export interface AggregatedFinding {
  title: string;
  /** Distinct details contributed across reports. */
  details: string[];
  sources: FindingSource[];
  /** How many reports reported this (or a similar) finding. */
  occurrences: number;
  /** Highest severity seen across merged duplicates. */
  severity?: FindingSeverity;
  evidence: string[];
}

export interface AggregatedRecommendation {
  text: string;
  sources: FindingSource[];
  occurrences: number;
}

/** Combined intelligence produced from several independent reports (§17). */
export interface CombinedReport {
  id: string;
  title: string;
  objective?: string;
  pipelineRunId?: string;
  taskIds: string[];
  summary: string;
  findings: AggregatedFinding[];
  recommendations: AggregatedRecommendation[];
  /** Distinct agent names that contributed. */
  sources: string[];
  reportIds: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

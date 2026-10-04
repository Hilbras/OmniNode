/** Structured report format so reports can be processed programmatically (§16). */

export type Confidence = "low" | "medium" | "high";

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

/** Typed evidence (roadmap §13, Evidence). Plain strings remain accepted
 *  and normalize to `observation` evidence. */
export type EvidenceKind = "file" | "line" | "url" | "command" | "observation" | "artifact";

export interface Evidence {
  kind: EvidenceKind;
  /** Path, URL, command or logical reference. */
  ref?: string;
  /** Line number for file/line evidence. */
  line?: number;
  /** Verbatim excerpt backing the finding. */
  excerpt?: string;
  /** Agent that produced the evidence. */
  agent?: string;
}

export type EvidenceInput = string | Evidence;

/** Artifact produced alongside a report (§13). */
export interface ReportArtifact {
  kind: "file" | "patch" | "log" | "screenshot" | "document" | "data";
  ref: string;
  description?: string;
  mediaType?: string;
  bytes?: number;
}

/** Where a finding came from, when known. */
export interface FindingOrigin {
  agent?: string;
  reportId?: string;
  pipelineRunId?: string;
}

export interface Finding {
  id: string;
  title: string;
  /** v1 field, kept for compatibility; `description` is the v2 field. */
  detail: string;
  /** Full description of the finding (§13, Findings). */
  description?: string;
  severity?: FindingSeverity;
  confidence?: Confidence;
  evidence?: EvidenceInput[];
  /** File path or conceptual location the finding refers to. */
  location?: string;
  tags?: string[];
  /** Provenance of the finding, when known (§13). */
  source?: FindingOrigin;
  /** The concrete fix this finding implies. */
  recommendation?: string;
}

export interface Report {
  id: string;
  taskId: string;
  /** Agent name from the agent registry. */
  agent: string;
  /** v2 spelling of `agent` for machine consumers (§13). */
  agentId?: string;
  /** Pipeline run that produced this report, when applicable. */
  pipelineRunId?: string;
  /** Model id used, if known. */
  model?: string;
  summary: string;
  findings: Finding[];
  recommendations: string[];
  confidence?: Confidence;
  /** Report-level evidence backing the summary. */
  evidence?: EvidenceInput[];
  /** Artifacts produced with the report (§13, Artifacts). */
  artifacts?: ReportArtifact[];
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
  confidence?: Confidence;
  /** Typed evidence, normalized from strings when reports were ingested. */
  evidence: Evidence[];
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

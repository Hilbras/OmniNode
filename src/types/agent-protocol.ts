/** A question an agent asked during a run, with the answer OmniNode gave. */
export interface AskedQuestion {
  questionId: string;
  question: string;
  answer?: string;
}

/** Agent descriptor exchanged during the protocol handshake (PROTOCOL.md). */
export interface AgentDescriptor {
  /** Protocol the agent speaks. */
  protocol: string;
  name: string;
  version?: string;
  capabilities: string[];
  /** Message types the agent can emit. */
  supports: string[];
}

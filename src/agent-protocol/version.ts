/**
 * OmniNode Agent Protocol v2 — versioning (roadmap §7.1).
 *
 * Protocol identifiers are namespaced strings so an agent can negotiate the
 * dialect it speaks: `omninode-agent-protocol/2`.
 */
export const PROTOCOL_V2 = "omninode-agent-protocol/2";

/** Versions this build accepts. v1 is the unversioned dialect shipped with OmniNode 1.x. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "omninode-agent-protocol/1",
  PROTOCOL_V2,
];

export const MAX_MESSAGE_BYTES = 1_048_576; // 1 MiB per message line

export function isSupportedProtocol(protocol: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(protocol);
}
/** Template written by `omninode init` (§22, §23). */

export function defaultProjectConfigYaml(projectName = "My Project"): string {
  return `project:
  name: ${projectName}

  # Providers connect OmniNode to AI model gateways (Phase 1+).
  # Credentials are referenced by environment variable, never stored in this file.
  providers: []
  #  - name: my-gateway
  #    type: openai-compatible
  #    base_url: https://example.com/v1
  #    api_key_env_var: MY_API_KEY

  # CLI agents registered with OmniNode (Phase 3 wires them up).
  agents: []
  #  - name: opencode
  #    type: cli
  #    command: opencode

  # Roles describe what an AI is supposed to do (Phase 4).
  roles: []
  #  - id: architecture-reviewer
  #    name: Architecture Reviewer
  #    responsibilities:
  #      - architecture analysis
  #    expected_outputs:
  #      - findings
  #      - recommendations

  # Memory is optional; Remembera is the preferred integration (Phase 7).
  # memory:
  #   provider: remembera
`;
}

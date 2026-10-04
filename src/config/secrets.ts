/**
 * Inline secret detection (roadmap §17, Secrets).
 *
 * OmniNode configuration must never contain literal credentials — only
 * environment-variable *references*. This scanner runs before the config is
 * parsed and reports anything that looks like an inline secret, so the file
 * is rejected before it can be committed or persisted.
 */

export interface SecretFinding {
  /** 1-based line number in the source. */
  line: number;
  /** The offending key, e.g. `api_key`. */
  key: string;
  /** Redacted excerpt — never echoes the value. */
  excerpt: string;
}

/** Keys that are references or placeholders, not secrets. */
const SAFE_KEY_SUFFIXES = ["_env", "_env_var", "_file", "_path", "_ref", "_id", "_url", "_command"];

const SECRET_KEY = /^\s*([A-Za-z0-9_-]*(?:api[_-]?key|token|password|passwd|secret|credential)[A-Za-z0-9_-]*)\s*:\s*(.*)$/i;

/** Values that are clearly references, not credentials. */
const SAFE_VALUE = /^\s*(?:\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|<[^>]*>|""|''|null|~)\s*$/i;

export function scanForInlineSecrets(source: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return; // comments are not credentials
    const match = SECRET_KEY.exec(line);
    if (!match) return;
    const key = match[1] ?? "";
    const rawValue = (match[2] ?? "").trim().replace(/,\s*$/, "");
    const keyIsReference = SAFE_KEY_SUFFIXES.some((suffix) => key.toLowerCase().endsWith(suffix));
    if (keyIsReference) return;
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (value.length === 0 || SAFE_VALUE.test(rawValue)) return;
    // Very short values are almost always placeholders, not credentials.
    if (value.length < 8) return;
    findings.push({
      line: index + 1,
      key,
      excerpt: `${key}: ${value.slice(0, 3)}… (${value.length} chars, redacted)`,
    });
  });
  return findings;
}

/** Formats findings as an actionable configuration error message. */
export function describeSecretFindings(file: string, findings: SecretFinding[]): string {
  const lines = findings.map((f) => `  line ${f.line}: ${f.excerpt}`).join("\n");
  return (
    `${file} appears to contain ${findings.length} inline secret(s):\n${lines}\n` +
    `OmniNode never stores credentials in configuration. Replace each value with an ` +
    `environment-variable reference, e.g. api_key_env_var: MY_API_KEY.`
  );
}

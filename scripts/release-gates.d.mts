export interface VersionCheckResult {
  ok: boolean;
  version: string;
  problems: string[];
}

export interface PackCheckResult {
  ok: boolean;
  problems: string[];
  files: string[];
}

export interface SecretScanResult {
  ok: boolean;
  problems: string[];
}

export declare function checkVersionConsistency(repoRoot?: string): VersionCheckResult;
export declare function validatePackContents(repoRoot?: string): PackCheckResult;
export declare function scanSecrets(repoRoot?: string): SecretScanResult;

/** Projects are first-class entities (§12). */

export interface Project {
  name: string;
  repository?: string;
  workspace?: string;
  agents: string[];
  roles: string[];
  providers?: string[];
  memory?: {
    provider: string;
  };
  createdAt?: string;
}

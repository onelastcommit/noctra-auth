export type Scope = "write" | "git" | "read";

export type PermissionLevel = "read" | "write";

export type InstallationPermissions = Record<string, PermissionLevel>;

export const SCOPES: Record<Scope, InstallationPermissions> = {
  write: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "read",
    actions: "read",
    metadata: "read",
  },
  git: {
    contents: "write",
    metadata: "read",
  },
  read: {
    contents: "read",
    pull_requests: "read",
    issues: "read",
    checks: "read",
    actions: "read",
    metadata: "read",
  },
};

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && Object.hasOwn(SCOPES, value);
}

export const REPO_ROLES_ALLOWED_TO_MINT: ReadonlySet<string> = new Set(["admin", "write"]);

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export interface RepoRef {
  owner: string;
  name: string;
}

export function parseRepository(value: unknown): RepoRef | null {
  if (typeof value !== "string") return null;
  const [owner, name, ...rest] = value.split("/");
  if (rest.length > 0 || !owner || !name) return null;
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name) || name === "." || name === "..") {
    return null;
  }
  return { owner, name };
}

import type { AuditSink } from "./audit";
import type { Config } from "./config";
import type { FetchFn, GitHubApp } from "./github";
import type { Store } from "./store";

export interface Context {
  config: Config;
  store: Store;
  app: GitHubApp;
  fetchFn: FetchFn;
  nowSeconds: () => number;
  log: AuditSink;
  ray: string;
  clientIp: string;
}

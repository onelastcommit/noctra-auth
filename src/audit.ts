export type AuditEvent =
  | "link"
  | "link_rejected"
  | "token_issued"
  | "token_rejected"
  | "unlink"
  | "unlink_rejected"
  | "webhook"
  | "webhook_rejected"
  | "purge"
  | "service_error";

export interface AuditFields {
  outcome: "ok" | "denied" | "error";
  reason?: string;
  instance_id?: string;
  github_user_id?: number;
  installation_id?: number;
  installation_ids?: number[];
  repository?: string;
  scope?: string;
  expires_at?: string;
  github_event?: string;
  github_action?: string;
  delivery_id?: string;
  affected?: number;
  ray?: string;
}

export type AuditSink = (line: string) => void;

export function audit(sink: AuditSink, event: AuditEvent, fields: AuditFields): void {
  sink(JSON.stringify({ ts: new Date().toISOString(), service: "noctra-auth", event, ...fields }));
}

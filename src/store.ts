export interface Instance {
  instanceId: string;
  githubUserId: number;
  publicKey: string;
  createdAt: number;
}

interface InstanceRow {
  instance_id: string;
  github_user_id: number;
  public_key: string;
  created_at: number;
}

export class Store {
  constructor(private readonly db: D1Database) {}

  async createInstance(instance: Instance, installationIds: number[]): Promise<void> {
    const statements = [
      this.db
        .prepare(
          "INSERT INTO instances (instance_id, github_user_id, public_key, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(instance.instanceId, instance.githubUserId, instance.publicKey, instance.createdAt),
      ...installationIds.map((id) =>
        this.db
          .prepare("INSERT INTO instance_installations (instance_id, installation_id) VALUES (?, ?)")
          .bind(instance.instanceId, id),
      ),
    ];
    await this.db.batch(statements);
  }

  async getInstance(instanceId: string): Promise<Instance | null> {
    const row = await this.db
      .prepare(
        "SELECT instance_id, github_user_id, public_key, created_at FROM instances WHERE instance_id = ?",
      )
      .bind(instanceId)
      .first<InstanceRow>();
    return row
      ? {
          instanceId: row.instance_id,
          githubUserId: row.github_user_id,
          publicKey: row.public_key,
          createdAt: row.created_at,
        }
      : null;
  }

  async publicKeyInUse(publicKey: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS found FROM instances WHERE public_key = ?")
      .bind(publicKey)
      .first();
    return row !== null;
  }

  async countInstancesForUser(githubUserId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM instances WHERE github_user_id = ?")
      .bind(githubUserId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async isInstallationLinked(instanceId: string, installationId: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS found FROM instance_installations WHERE instance_id = ? AND installation_id = ?",
      )
      .bind(instanceId, installationId)
      .first();
    return row !== null;
  }

  async installationIdsFor(instanceId: string): Promise<number[]> {
    const { results } = await this.db
      .prepare(
        "SELECT installation_id FROM instance_installations WHERE instance_id = ? ORDER BY installation_id",
      )
      .bind(instanceId)
      .all<{ installation_id: number }>();
    return results.map((r) => r.installation_id);
  }

  async deleteInstance(instanceId: string): Promise<boolean> {
    const [, removed] = await this.db.batch([
      this.db.prepare("DELETE FROM instance_installations WHERE instance_id = ?").bind(instanceId),
      this.db.prepare("DELETE FROM instances WHERE instance_id = ?").bind(instanceId),
    ]);
    return (removed?.meta.changes ?? 0) > 0;
  }

  async deleteInstancesForUser(githubUserId: number): Promise<number> {
    const [, removed] = await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM instance_installations WHERE instance_id IN (SELECT instance_id FROM instances WHERE github_user_id = ?)",
        )
        .bind(githubUserId),
      this.db.prepare("DELETE FROM instances WHERE github_user_id = ?").bind(githubUserId),
    ]);
    return removed?.meta.changes ?? 0;
  }

  async unlinkInstallation(installationId: number): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM instance_installations WHERE installation_id = ?")
      .bind(installationId)
      .run();
    return result.meta.changes ?? 0;
  }

  async linkInstallationForUser(githubUserId: number, installationId: number): Promise<number> {
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO instance_installations (instance_id, installation_id) SELECT instance_id, ? FROM instances WHERE github_user_id = ?",
      )
      .bind(installationId, githubUserId)
      .run();
    return result.meta.changes ?? 0;
  }

  async consumeNonce(scope: string, nonce: string, expiresAt: number): Promise<boolean> {
    const result = await this.db
      .prepare("INSERT OR IGNORE INTO nonces (scope, nonce, expires_at) VALUES (?, ?, ?)")
      .bind(scope, nonce, expiresAt)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async recordHit(bucket: string, windowStart: number, expiresAt: number): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO rate_limits (bucket, window_start, hits, expires_at) VALUES (?, ?, 1, ?) ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits",
      )
      .bind(bucket, windowStart, expiresAt)
      .first<{ hits: number }>();
    return row?.hits ?? 1;
  }

  async purgeExpired(nowSeconds: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM nonces WHERE expires_at < ?").bind(nowSeconds),
      this.db.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(nowSeconds),
    ]);
  }
}

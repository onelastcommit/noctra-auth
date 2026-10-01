import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Param = string | number | null;

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: Param[] = [],
  ) {}

  bind(...params: Param[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ results: []; success: true; meta: { changes: number } }> {
    return { results: [], success: true, meta: { changes: this.execute() } };
  }

  execute(): number {
    return Number(this.db.prepare(this.sql).run(...this.params).changes);
  }
}

export class TestD1 {
  readonly raw: DatabaseSync;

  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON");
    const dir = join(import.meta.dirname, "..", "migrations");
    for (const file of readdirSync(dir).sort()) this.raw.exec(readFileSync(join(dir, file), "utf8"));
  }

  prepare(sql: string): Statement {
    return new Statement(this.raw, sql);
  }

  async batch(statements: Statement[]) {
    this.raw.exec("BEGIN");
    try {
      const results = statements.map((s) => ({ results: [], success: true, meta: { changes: s.execute() } }));
      this.raw.exec("COMMIT");
      return results;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  dump(): string {
    const tables = ["instances", "instance_installations", "nonces", "rate_limits"];
    return JSON.stringify(tables.map((t) => this.raw.prepare(`SELECT * FROM ${t}`).all()));
  }

  count(table: string): number {
    return Number((this.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  }
}

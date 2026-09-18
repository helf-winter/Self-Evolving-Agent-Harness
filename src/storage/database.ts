import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HarnessError } from "../domain/errors.js";
import { migrations } from "./migrations.js";

export class RuntimeDatabase {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(this.all<{ version: number }>("SELECT version FROM schema_migrations").map((row) => row.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.database.exec(migration.sql);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.version, new Date().toISOString());
      });
    }
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    try {
      this.database.prepare(sql).run(...params);
    } catch (error) {
      this.rethrow(error);
    }
  }

  get<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
    try {
      return this.database.prepare(sql).get(...params) as T | undefined;
    } catch (error) {
      this.rethrow(error);
    }
  }

  all<T extends object = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    try {
      return this.database.prepare(sql).all(...params) as T[];
    } catch (error) {
      this.rethrow(error);
    }
  }

  transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private rethrow(error: unknown): never {
    if (error instanceof HarnessError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/busy|locked/i.test(message)) throw new HarnessError("database_busy", message);
    throw new HarnessError("storage_failure", message, error);
  }
}

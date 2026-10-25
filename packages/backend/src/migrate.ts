import { runner } from "node-pg-migrate";
import { repoRoot } from "./paths.js";
import { join } from "node:path";

/** node-pg-migrate 的 SQL 迁移。目录相对 resume-agent 根目录。 */
export const migrationsDir = join(repoRoot, "migrations");

/**
 * 用 node-pg-migrate 执行 SQL 迁移。
 * 向量列、HNSW 和生成列用 SQL 写最直接，版本记在 pgmigrations 表里。
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
}

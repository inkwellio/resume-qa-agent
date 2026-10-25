import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { runMigrations } from "./migrate.js";
import { repoRoot } from "./paths.js";

loadEnvFile(join(repoRoot, ".env"));

const config = loadConfig();
await runMigrations(config.databaseUrl);
console.log("数据库迁移已完成。");

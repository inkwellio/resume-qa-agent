import { Pool } from "pg";
import { createPgVectorStore, VECTOR_DIMENSION } from "@resume/retrieval";
import { join } from "node:path";
import { createApp } from "./app.js";
import { createPostgresBusinessStore } from "./business-store.js";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { runMigrations } from "./migrate.js";
import { repoRoot } from "./paths.js";
import { createPostgresProtection } from "./pg-abuse-protection.js";
import { DEFAULT_ABUSE_LIMITS } from "./abuse-protection.js";
import { createEmailAuth } from "./code-mailer.js";
import { emailAuthConfigured } from "./email-auth.js";
import { createPostgresIpBans } from "./pg-ip-ban.js";
import { createPostgresAdminAccounts } from "./admin-accounts.js";
import { createPostgresAdminDirectory } from "./admin-directory.js";

loadEnvFile(join(repoRoot, ".env"));

const config = loadConfig();
if (config.embeddingDimension !== VECTOR_DIMENSION) {
  throw new Error(
    `EMBEDDING_DIMENSION=${config.embeddingDimension}，数据库列是 vector(${VECTOR_DIMENSION})。两者必须一致。`,
  );
}

const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
await runMigrations(config.databaseUrl);
const app = createApp(config, {
  auth: createEmailAuth(pool, config.emailAuth!),
  business: createPostgresBusinessStore(pool),
  vector: createPgVectorStore(pool),
  protection: createPostgresProtection(pool, {
    rateWindowMs: config.rateLimitWindowMs, rateMax: config.rateLimitMax,
    limits: config.abuseLimits ?? DEFAULT_ABUSE_LIMITS,
  }),
  ipBans: createPostgresIpBans(pool),
  adminAccounts: createPostgresAdminAccounts(pool),
  adminDirectory: createPostgresAdminDirectory(pool),
});
const server = app.listen(config.port, () => {
  const mode = config.chatMock ? "演示模式" : "模型模式";
  console.log(`简历助手已启动（${mode}）：http://127.0.0.1:${config.port}`);
  if (config.emailAuth?.devMailer && emailAuthConfigured(config.emailAuth)) {
    console.warn("EMAIL_DEV_MAILER=1：验证码只打印在本进程日志，不会调用阿里云，也不会出现在接口或页面上。正式环境请改为 0，并填写已验证的发信地址与 AccessKey。");
  } else if (!config.emailAuth || !emailAuthConfigured(config.emailAuth)) {
    console.warn("邮箱发送配置未完成，公开简历可浏览，聊天保持关闭。请参考 .env.example 配置邮箱验证。");
  }
});

async function shutdown(): Promise<void> {
  server.close();
  await pool.end();
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

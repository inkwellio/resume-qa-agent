# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

简历问答助手：访客（招聘方）就一份简历提问，后端 Agent 调 DeepSeek 并通过工具做混合检索，用第三人称回答。README.md 是开源示例的使用说明，内置虚构演示人物「林知夏」和 example 占位联系方式；行为细节以代码和 CHANGELOG.md 为准。CHANGELOG.md 按 Keep a Changelog 记录 `[未发布]` 改动。仓库文档、注释、提交信息都用中文，提交前缀用 `feat:` / `fix:`。不要把真人简历、真实联系方式、真实 PDF 路径或密钥写进仓库。

## 常用命令

pnpm 10 workspace，Node >= 22。根目录执行：

```bash
docker compose up -d        # 本地 Postgres + pgvector（resume/resume，5432），首次初始化建测试库 resume_test
pnpm migrate                # node-pg-migrate 执行 migrations/*.sql（后端启动时也会跑）
pnpm ingest                 # 切块 + 向量化，事务内重建 resume_chunks（需 EMBEDDING_API_KEY）
pnpm dev                    # 先编译 retrieval，再起后端 8787 + 前端 5174；Windows 上会尝试用 WSL 拉起 Postgres
pnpm admin:create           # 按 ADMIN_PHONE / ADMIN_PASSWORD 创建或同步站长账号
pnpm typecheck
pnpm lint
pnpm build
pnpm test:unit              # 不需要数据库和真实模型
pnpm test:integration       # 需要 resume_test 库（pnpm test:db:init），会清空该库
pnpm test                   # unit + integration
```

单个测试：

```bash
pnpm --filter @resume/backend exec vitest run test/tools.test.ts
pnpm --filter @resume/backend exec vitest run test/tools.test.ts -t "用例名"
pnpm --filter @resume/retrieval exec vitest run test/chunk.test.ts
node --experimental-strip-types --test packages/frontend/test/answer-extras.test.ts   # 前端测试用 node:test，不是 vitest
```

- 集成测试的文件列表**写死在** `packages/backend/package.json` 的 `test:unit`（`--exclude`）和 `test:integration` 里（`chat`、`pg-*`）。新增需要数据库的测试文件时，两处都要改。
- 集成测试默认连 `postgres://resume:resume@127.0.0.1:5432/resume_test`，可用 `TEST_DATABASE_URL` 覆盖，库名必须以 `_test` 结尾；不读业务 `DATABASE_URL`。
- 后端 vitest 把 `@resume/retrieval` 别名到源码；但 `pnpm dev`、`typecheck`、`build`、`ingest` 依赖 retrieval 的 `dist`，脚本里都会先编译它。
- `CHAT_MOCK=1 pnpm dev` 不调用模型（PowerShell：`$env:CHAT_MOCK = "1"; pnpm dev`）。聊天仍需要邮箱验证；本地设 `EMAIL_DEV_MAILER=1` 和至少 32 字符的 `EMAIL_AUTH_SECRET`，验证码打在后端终端（`[email-dev] …`）。生产环境禁止 `EMAIL_DEV_MAILER=1`。
- 评测：`pnpm eval:retrieval`（`--keyword` 只评关键词，不发外部请求）、`pnpm eval:security`（真实模型，需 `DEEPSEEK_API_KEY`）。改提示词或模型后应重跑。

## 架构

三个包：

- `packages/retrieval`：切块（`chunk.ts` / `sources.ts` 读 `data/resume/` 的 `profile.json`、`entries.json`、Markdown）、jieba 分词（`segment.ts`）、embeddings 客户端、`VectorStore` 接口及 pgvector 实现。混合检索为关键词（`to_tsvector('simple', search_tokens)`）+ 向量（`vector(1024)`、cosine）各取 30 条，再用 RRF（k=60）合并。维度 1024 写死在迁移和 `VECTOR_DIMENSION` 中，不一致时服务拒绝启动。`createResumeCache` 按文件修改时间缓存解析结果。
- `packages/backend`：Express 5 + `@earendil-works/pi-agent-core` / `pi-ai`（0.99.1，版本精确锁定）。
- `packages/frontend`：Vite + React 19 + antd 6 + `@ant-design/x`，访客聊天页与 `/admin` 站长后台（`components/admin/`）。

### 后端装配

`server.ts` 是唯一用 Postgres 实现装配依赖的地方，把它们注入 `createApp(config, deps)`（`app.ts`）。`AppDeps` 中的 `business`、`vector`、`protection`、`auth`、`ipBans`、`adminAccounts`、`adminDirectory`、`streamFn` 都是接口，各有内存实现供测试使用；`NODE_ENV=production` 时缺少共享存储会直接抛错。测试通过注入 fake `streamFn` 替代模型，`test/verified-app.ts` 包装出一个已通过邮箱验证的 app。

### 一轮聊天

`POST /api/chat` → 中间件依次检查 IP 黑名单、限流、邮箱登录、准入（`abuse-protection.ts` / `pg-abuse-protection.ts`：并发租约、每日额度、每 IP 15 分钟时段）→ `chat-turn.ts` 的 `streamChat` 每轮新建 Agent（`agent.ts`），把库里的 `AgentMessage` 历史作为初始消息 → 工具事件和正文增量写成 SSE（`sse.ts`）→ 结束时整轮写入 `messages`（`agent_message` 原样保存 + `ui_details` 供界面重画卡片）。停止、重试、重新生成、断线各有不同的落库规则，见 `chat-turn.ts`。`messages.format_version` 与 pi-agent-core 版本绑定，升级该依赖时要考虑旧会话兼容。

### 安全边界（改动 Agent / 工具时必须保持）

- `agent-security.ts`：每次请求重建唯一的系统提示（`prompt.ts`）和四个工具声明；档案和所有工具结果以 `untrustedData()` 包成 JSON 交给模型。`createToolPolicy` 在代码层限制：只允许四个工具；每轮最多 8 次模型请求；检索和详情各最多 2 次；`get_project_detail` 的 id 必须先出现在本会话成功的工具结果元数据里。
- `tools.ts`：typebox schema，拒绝额外字段。给模型的 `content` 和给界面的 `details` 分开，`details` 不进模型上下文。
- 前端 `AssistantMarkdown` / `assistant-links.ts`：不渲染远程图片和原始 HTML；只有与档案配置地址一致的链接才可点击。
- 错误文案必须经过 `sanitizeErrorMessage`（`transcript.ts`），去掉密钥和连接串。未处理的路由错误统一返回 JSON。

### 认证与站长

- 访客身份是 cookie `resume_visitor`；聊天还需要邮箱验证码登录（`email-auth.ts`，发信走 `code-mailer.ts` → `aliyun-mail.ts` 或 `console-mail.ts`）。公开接口不为每个没带 cookie 的请求新建访客行。
- 站长用 cookie `resume_admin_session`（手机号 + 密码，全库只能有一个账号），路由在 `admin-routes.ts`。账号只由 `pnpm admin:create` 按 `ADMIN_PHONE` / `ADMIN_PASSWORD` 创建或同步，网页没有注册入口。`/api/health` 和 `/api/admin` 不受 IP 封禁影响。

### 数据库迁移

`migrations/` 里是按时间戳命名的纯 SQL，由 node-pg-migrate 执行。新增改动应建新文件，不要改已有迁移。

## 部署

`docker-compose.prod.yml`（Postgres + 后端 + Nginx）配 `.env.production`，运行 `bash scripts/deploy.sh`，详见 `docs/deploy-aliyun.md`。克隆地址是 `git@github.com:inkwellio/resume-qa-agent.git`。生产构建时后端会托管 `packages/frontend/dist`。

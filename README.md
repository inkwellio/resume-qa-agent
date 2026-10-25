[𝕏 @hunter_jia228](https://x.com/hunter_jia228)

# 简历问答助手

访客打开网页，就能就这份简历提问。助手用工具查简历原文和混合检索，再用第三人称回答。

本仓库是**开源示例版**：内置虚构人物「林知夏」的演示数据。页面会标「示例数据」。换成你自己的简历时，把 `profile.json` 里的 `example` 设为 `false`。

## 功能

- 档案、技能、建议问题与自由提问
- 检索步骤、项目卡片、简历 PDF 下载、联系方式
- 邮箱验证码登录后才能聊天（本地可用开发开关把验证码打到终端）
- 站长后台：会话、访客、IP 黑名单
- 演示模式（`CHAT_MOCK=1`）无需模型密钥即可看界面

## 技术栈

pnpm monorepo · React 19 + Vite + antd · Express 5 · DeepSeek（pi-ai）· PostgreSQL 16 + pgvector · BAAI/bge-m3 embeddings

## 快速上手

```bash
# 需要 Node.js >= 22、pnpm 10、Docker（本地 Postgres）
pnpm install
cp .env.example .env
# 至少填 EMAIL_AUTH_SECRET（>=32 字符）；本地可保持 EMAIL_DEV_MAILER=1
# 真聊天再填 DEEPSEEK_API_KEY、EMBEDDING_API_KEY；只看界面可设 CHAT_MOCK=1
docker compose up -d
pnpm migrate
pnpm ingest
pnpm dev
```

浏览器打开前端地址（默认 `http://127.0.0.1:5174`）。聊天前先走邮箱验证；开发开关打开时，验证码在跑 `pnpm dev` 的终端里。

密钥只放在 `.env` / `.env.production`，不要提交。示例见 `.env.example`。

## 换成自己的简历

1. 编辑 `data/resume/profile.json` 与 `entries.json`（条目格式可参考 `data/resume/samples/project.example.md`）。
2. 把 PDF 放到 `data/public/`，并更新档案里的 `resumePdf` / `resumePdfFilename`。
3. 改 `packages/frontend/src/components/ChatPanel.tsx` 里的欢迎问题。
4. 把 `example` 设为 `false`，再执行 `pnpm ingest`。

**隐私**：电话、邮箱只写在 `contact`；不要把身份证号、住址、薪资期望放进检索条目。本仓库演示数据均为虚构，请勿当作真人履历。

## 部署

阿里云 ECS 一键部署见 [docs/deploy-aliyun.md](docs/deploy-aliyun.md)。

## 许可证

[MIT](LICENSE)。代码可商用、可修改；请保留版权与许可声明。演示人名、公司和示例 PDF 均为虚构占位，不构成任何品牌授权。

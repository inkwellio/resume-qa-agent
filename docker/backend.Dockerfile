# 后端镜像：多阶段构建。构建阶段装全部依赖并编译，运行阶段只留生产依赖和 dist。
# 如国内拉取 node 镜像慢，先按 docs/deploy-aliyun.md 配置 Docker 镜像加速。
FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN npm config set registry "$NPM_REGISTRY" && npm i -g pnpm@10.33.3 && pnpm config set registry "$NPM_REGISTRY"
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/backend/package.json packages/backend/
RUN pnpm install --frozen-lockfile --filter @resume/backend...
COPY packages/retrieval packages/retrieval
COPY packages/backend packages/backend
RUN pnpm --filter @resume/backend build \
 && pnpm --filter @resume/backend --prod deploy --legacy /out \
 && mkdir -p /out/packages/backend \
 && cp -r packages/backend/dist /out/packages/backend/dist

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787
WORKDIR /app
# repoRoot 由 dist 相对路径推出为 /app，因此保持 packages/backend/dist 的层级。
COPY --from=build /out/node_modules /app/packages/backend/node_modules
COPY --from=build /out/package.json /app/packages/backend/package.json
COPY --from=build /out/packages/backend/dist /app/packages/backend/dist
COPY migrations /app/migrations
COPY data /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/backend/dist/server.js"]

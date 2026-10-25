# 前端镜像：构建阶段用 Vite 打包，运行阶段由 Nginx 托管静态文件并反代 /api。
FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV CI=1
RUN npm config set registry "$NPM_REGISTRY" && npm i -g pnpm@10.33.3 && pnpm config set registry "$NPM_REGISTRY"
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/frontend/package.json packages/frontend/
RUN pnpm install --frozen-lockfile --filter @resume/frontend...
COPY packages/frontend packages/frontend
RUN pnpm --filter @resume/frontend build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
EXPOSE 80

#!/usr/bin/env bash
# 一键部署 / 升级 resume-agent（阿里云 ECS，Ubuntu 22.04）。
# 用法：在仓库根目录执行  bash scripts/deploy.sh
# 重复执行是幂等的：git pull 之后再跑一次即完成升级。
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=.env.production
COMPOSE_FILE=docker-compose.prod.yml

info() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# 1. Docker
install_docker() {
  info "未检测到 Docker，使用阿里云镜像源安装 docker-ce ..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu ${VERSION_CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker
}

if ! command -v docker >/dev/null 2>&1; then install_docker; fi
if ! docker compose version >/dev/null 2>&1 && ! $SUDO docker compose version >/dev/null 2>&1; then
  info "安装 docker compose 插件 ..."
  $SUDO apt-get install -y docker-compose-plugin
fi
if ! $SUDO docker info >/dev/null 2>&1; then
  $SUDO systemctl start docker 2>/dev/null || die "Docker 守护进程未运行，请检查 systemctl status docker"
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"

if ! $DOCKER info 2>/dev/null | grep -q "Registry Mirrors"; then
  warn "未配置 Docker 镜像加速，国内拉取镜像可能很慢甚至失败。"
  warn "到 阿里云控制台 → 容器镜像服务 ACR → 镜像工具 → 镜像加速器 复制你的专属地址，写入 /etc/docker/daemon.json："
  warn '  {"registry-mirrors": ["https://<你的ID>.mirror.aliyuncs.com"]}'
  warn "然后 sudo systemctl restart docker。香港地域可忽略。"
fi

# 2. 环境变量
if [ ! -f "$ENV_FILE" ]; then
  cp .env.production.example "$ENV_FILE"
  die "已生成 $ENV_FILE，请填写 DEEPSEEK_API_KEY 和 EMBEDDING_API_KEY 后重新执行。"
fi
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"'"'"' \r'; }
for key in DEEPSEEK_API_KEY EMBEDDING_API_KEY; do
  [ -n "$(get_env "$key")" ] || die "$ENV_FILE 里的 $key 为空，请先填写。"
done
if [ -z "$(get_env POSTGRES_PASSWORD)" ]; then
  pw="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if grep -qE '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${pw}/" "$ENV_FILE"
  else
    echo "POSTGRES_PASSWORD=${pw}" >> "$ENV_FILE"
  fi
  info "已自动生成数据库密码并写入 $ENV_FILE（首次部署后不要再改，否则需同步修改数据库）。"
fi
chmod 600 "$ENV_FILE"

compose() { $DOCKER compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# 3. 构建并启动
info "构建并启动容器（首次需要几分钟）..."
compose up -d --build --remove-orphans

# 4. 等待健康
info "等待服务健康 ..."
for i in $(seq 1 60); do
  unhealthy=0
  for svc in db backend web; do
    cid="$(compose ps -q "$svc")"
    status="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] || unhealthy=1
  done
  [ "$unhealthy" -eq 0 ] && break
  [ "$i" -eq 60 ] && { compose ps; compose logs --tail=80 backend; die "服务 5 分钟内未健康，请看上面的日志。"; }
  sleep 5
done
info "所有服务已健康。"

# 5. 入库（在一个事务里重建片段，可重复执行）
info "执行简历入库 ..."
compose exec -T backend node packages/backend/dist/ingest.js

# 6. 访问地址
port="$(get_env HTTP_PORT)"; port="${port:-80}"
suffix=""; [ "$port" = "80" ] || suffix=":$port"
ip="$(curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
   || curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null \
   || curl -fsS --max-time 5 -4 https://ifconfig.me 2>/dev/null || echo '<服务器公网IP>')"
info "部署完成 ✅"
info "  访问地址：http://${ip}${suffix}/"
info "  本机自检：curl http://127.0.0.1${suffix}/api/health"
info "  查看日志：docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f backend"

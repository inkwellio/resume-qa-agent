# 部署到阿里云 ECS（测试环境）

整套服务用 Docker Compose 跑在一台 ECS 上：

| 容器 | 作用 | 对外端口 |
| --- | --- | --- |
| `db` | Postgres 16 + pgvector，数据存在 `pgdata` 卷里 | 不对外 |
| `backend` | Express 后端，启动时自动执行幂等迁移 | 不对外 |
| `web` | Nginx：托管前端静态文件，把 `/api`、`/media`、`/resume` 反代到后端 | 80 |

Nginx 已为 SSE（`/api/chat`）关闭缓冲和 gzip，超时调到 600 秒，流式回答会逐字出现。

聊天已强制要求邮箱验证码登录。部署前请按 [邮箱验证码登录](../README.md#邮箱验证码登录) 配置阿里云杭州区域邮件推送、RAM AccessKey、触发类发信地址和 `EMAIL_AUTH_SECRET`；未配置时可浏览公开简历，不能聊天。生产环境保持 `EMAIL_DEV_MAILER=0`（或不设置）。该变量为 `1` 时只在后端日志打印验证码，不会调用邮件推送。上线时在 `.env.production` 关闭它，并填入已验证的 `ALIYUN_DM_ACCOUNT_NAME` 与 RAM AccessKey，不用改发码或校验代码。正式上线使用 HTTPS，并设 `COOKIE_SECURE=1`。站长后台见 [站长 Admin 后台](../README.md#站长-admin-后台)：迁移后打开 `/admin/setup` 用手机号和密码注册一次，之后从 `/admin/login` 进入。不再使用 `ADMIN_TOKEN`。

## 一、准备服务器

1. **买 ECS**：2 核 4G 起步即可（构建前端镜像时内存低于 2G 容易失败），系统盘 40G，镜像选 **Ubuntu 22.04 64 位**，带公网 IP。
2. **地域**：
   - 选**中国大陆**地域：用域名通过 80/443 访问前，域名必须先完成 **ICP 备案**；没备案时只能用公网 IP 访问测试。
   - 选**中国香港**地域：不需要备案，拉取 Docker 镜像也更快，测试环境推荐。
   - DeepSeek 和硅基流动在国内都能直连，不需要额外处理。
3. **安全组**：入方向只放行 **22**（SSH，最好限制为你的 IP）、**80**、**443**。**不要**放行 5432 和 8787。

## 二、用 Deploy Key 拉取私有仓库

在服务器上生成一个只读密钥：

```bash
ssh-keygen -t ed25519 -C "ecs-deploy" -f ~/.ssh/resume_agent_deploy -N ""
cat ~/.ssh/resume_agent_deploy.pub
```

把输出内容添加到 GitHub 仓库 → Settings → Deploy keys → Add deploy key（**不要**勾选 Allow write access）。然后：

```bash
cat >> ~/.ssh/config <<'CFG'
Host github.com
  IdentityFile ~/.ssh/resume_agent_deploy
  IdentitiesOnly yes
CFG
```

> 大陆地域访问 GitHub 偶尔不稳定，失败时重试或改用香港地域。

## 三、三步部署

```bash
# 1. 拉代码
git clone git@github.com:inkwellio/resume-agent.git && cd resume-agent

# 2. 填密钥
cp .env.production.example .env.production
nano .env.production        # 填 DEEPSEEK_API_KEY、EMBEDDING_API_KEY；POSTGRES_PASSWORD 留空会自动生成

# 3. 一键部署
bash scripts/deploy.sh
```

`deploy.sh` 会依次：

1. 没装 Docker 时，用**阿里云镜像源**安装 docker-ce 和 compose 插件；
2. 检查 `.env.production`，数据库密码为空时自动生成随机密码；
3. `docker compose up -d --build` 构建并启动；
4. 等 db、backend、web 全部健康；
5. 执行简历入库（输出「已为「林知夏」写入 N 条片段」，N 取决于 entries.json）；
6. 打印访问地址，浏览器打开 `http://<公网IP>/` 即可。

### Docker 镜像加速（大陆地域强烈建议）

大陆地域拉取 Docker Hub 镜像经常很慢或失败。到 **阿里云控制台 → 容器镜像服务 ACR → 镜像工具 → 镜像加速器** 复制你的专属地址，然后：

```bash
sudo mkdir -p /etc/docker
echo '{"registry-mirrors": ["https://<你的ID>.mirror.aliyuncs.com"]}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

构建时 npm 依赖默认走 `registry.npmmirror.com`，无需额外配置。

## 四、日常运维

以下命令都在仓库根目录执行，先定义一个别名省得每次打长命令：

```bash
alias dc='sudo docker compose -f docker-compose.prod.yml --env-file .env.production'
```

**更新版本**（重复执行 deploy.sh 是幂等的）：

```bash
git pull && bash scripts/deploy.sh
```

**查看状态和日志**：

```bash
dc ps
dc logs -f backend        # 后端
dc logs -f web            # Nginx 访问日志
curl http://127.0.0.1/api/health
```

**只重新入库**（改了 `data/resume` 之后需要重新构建镜像，直接跑 deploy.sh 即可）：

```bash
dc exec backend node packages/backend/dist/ingest.js
```

**备份数据库**：

```bash
mkdir -p backups
dc exec -T db pg_dump -U resume resume | gzip > backups/resume-$(date +%F).sql.gz
```

**恢复**：

```bash
gunzip -c backups/resume-2026-10-18.sql.gz | dc exec -T db psql -U resume resume
```

可以用 `crontab -e` 加一行每天凌晨备份（路径换成你的仓库目录）：

```
0 3 * * * cd /root/resume-agent && docker compose -f docker-compose.prod.yml --env-file .env.production exec -T db pg_dump -U resume resume | gzip > backups/resume-$(date +\%F).sql.gz
```

**停止 / 彻底删除**：

```bash
dc down          # 停止，数据保留
dc down -v       # 连数据库卷一起删除，慎用
```

## 五、可选：HTTPS

前提：域名已解析到 ECS 公网 IP，大陆地域已完成 ICP 备案。

最简单的做法是在宿主机上再装一个 Nginx 做 TLS 终止，把 Compose 的 web 改到本机端口：

1. `.env.production` 里设 `HTTP_PORT=8080`、`COOKIE_SECURE=1`，重新执行 `bash scripts/deploy.sh`。
2. 安装宿主机 Nginx 和 certbot：

   ```bash
   sudo apt-get install -y nginx certbot python3-certbot-nginx
   ```

3. 新建 `/etc/nginx/sites-available/resume`：

   ```nginx
   server {
       listen 80;
       server_name your.domain.com;
       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_buffering off;          # SSE 必需
           proxy_read_timeout 600s;
       }
   }
   ```

   ```bash
   sudo ln -s /etc/nginx/sites-available/resume /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. 申请证书：`sudo certbot --nginx -d your.domain.com`（会自动改配置并定时续期）。

**用阿里云免费证书**：在「数字证书管理服务」申请免费 DV 证书，下载 Nginx 格式，把 `.pem` 和 `.key` 放到 `/etc/nginx/ssl/`，在上面的 server 块里加 `listen 443 ssl;`、`ssl_certificate`、`ssl_certificate_key` 两行即可。

## 常见问题

- **deploy.sh 卡在拉取镜像**：配置上面的镜像加速，或改用香港地域。
- **页面能开但回答一次性吐出来**：中间多了一层没有关缓冲的代理（例如宿主机 Nginx 或 SLB），确保每一层都 `proxy_buffering off`。
- **回答报错**：`dc logs backend` 看是否是 DeepSeek / 硅基流动密钥错误或余额不足。
- **改了 POSTGRES_PASSWORD 后后端连不上库**：密码只在数据卷首次初始化时生效，改密码需进 db 容器 `ALTER USER`，或 `dc down -v` 后重建（会清空数据）。

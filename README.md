# CDK 后端兑换

Vite React + Express 本地代理的 CDK 后端兑换控制台。

## 功能

- 账号与 CDK 按行配对兑换
- IDEAL VIP / IDEAL、UPI VIP / UPI、PIX VIP / PIX 六个卡密池
- 状态查询、自动轮询、批量取消、批量重试
- 账号检测页：批量识别 Plus、非 Plus、Token 失效和封禁账号
- Plus 订阅与开通邮件双重验证
- 支付超时或放弃后自动换号，并支持失败账号二次兑换
- UPI / IDEAL / PIX 成功结果分池导出
- API Key 仅保存在浏览器本地

## 本地运行

需要 Node.js 22.12.0 或更高的 Node 22 版本。使用 nvm 时可直接运行 `nvm use`。

```bash
npm ci
npm run dev
```

复制 `.env.example` 为 `.env`，按运行方式填写所需配置。不要提交真实密钥。

## Job 模式本地验收

安装并启动 Docker Desktop 后，可从空环境启动 PostgreSQL、migration、API 和 Worker：

```bash
docker compose build
docker compose up -d
curl -f http://localhost:4174/health/live
curl -f http://localhost:4174/health/ready
```

本地 Compose 默认登录值是用户名 `admin`、密码 `local-admin-password`。Cookie 默认保持 `Secure`，通过 HTTPS 访问时可直接登录；仅在本机纯 HTTP 验收时显式设置 `AUTH_SECURE_COOKIES=false` 后重建 API 容器。这些默认账号、默认加密键和非 Secure Cookie 都不得用于公网或共享环境。停止服务使用 `docker compose down`；只有明确要删除全部本地数据库数据时才使用 `docker compose down -v`。

## 生产运行

生产使用 Node 22.22.0 镜像，`PROCESS_ROLE=api` 与 `PROCESS_ROLE=worker` 分进程运行。至少覆盖以下环境变量：

```text
DATABASE_URL
SECRET_ENCRYPTION_KEY
AUTH_ALLOWED_ORIGINS
AUTH_BOOTSTRAP_USERNAME
AUTH_BOOTSTRAP_PASSWORD
AUTH_SECURE_COOKIES=true
POSTGRES_PASSWORD
```

生成 32 字节 Secret 加密键：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

首次部署严格按 migration、API、Worker 顺序：

```bash
APP_IMAGE=ghcr.io/owner/cdk-redeem-console:sha docker compose up -d db
APP_IMAGE=ghcr.io/owner/cdk-redeem-console:sha docker compose run --rm migrate
APP_IMAGE=ghcr.io/owner/cdk-redeem-console:sha docker compose up -d --no-deps api
APP_IMAGE=ghcr.io/owner/cdk-redeem-console:sha docker compose up -d --no-deps worker
curl -f http://127.0.0.1:4174/health/ready
```

提交和拉取请求会在 GitHub Actions 中使用 Node 22 执行依赖审计、单元测试、构建、Playwright 浏览器测试和容器构建。`.github/workflows/deploy.yml` 只允许手动触发，并会在推送不可变 GHCR SHA 镜像前重复完整验证门。服务器部署目录必须提供生产 `.env`；工作流会拒绝本地默认密码、默认加密键、localhost Origin 或非 Secure Cookie。

## 健康检查、指标与日志

- `GET /health/live`：仅证明 Node 进程可响应。
- `GET /health/ready`：同时检查 PostgreSQL 和最近 Worker 心跳；Worker 停止或数据库不可用时返回 503。
- `GET /metrics`：Prometheus 文本格式的 HTTP、Job 和 Worker readiness 指标。
- 每个响应包含 `X-Request-Id`。服务日志为单行 JSON，包含 `requestId`、`jobId`、`itemId`、`attemptId`、`eventType`、`durationMs`、`statusCode`、`errorCode` 等可用字段。

日志不会记录完整密码、2FA、Cookie、Token、API Key 或邮箱；账号标识只记录不可逆摘要。健康检查只返回依赖是否可用，不返回连接串或配置值。

## 回滚

新镜像 readiness 在 60 秒内未通过时，部署工作流读取服务器 `.last-good-image` 并恢复上一 API/Worker 镜像。手动回滚命令：

```bash
APP_IMAGE=ghcr.io/owner/cdk-redeem-console:previous-sha docker compose up -d --no-deps api worker
curl -f http://127.0.0.1:4174/health/ready
```

数据库 migration 必须保持向后兼容。部署失败时不得自动运行 `npm run db:migrate:down`，也不得删除 PostgreSQL volume。

Express 在 `NODE_ENV=production` 时默认禁用服务器 Session 共享凭证模式，用户自带 API Key 的请求不受影响。本地开发默认保持兼容；只有受信任内网临时部署才应设置 `ALLOW_SESSION_CREDENTIAL_MODE=true`。

启用 Job 模式前必须先运行数据库迁移，并配置 `SECRET_ENCRYPTION_KEY`、首个管理员账号和允许的浏览器 Origin。浏览器登录使用 HttpOnly Cookie；CSRF Token 只保存在页面内存中。首个账号创建后，`AUTH_BOOTSTRAP_*` 不会覆盖现有用户。管理员全部失效时，在停机维护窗口设置 `AUTH_RECOVERY_USERNAME` 和 `AUTH_RECOVERY_PASSWORD` 后运行 `npm run auth:recover-admin`，完成后立即清除这两个环境变量。

邮箱验证必须通过 `MAILBOX_ALLOWED_HOSTS` 配置可信取件域名，多个域名使用逗号分隔，子域名可使用 `*.example.com`。Node production 和 Cloudflare Worker 在白名单为空时会拒绝邮箱抓取；每次重定向仍会重新校验域名，Node 还会拒绝解析到私网、回环、链路本地或保留地址的域名。

Cloudflare Worker 使用四个独立限流 Binding：`API_RATE_LIMITER`、`MUTATION_RATE_LIMITER`、`TURNSTILE_RATE_LIMITER` 和 `MAILBOX_RATE_LIMITER`。兑换修改和 Turnstile 校验在所需 Binding 缺失或故障时返回 503；只读查询可记录故障后有限放行。达到额度时统一返回 429 和 `Retry-After`。

Cloudflare Worker 不读取或选择共享上游业务凭证；边缘兑换代理只接受请求方显式提供的 Key。正式共享凭证兑换必须通过认证后的 Node Job API，由服务器将凭证加密为不可公开的 Secret 引用。

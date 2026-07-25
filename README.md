# CDK 后端兑换

Vite React + Express 本地代理的 CDK 后端兑换控制台。

## 功能

- 账号与 CDK 按行配对兑换
- VIP、IDEAL、UPI 三个卡密池
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

## 生产运行

```bash
npm ci
npm run build
HOST=0.0.0.0 PORT=5173 npm start
```

提交和拉取请求会在 GitHub Actions 中使用 Node 22 执行安装、测试和构建。

Express 在 `NODE_ENV=production` 时默认禁用服务器 Session 共享凭证模式，用户自带 API Key 的请求不受影响。本地开发默认保持兼容；只有受信任内网临时部署才应设置 `ALLOW_SESSION_CREDENTIAL_MODE=true`。

邮箱验证必须通过 `MAILBOX_ALLOWED_HOSTS` 配置可信取件域名，多个域名使用逗号分隔，子域名可使用 `*.example.com`。Node production 和 Cloudflare Worker 在白名单为空时会拒绝邮箱抓取；每次重定向仍会重新校验域名，Node 还会拒绝解析到私网、回环、链路本地或保留地址的域名。

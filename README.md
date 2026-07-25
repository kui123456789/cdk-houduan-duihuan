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

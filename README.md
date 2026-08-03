# CDK 后端兑换

Vite + React 前端、Express 本地代理和 Cloudflare Worker 组成的 CDK 兑换控制台。

## 功能

- 四个工作区：准备输入、账号检测、执行监控、结果导出。
- 八类卡密池：IDEAL VIP、UPI VIP、PIX VIP、KAKAO VIP、IDEAL、UPI、PIX、KAKAO。
- CDK 预检、批量提交、只读状态查询、5 秒轮询、取消、重试、换号和回账号池。
- 账号检测支持 Plus、非 Plus、Token 失效、账号不存在、接口失败和封禁邮件。
- AT 有取件地址时验证开通邮件；无取件地址时查询活跃 Plus。
- Session 提交前刷新 AT；成功后再次刷新，并按是否有取件地址执行订阅或双重验证。
- UPI、IDEAL、PIX、KAKAO 四个独立成功导出池，VIP 与对应标准渠道合并。

## 账号格式

主输入使用 `---` 分隔，取件地址和时间戳均可选：

```text
邮箱---密码---2fa---取件地址---session/at---时间戳
邮箱---密码---2fa---session/at
邮箱---取件地址---session/at---时间戳
邮箱---session/at
```

凭证中允许包含 `---`。可解析 AT 的邮箱必须与首段邮箱一致；其他凭证按 Session 处理。成功导出不包含 AT、Session、密码之外的隐藏诊断字段，并使用后端兑换成功时间。

## 本地运行

```bash
npm install
npm run dev
```

- 前端默认地址：`http://127.0.0.1:5173/`
- Express 默认地址：`http://127.0.0.1:4174/`
- `npm run server:cookie` 可在启动时交互式输入后台 `X-Session-Token`、Cookie 和 `X-Device-Id`。

Express 的 `/api/*` 仅接受回环 Host/Origin。本地后台登录凭证会先通过上游用户接口验证，之后只存在后端进程内存中；账号输入长期保存在本机浏览器的 `localStorage`，关闭浏览器或重启程序后仍会恢复；Session 原文、检测原文和 API Key 只保存在当前标签页的 `sessionStorage`。长期工作流快照会移除密码、2FA、AT、Session、取件地址和原始行。

## 构建与测试

```bash
npm run check
npm test
npm run build -- --configLoader runner
npx playwright install chromium
npm run test:e2e
npm audit --omit=dev
```

- `npm run check` 依次执行 ESLint 和渐进式 JavaScript 类型检查。
- Playwright 使用独立的 Vite 端口，并 mock 全部 `/api/**` 请求，不会触发真实兑换、取消或重试操作。
- GitHub Actions 在 push 和 pull request 上执行同一组静态检查、单测、构建和 Chromium E2E；失败时保存 Playwright report 与 trace。

Cloudflare Worker 额外使用 Turnstile、安全会话和限流保护写操作。部署命令为 `npm run cf:deploy`，执行前需配置 Worker secrets；本仓库不会把 Cookie、API Key、AT 或 Session 写入 Wrangler 配置。

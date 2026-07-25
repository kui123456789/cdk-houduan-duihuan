# Codex Upgrade Progress

## T00

- 状态：完成
- 提交：`chore(T00): establish CI and runtime baseline`
- 修改文件：`package.json`、`.nvmrc`、`.env.example`、`.github/workflows/ci.yml`、`README.md`
- 测试：Node 22 下 `npm ci`、`npm test` 通过
- 构建：Node 22 下 `npm run build` 通过
- 风险：本地默认 Node 仍为 v24；仓库和 CI 已固定 Node 22
- 回滚方式：删除新增配置并恢复 `package.json`、`README.md`

## T01

- 状态：完成
- 提交：`fix(T01): protect worker session credentials`
- 修改文件：`worker/index.js`、`test/cloudflareWorker.test.mjs`
- 测试：先确认新增授权测试失败；`node --test test/cloudflareWorker.test.mjs` 与 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：Worker 的 submit、cancel、retry 以及无用户 Key 的 Session status 均要求同源有效安全会话
- 回滚方式：回退本任务提交

## T02

- 状态：完成
- 提交：`fix(T02): disable unauthenticated express session mode`
- 修改文件：`server/app.js`、`server/proxy.js`、`server/index.js`、`test/serverProxy.test.mjs`、`.env.example`、`README.md`
- 测试：先确认 production 回归测试失败；test 与 production 环境的 `test/serverProxy.test.mjs` 及 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：production 默认关闭 Session 共享凭证；受信任内网可显式设置 `ALLOW_SESSION_CREDENTIAL_MODE=true`
- 回滚方式：回退本任务提交；仅允许在受信任内网临时恢复共享凭证

## T03

- 状态：完成
- 提交：`fix(T03): stop persisting sensitive browser data`
- 修改文件：`src/App.jsx`、`src/hooks/useAccountAuditChecks.js`、`src/storage/workflowPersistence.js`、`src/storage/localStorageCleanup.js`、相关测试
- 测试：先确认旧快照和本地键泄露测试失败；workflow、storage 与完整测试通过
- 构建：`npm run build` 通过
- 风险：刷新后必须重新导入账号凭证；CDK、任务状态、时间、错误码和 UI 设置继续恢复
- 回滚方式：回退本任务提交，但不得恢复已清除的敏感浏览器数据

## T04

- 状态：完成
- 提交：`fix(T04): harden mailbox verification boundaries`
- 修改文件：邮箱验证领域、Node/Worker 适配、运行配置、README 和相关测试
- 测试：先确认白名单、DNS、重定向、旧邮件和证据不足测试失败；目标测试及 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：production 必须配置 `MAILBOX_ALLOWED_HOSTS`；仅短语或旧订单返回 `needs_review`/`stale`
- 回滚方式：回退本任务提交或扩展可信域名白名单，不得关闭全部校验

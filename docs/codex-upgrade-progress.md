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

# Codex Upgrade Progress

## T00

- 状态：完成
- 提交：`chore(T00): establish CI and runtime baseline`
- 修改文件：`package.json`、`.nvmrc`、`.env.example`、`.github/workflows/ci.yml`、`README.md`
- 测试：Node 22 下 `npm ci`、`npm test` 通过
- 构建：Node 22 下 `npm run build` 通过
- 风险：本地默认 Node 仍为 v24；仓库和 CI 已固定 Node 22
- 回滚方式：删除新增配置并恢复 `package.json`、`README.md`

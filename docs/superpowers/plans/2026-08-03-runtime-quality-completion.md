# Runtime Quality Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐运行时轮询协调、静态检查、CI、浏览器 E2E，并从 App 中提取启动生命周期。

**Architecture:** 使用可注入依赖的 localStorage 租约控制跨标签页轮询；使用独立 React hook 管理一次性初始同步和卸载清理；质量工具通过 npm scripts 与 GitHub Actions 统一执行。

**Tech Stack:** React 18、Vite 8、Node 24、ESLint flat config、TypeScript checkJs、Playwright Test、GitHub Actions。

## Global Constraints

- 不调用真实提交、取消、重试或兑换接口。
- 保留当前未提交工作树，不回退无关改动。
- 所有行为修改先写失败测试，再写最小实现。
- 不对 `App.jsx` 做与启动生命周期无关的大规模重构。

---

### Task 1: Initial Lifecycle Hook

**Files:**
- Create: `src/hooks/useInitialRedeemLifecycle.js`
- Modify: `src/App.jsx`
- Test: `test/initialRedeemLifecycle.test.mjs`

**Interfaces:**
- Produces: `claimInitialStatusSync(ref): boolean`
- Produces: `useInitialRedeemLifecycle(options): void`

- [ ] 写失败测试，验证同一 ref 只有第一次 claim 返回 true。
- [ ] 运行 `node --test test/initialRedeemLifecycle.test.mjs`，确认失败原因是接口不存在。
- [ ] 实现一次性 claim 和 mount-only lifecycle hook。
- [ ] 用 hook 替换 App 内初始化查询/卸载清理 effect。
- [ ] 运行定向测试和完整单测。

### Task 2: Cross-Tab Polling Lease

**Files:**
- Create: `src/domain/pollingLease.js`
- Modify: `src/hooks/useRedeemPolling.js`
- Modify: `src/App.jsx`
- Test: `test/pollingLease.test.mjs`
- Test: `test/serializedPolling.test.mjs`

**Interfaces:**
- Produces: `createPollingLease(options)`，返回 `acquire()`、`release()`、`isOwner()`、`dispose()`。
- Consumes: `pollingLeaseRef` from App.

- [ ] 写失败测试覆盖竞争、续租、释放、过期接管和损坏 storage。
- [ ] 运行定向测试确认失败。
- [ ] 实现纯租约控制器。
- [ ] 在 `useRedeemPolling.startPolling` 前获取租约，在 stop/dispose 时释放。
- [ ] 增加轮询被其他标签页占用的受控状态提示。
- [ ] 运行租约、轮询和完整单测。

### Task 3: Static Quality Gates

**Files:**
- Create: `eslint.config.js`
- Create: `jsconfig.quality.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces npm scripts: `lint`, `typecheck`, `check`。

- [ ] 安装 `eslint`、`@eslint/js`、`eslint-plugin-react-hooks`、`globals`、`typescript`。
- [ ] 新增 flat ESLint 配置和渐进式 checkJs 配置。
- [ ] 运行 lint/typecheck，修复实际错误或收紧文件边界，不使用 blanket disable。
- [ ] 运行 `npm run check`。

### Task 4: Playwright E2E

**Files:**
- Create: `playwright.config.js`
- Create: `e2e/app-smoke.spec.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces npm script: `test:e2e`。

- [ ] 安装 `@playwright/test`。
- [ ] 配置固定端口 Vite webServer 和 Chromium 项目。
- [ ] 编写 API route mock 与首屏/工作区测试。
- [ ] 编写持久化任务初始化只查询一次的 E2E。
- [ ] 捕获并拒绝 React console error、重复 key 与 page error。
- [ ] 运行 Chromium E2E 并检查截图/trace 产物只在失败时生成。

### Task 5: Continuous Integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- CI commands: `npm ci`, `npm run check`, `npm test`, `npm run build -- --configLoader runner`, `npx playwright install --with-deps chromium`, `npm run test:e2e`。

- [ ] 新增 Node 24 GitHub Actions workflow，覆盖 push 与 pull_request。
- [ ] 失败时上传 Playwright report。
- [ ] README 记录本地质量命令和 CI 门禁。
- [ ] 检查 YAML、npm scripts 和文档一致。

### Task 6: Final Verification

**Files:**
- Verify all modified files.

- [ ] 运行 `npm run check`。
- [ ] 运行 `npm test`。
- [ ] 运行 `npm run build -- --configLoader runner`。
- [ ] 运行 `npm run test:e2e`。
- [ ] 运行 `npm audit --omit=dev` 与 `git diff --check`。
- [ ] 启动本地开发服务器并确认页面可访问且无控制台错误。

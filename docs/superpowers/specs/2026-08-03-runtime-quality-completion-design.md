# Runtime Quality Completion Design

## Goal

补齐当前项目已确认缺失的运行时协调、浏览器回归测试和持续集成门禁，同时小范围拆出 `App.jsx` 的启动生命周期，降低重复查询与后续竞态风险。

## Scope

1. React StrictMode 开发双挂载时，持久化任务只执行一次初始状态同步。
2. 同源多个标签页不能同时运行兑换状态轮询；拥有租约的标签页定期续约，停止轮询或关闭页面时释放。
3. 增加 ESLint、渐进式 JavaScript 类型检查、统一 `npm run check`。
4. 增加 Playwright Chromium E2E，覆盖首屏、工作区切换、无重复 React key 警告、持久化任务首次同步一次。
5. 增加 GitHub Actions，在 Node 24 上执行安装、静态检查、单测、构建和 E2E。
6. 将 App 初始化查询与卸载清理提取到独立 hook；不重写兑换状态机和账号解析器。

## Architecture

### Initial lifecycle hook

`src/hooks/useInitialRedeemLifecycle.js` 保存一次性同步 ref。effect 每次开发重放都注册清理，但只有第一次 setup 调用 `queryStatuses`。清理仍调用 `stopPolling`、自动兑换定时器清理和 toast 定时器清理。

### Cross-tab polling lease

`src/domain/pollingLease.js` 提供无 React 依赖的租约控制器。租约写入 `localStorage`，包含 owner id 和到期时间；获取后通过定时器续约。控制器使用注入的 storage、clock 和 timer，Node 单测不依赖浏览器。

`useRedeemPolling` 在真正启动序列化轮询前获取租约。其他标签页持有有效租约时，本标签页不启动轮询并显示受控提示；停止或失去租约时停止本地 controller。`beforeunload` 和 hook 卸载释放当前标签页租约。

### Quality gates

- ESLint 使用 flat config，区分浏览器源码、Node 服务/脚本/测试和 Worker 全局。
- TypeScript 使用 `allowJs + checkJs + noEmit` 对新增生命周期、租约及核心轮询模块建立渐进式检查基线，不强迫一次性迁移 3,600 行 App。
- Playwright 使用固定端口 Vite server，API 通过 route mock，禁止真实兑换副作用。
- CI 使用 `npm ci`，安装 Chromium 后执行 `npm run check` 与 `npm run test:e2e`。

## Failure Behavior

- 租约内容损坏或 storage 不可用时，仅当前标签页降级为本地轮询，不让 UI 永久卡死。
- 有效租约被其他标签页持有时不发送状态请求，提示用户轮询正在另一标签页运行。
- E2E 不调用真实 `/api/redeem/submit`、取消或重试接口。

## Acceptance Criteria

- StrictMode 下持久化任务初始化状态请求恰好一次。
- 两个租约控制器竞争时只有一个获得所有权；释放或过期后另一个可以获得。
- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build -- --configLoader runner`、`npm run test:e2e` 全部通过。
- GitHub Actions 文件覆盖上述门禁。
- `App.jsx` 不再直接包含初始化查询和卸载清理 effect。

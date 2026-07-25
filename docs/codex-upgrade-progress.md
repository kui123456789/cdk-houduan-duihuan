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

## T05

- 状态：完成
- 提交：`fix(T05): validate redeem request limits`
- 修改文件：`src/domain/redeemRequestValidation.js`、Express/Worker 入口及相关测试
- 测试：先确认 501 条会被拆批转发；纯验证器、两端入口与 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：请求限制为总条目 500、CDK 256、channel 64、access token 16384、API Key 4096
- 回滚方式：删除共享验证模块并回退两端入口修改

## T06

- 状态：完成
- 提交：`fix(T06): bound upstream response reads`
- 修改文件：`src/domain/boundedResponse.js`、Express/Worker 上游适配及相关测试
- 测试：先确认受限读取模块缺失；覆盖 UTF-8 分块、无长度流式超限、声明超限、Reader 取消、慢正文中止，两端目标测试及 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：邮箱、兑换、订阅响应体上限分别为 2 MB、5 MB、1 MB；总超时覆盖响应头和完整正文
- 回滚方式：回退共享读取模块和四条上游适配

## T07

- 状态：完成
- 提交：`fix(T07): fail safely on limiter outages`
- 修改文件：`worker/index.js`、`wrangler.jsonc`、`README.md`、`test/cloudflareWorker.test.mjs`
- 测试：先确认 Binding 缺失仍放行且邮箱/Turnstile 共用旧额度；覆盖缺失、抛错、429、503、只读受控放行和独立配额，目标测试及 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：兑换修改与 Turnstile 所需限流器故障时 fail closed；只读接口记录故障后可有限放行
- 回滚方式：回退 Worker 三态限流处理和四 Binding 配置

## T08

- 状态：完成
- 提交：`fix(T08): preserve unresolved status as sync pending`
- 修改文件：轮询、状态元数据、工作流模型、自动换号接入、状态展示及相关测试
- 测试：先确认连续 `not_found` 会变为 `unused`；覆盖缺失项、持续未找到、明确 unused、15 分钟人工复核和自动换号隔离，目标测试及 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：`sync_pending` 为非终态并持续占用 CDK；`manual_review` 为不可自动复用的终态
- 回滚方式：回退新状态映射；旧快照中的新状态需映射为 `unknown`

## T09

- 状态：完成
- 提交：`fix(T09): preserve partial batch results`
- 修改文件：Express/Worker 批处理、前端 API 与提交工作流、状态元数据及相关测试
- 测试：先确认第二批失败会丢弃首批结果；覆盖两端 207 部分响应、客户端接收、成功前缀合并和剩余行重提，目标测试及 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：仅保证单次顺序批处理内的部分结果，不宣称跨请求强幂等；`submit_failed` 不计尝试且不触发自动换号
- 回滚方式：回退部分响应契约和 `submit_failed` 状态

## T10

- 状态：完成
- 提交：`fix(T10): sanitize upstream responses`
- 修改文件：`src/domain/upstreamSanitization.js`、Express/Worker 代理与订阅、状态归一化及相关测试
- 测试：先确认 Token、Header、Session 和 stack 会进入响应/`rawStatus`；覆盖白名单 payload、文本遮蔽、统一错误和两端 HTTP 泄露，目标测试及 `npm test` 通过
- 构建：`npm run build` 通过
- 风险：未知上游字段不再透传；详情面板仅显示状态、原因、渠道、CDK、标记和安全时间字段
- 回滚方式：回退共享脱敏模块与各响应投影，不得恢复敏感详情透传

## T11

- 状态：完成
- 提交：`fix(T11): separate export download from cleanup`
- 修改文件：Node/Worker 下载响应、成功导出卡片、导出状态与精确清理逻辑及相关测试
- 测试：先确认 Express 中文文件名触发非法 Header 且导出清理缺少独立状态；目标测试及 `npm test`（298/298）通过
- 构建：`npm run build` 通过
- 风险：`export_generated` 快照仅保存在当前页面会话，避免把敏感导出内容写入浏览器持久存储；刷新后需重新下载才能确认清理
- 回滚方式：回退本任务提交；不得恢复下载或复制后自动删除任务的旧行为

## T12

- 状态：完成
- 提交：`refactor(T12): share redeem proxy core`
- 修改文件：共享兑换代理核心、Express/Worker 平台适配和两端 Contract Test
- 测试：先确认共享核心不存在；覆盖凭证、验证、拆批、上游映射、脱敏响应及两端成功/部分失败契约，目标测试及 `npm test`（301/301）通过
- 构建：`npm run build` 通过
- 风险：邮箱和订阅代理按任务边界未抽取；平台层仍各自负责超时控制和受限读取
- 回滚方式：回退本任务提交，恢复两端原兑换代理实现

## T13

- 状态：完成
- 提交：`refactor(T13): centralize workflow state updates`
- 修改文件：工作流事件/Reducer、工作流 Hook、提交/轮询/自动换号/订阅检查 Hook、`App.jsx` 及相关测试
- 测试：新增确定性事件序列和旧轮询代次隔离测试；T13 定向测试 `59/59`、`npm test`（304/304）通过
- 构建：`npm run build` 通过
- 风险：浏览器 reducer 现在是任务行唯一可写状态源；服务器 Job 状态真相源迁移仍由 T15-T18 完成
- 回滚方式：回退本任务提交；不要局部恢复 `rowsRef`/`setRows` 双写

## T14

- 状态：完成
- 提交：`perf(T14): paginate lists and unify accessible dialogs`
- 修改文件：请求/账号检测分页、`StatusRow` memo、统一 `AccessibleDialog`、Playwright 配置与 E2E 测试
- 测试：1000 行分页与焦点纯逻辑测试通过；`npm test`（309/309）、`npm run test:e2e`（2/2）通过
- 构建：`npm run build` 通过
- 浏览器：Chromium 桌面及 390px 视口验证每页仅 50 行；Tab 首尾循环、Escape 关闭和触发按钮焦点恢复通过
- 风险：分页大小固定为 50，批量选择仍作用于全部筛选结果而不是当前页，保持原行为
- 回滚方式：列表分页和统一对话框可按文件分别回退；同时移除 Playwright 脚本和依赖

## T15

- 状态：完成（真实 PostgreSQL 集成验证待最终环境门）
- 提交：`feat(T15): add persistent job data model`
- 修改文件：PostgreSQL up/down migration、数据库连接/迁移器、Job repository、环境变量和 repository 测试
- 测试：migration 重入/回滚、Job/Item/Attempt/Event、幂等唯一约束和敏感 JSON 拒绝通过；`npm test`（313/313）通过
- 构建：`npm run build` 通过
- 边界：本机 Docker Desktop/PostgreSQL 未运行，当前由 `pg-mem` 验证 PostgreSQL 语义；真实 `DATABASE_URL` 的 `npm run db:migrate` 留待最终集成门
- 风险：本阶段只建立数据模型，不接管旧 API；数据库只接受 CDK、渠道、不可逆指纹与 Secret 引用，不保存密码、2FA、原始 Token 或 API Key
- 回滚方式：运行 `npm run db:migrate:down` 后回退本任务提交；当前尚无生产数据接管

## T16

- 状态：完成（进程重启后的 Secret 恢复由 T19 接管）
- 提交：`feat(T16): add durable job API and leased worker`
- 修改文件：Job API、兑换服务、租约 Worker、仓储状态机、共享代理执行入口、启动注入、环境示例和相关测试
- 测试：覆盖 API 创建/查询/事件/取消/重试、Secret 引用隔离、`FOR UPDATE SKIP LOCKED`、JSONB Item 更新、服务端取消/重试、逐步 Worker 事件及失败处理；`npm test`、构建和 E2E 通过
- 边界：`JOB_MODE_ENABLED` 默认关闭，旧 `/api/redeem/*` 保持兼容；启用前需先迁移数据库
- 风险：T16 使用接口后的进程内 Secret Store，浏览器关闭不影响任务，但服务器进程重启后 Secret 不可恢复；正式持久 Secret 与认证在 T19 完成前不得启用生产 Job 模式
- 回滚方式：关闭 `JOB_MODE_ENABLED` 切回旧代理路径，保留 Job 历史表

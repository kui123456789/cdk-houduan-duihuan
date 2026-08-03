# 全项目审查报告（2026-08-01）

## 1. 结论

本次审查覆盖当前 `codex/security-hardening` 分支的完整磁盘工作树，包括相对 `HEAD` 的已跟踪差异和未跟踪实现文件。审查范围不是单一的 Session/AT 改动，而是账号导入、八类 CDK 池、兑换状态机、队列、订阅与邮件验证、导出、浏览器持久化、Express 本地代理、Cloudflare Worker、依赖、测试、文档及响应式界面。

- 未确认 P0（可直接造成不可逆批量损失或无需前提的完整凭证泄露）问题。
- 已修复本轮确认的 P1/P2 正确性与安全问题，并增加回归测试。
- 未进行大型状态架构重写；剩余结构性风险记录在第 9 节。
- 未部署、未提交、未推送，也未调用真实提交、取消、重试或兑换接口。

## 2. 审查边界与方法

### 已覆盖

- 账号文本和 Session JSON 导入、格式识别、邮箱及凭证去重、AT 邮箱归属校验。
- UPI、UPI VIP、iDEAL、iDEAL VIP、PIX、PIX VIP、KAKAO、KAKAO VIP 八类 CDK 池。
- CDK 预检、提交、状态查询、轮询、取消、重试、换号、批量回账号池、自动兑换。
- AT/Session 分流、Session 刷新、订阅检查、邮件 Plus/封禁识别、三次验证和成功导出。
- 刷新恢复、成功池去重、下载计数、任务所有权和 24 小时三次限制。
- Express 与 Worker 的路由、鉴权、限流、超时、请求/响应体限制、缓存和错误契约。
- Cookie、API Key、AT、Session、密码、2FA、取件地址在浏览器、进程、请求、日志和导出中的生命周期。
- SSRF、DNS/重定向、响应体资源消耗、文件名注入、跨站请求及 Turnstile。
- 当前文件、忽略文件、归档和 Git 历史的脱敏扫描。
- 桌面与 `390 x 844` 移动端的四个工作区、表格、弹窗、空态和长文本。

### 明确未执行

- 未调用有业务副作用的真实接口；提交、取消、重试和兑换分支使用测试替身。
- 未删除本地日志、压缩包或历史数据。
- 未把 Worker 改造成通用任意 URL 代理。
- 未全面拆分 `App.jsx` 或重写账号解析器。

## 3. 分级发现与修复

### P0

未确认 P0 问题。

### P1

| 编号 | 发现 | 风险 | 修复 | 回归证据 |
| --- | --- | --- | --- | --- |
| P1-01 | CDK 预检在查询失败或返回不完整时可能继续提交 | 无法确认的卡密可能被重复消费 | 预检改为失败关闭；只有明确可用的 CDK 才进入提交 | `test/cdkPreflight.test.mjs`、`test/redeemWorkflowSubmit.test.mjs` |
| P1-02 | 空响应、部分响应或无确认项可能被当作提交成功 | 错误消耗账号尝试次数并污染任务状态 | 响应保持 `unknown`，不增加尝试次数，保留重试资格，同时只读轮询状态 | `test/redeemApi.test.mjs`、`test/autoCycleRules.test.mjs`、`test/redeemWorkflowSubmit.test.mjs` |
| P1-03 | 历史 AT 归属逻辑可与当前账号验证结果混用 | 可能使用其他账号或旧凭证结果放行 | 删除历史 AT 归属授权路径；验证只接受当前行原始凭证或该 Session 本次刷新结果 | `test/credentialRouting.test.mjs`、`test/subscriptionChecks.test.mjs` |
| P1-04 | Worker 将上游原始错误载荷返回浏览器 | 上游细节、标识符或凭证片段可能泄露 | 对兑换、订阅和 Session 刷新错误统一输出受控字段，不返回原始载荷 | `test/cloudflareWorker.test.mjs` |
| P1-05 | Worker 限流绑定异常时默认放行 | 限流服务故障期间敏感接口失去保护 | 配置了绑定但调用失败时返回 `503`，所有限流器失败关闭 | `test/cloudflareWorker.test.mjs` |
| P1-06 | Worker JSON 请求体和多条上游响应缺少统一硬限制 | 可导致内存和 CPU 资源耗尽 | JSON 请求体限制为 2 MB；共享响应读取器将上游响应限制为 5 MB | `test/cloudflareWorker.test.mjs`、`test/serverProxy.test.mjs` |
| P1-07 | Express 邮件取件地址仅做字符串级 URL 判断 | DNS 重绑定、私网地址和重定向可能绕过 SSRF 约束 | 解析并解析 DNS、拒绝私网/保留地址、固定连接目标、逐跳检查重定向并限制响应大小 | `test/serverProxy.test.mjs`、`test/emailVerification.test.mjs` |
| P1-08 | API Key、账号原文和 Session 文本曾长期落入 `localStorage` | 浏览器长期留存密码、2FA、AT 和 Session | 迁移到当前标签页 `sessionStorage`；启动时删除遗留副本；长期快照清空敏感字段 | `test/sensitiveSessionStorage.test.mjs`、`test/workflowPersistence.test.mjs` |

### P2

| 编号 | 发现 | 风险 | 修复 | 回归证据 |
| --- | --- | --- | --- | --- |
| P2-01 | 多次队列/状态轮询可能重叠，旧响应覆盖新状态 | 排队位置和任务状态倒退 | 使用串行轮询和请求序号，只接受最新有效响应 | `test/serializedPolling.test.mjs`、`test/queueSummary.test.mjs` |
| P2-02 | 查询路径曾可能修改账号输入或业务状态 | 只读操作造成输入丢失或状态污染 | 查询与兑换命令分离，新增只读不变量测试 | `test/queryReadOnly.test.mjs` |
| P2-03 | Express `/api/*` 响应未统一禁止缓存 | 共享缓存或浏览器缓存可能保留敏感结果 | 回环 API 中间件统一设置 `Cache-Control: no-store` | `test/serverProxy.test.mjs` |
| P2-04 | Turnstile 网络异常可能冒泡为未控制错误 | 验证页显示不稳定且暴露实现错误 | 加入超时和受控 `403` 失败响应 | `test/cloudflareWorker.test.mjs` |
| P2-05 | 本地 Cookie 控制接口可能被非本地 Host/Origin 调用 | 本机进程 Cookie 被跨站写入或探测 | 所有 Express `/api/*` 限定回环 Host，存在 Origin 时也必须是回环来源 | `test/serverProxy.test.mjs` |
| P2-06 | 队列任务响应包含前端不需要的上游字段 | 扩大数据暴露面并增加契约漂移 | Express/Worker 共享任务队列白名单归一化 | `test/queueSummary.test.mjs`、`test/cloudflareWorker.test.mjs` |
| P2-07 | KAKAO/KAKAO VIP 成功结果未完整进入独立导出路径 | 已验证账号无法按渠道下载 | 增加 KAKAO 成功池、下载计数和导出卡片 | `test/exportFormatting.test.mjs`、`test/workflowPersistence.test.mjs` |
| P2-08 | Session 刷新、响应大小和队列归一化在两端存在重复且行为漂移 | 本地验证与线上 Worker 结果不一致 | 抽取共享 `sessionRefreshProxy.js`、`responseBody.js` 和 `taskQueuePayload.js` | 对应 Express/Worker/Session 测试 |
| P2-09 | React Strict Mode 首次清理会永久停用队列轮询器 | 队列概览一直显示“等待首次更新”，具体排位也不会刷新 | 增加可重启的串行轮询控制器；两个队列 Hook 每次 effect 启动新 runner，并在清理时仅销毁当前 runner | `test/serializedPolling.test.mjs`、Playwright 5 秒轮询实测 |

## 4. 业务不变量核对

| 不变量 | 当前结果 |
| --- | --- |
| 查询只读，不删除账号、CDK 或任务 | 已由独立查询路径与回归测试固定 |
| Session 提交前刷新失败不消耗 CDK | 失败账号跳过，未进入提交批次 |
| 未确认响应保持未知 | 空/部分响应为 `unknown`，不会推断成功 |
| 未确认提交不增加账号尝试次数 | 已修复自动兑换和普通提交合并路径 |
| 成功池刷新后不重复恢复 | 下载计数、归档状态和去重同时参与恢复 |
| AT/Session 不进入成功导出 | 导出使用账号业务字段和后端成功时间，不写入第 5 段凭证 |
| 有取件地址时封禁邮件优先 | Plus 与封禁同时命中时归为封禁，不放行 |
| 无取件地址时只依据当前 AT 的活跃 Plus | 不虚构邮件或封禁结论 |
| Session 有地址需要刷新、Plus、邮件三项通过 | 任一失败均留在待验证/失败状态 |
| AT 有地址跳过订阅检查 | 只验证本次开通邮件；无地址才查订阅 |
| 同一账号 24 小时最多提交三次 | 只在确认提交后记录尝试，查询不计数 |
| 任务所有权不由相同 CDK 文本自动继承 | 当前行必须有明确所有权或确认响应 |

## 5. 接口与鉴权矩阵

### Express 本地服务

所有 `/api/*` 路由要求回环 Host；请求带 `Origin` 时也必须为回环地址。响应统一 `Cache-Control: no-store`。Cookie 仅保存在 Node 进程内存中，进程退出即丢失。

| 方法 | 路径 | 访问与用途 |
| --- | --- | --- |
| GET/POST/DELETE | `/api/local/session-cookie` | 回环限定；查询只返回是否已配置，写入要求 JSON 且最大 16 KB，不回显 Cookie |
| GET | `/api/redeem/tasks/queue-summary` | 回环限定；只读队列概览，可使用进程 Cookie |
| GET | `/api/redeem/tasks` | 回环限定；使用进程 Cookie，缺失时使用用户或服务端 API Key |
| POST | `/api/redeem/submit` | 回环限定；显式用户 API Key，或 Session 模式的服务端默认凭证 |
| POST | `/api/redeem/status` | 回环限定；只读状态查询 |
| POST | `/api/redeem/cancel` | 回环限定；业务副作用操作 |
| POST | `/api/redeem/retry` | 回环限定；业务副作用操作 |
| POST | `/api/subscription/check` | 回环限定；使用当前 AT 查询订阅 |
| POST | `/api/subscription/session-refresh` | 回环限定；刷新 Session，必须返回非空 AT |
| POST | `/api/subscription/email-check` | 回环限定；受 SSRF、重定向和响应大小约束 |
| POST | `/api/download/text` | 回环限定；文件名净化，只返回文本附件 |

### Cloudflare Worker

所有 JSON 响应使用 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。全部 API 受基础 IP 限流；安全验证和邮件验证有额外验证限流；提交、取消、重试有额外变更限流。

| 方法 | 路径 | 访问与用途 |
| --- | --- | --- |
| GET | `/api/security/config` | 公开；仅返回 Turnstile site key |
| GET | `/api/security/status` | 公开；只返回 HttpOnly 安全会话是否有效及到期时间 |
| POST | `/api/security/verify` | Turnstile 验证；成功写入 `HttpOnly; Secure; SameSite=Strict` 会话 Cookie |
| GET | `/api/redeem/tasks/queue-summary` | 公开只读队列概览 |
| GET | `/api/redeem/tasks` | 需要用户 API Key 或有效安全会话 |
| POST | `/api/redeem/submit` | 需要有效安全会话；变更限流 |
| POST | `/api/redeem/status` | 用户 API Key 模式可直接查询；无 Key 的 Session 模式需要安全会话 |
| POST | `/api/redeem/cancel` | 需要有效安全会话；变更限流 |
| POST | `/api/redeem/retry` | 需要有效安全会话；变更限流 |
| POST | `/api/subscription/check` | 基础限流；只接收当前检查所需 AT |
| POST | `/api/subscription/session-refresh` | 需要有效安全会话 |
| POST | `/api/subscription/email-check` | 基础和验证限流；Worker 环境执行 URL 安全检查 |
| POST | `/api/download/text` | 本地生成文本响应；净化文件名，不持久化内容 |

## 6. 敏感数据生命周期

| 数据 | 浏览器 | 服务端/网络 | 日志与导出 |
| --- | --- | --- | --- |
| 外部 API Key | 密码框；仅当前标签页 `sessionStorage`；清理旧 `localStorage` | 请求时转发给指定兑换上游 | 活动日志不记录；不进入账号导出 |
| 本地 Cookie | 浏览器不持久化且接口不回显 | 仅 Express 进程内存；仅用于指定兑换站点请求 | 不写日志、响应、文档或导出 |
| AT | 随账号原文仅存当前标签页；长期快照字段置空 | 仅发送给订阅或兑换接口；按当前账号校验邮箱归属 | 不进入成功导出；错误响应不返回原始上游载荷 |
| Session | 随账号/Session 文本仅存当前标签页；长期快照字段置空 | 仅发送给 Session 刷新接口；轮换值更新当前账号 | 不进入成功导出；不写活动日志 |
| 密码/2FA | 账号原文仅存当前标签页；长期任务快照字段置空 | 不发送给兑换、订阅或邮箱代理 | 按既定账号交付格式可进入用户主动下载文件；应用无法控制下载后的文件生命周期 |
| 取件地址 | 账号原文仅存当前标签页；长期任务快照字段置空 | 有地址时发送给邮箱检查代理 | 可按既定导出格式进入下载文件；服务端日志不记录完整 URL |
| CDK | 可长期保存在浏览器以支持刷新恢复 | 仅发送到指定兑换接口 | 活动日志遮罩显示；不包含在账号成功导出中 |
| 成功账号导出 | 成功池可恢复并记录已下载计数 | 下载接口不持久化内容 | 明文文件由用户设备保存，需由用户自行保护和清理 |

## 7. 安全扫描与文件完整性

扫描只统计路径和数量，没有在报告或终端输出匹配值。

| 范围 | 已扫描 | 敏感匹配 |
| --- | ---: | ---: |
| 当前已跟踪/未跟踪文本文件 | 145 | 0 |
| Git 忽略的文本及日志文件 | 228 | 0 |
| 本地归档文件 | 5 | 0 |
| Git 历史提交 | 126 | 0 |

以下未跟踪文件属于当前实现的必要组成部分，已有正式导入、测试或 `package.json` 脚本入口。后续提交时不能遗漏：

```text
docs/api-task-queue-response.md
scripts/run-tests.mjs
scripts/start-local-with-cookie.mjs
src/components/execute/QueueSummaryPanel.jsx
src/components/prep/LocalCookieCard.jsx
src/domain/responseBody.js
src/domain/serializedPolling.js
src/domain/sessionCredentials.js
src/domain/sessionRefreshProxy.js
src/domain/taskQueuePayload.js
src/hooks/useQueueSummary.js
src/hooks/useTaskQueuePositions.js
src/storage/sensitiveSessionStorage.js
test/queryReadOnly.test.mjs
test/queueSummary.test.mjs
test/sensitiveSessionStorage.test.mjs
test/sessionCredentials.test.mjs
```

本报告自身是新增审计文件，也将在生成后显示为未跟踪文件。

## 8. 验证结果

### 自动化

- `npm test`：343/343 通过。
- Node 测试覆盖率：行 81.84%，分支 66.37%，函数 87.44%。行覆盖率高于审查前基线 78.73%。
- 生产构建：`npm run build -- --configLoader runner` 通过。
- `git diff --check`：通过；仅出现 Git 的 LF/CRLF 工作树提示，没有空白错误。
- `npm audit`：0 个已知漏洞（info/low/moderate/high/critical 均为 0）。

### 界面

在 `http://127.0.0.1:5173/` 前端和 `http://127.0.0.1:4174/` 本地后端完成 Playwright 检查：

- 桌面和 `390 x 844` 移动端均检查四个工作区。
- 页面无横向溢出；执行表格只在 `.table-scroll` 内滚动。
- 队列面板、八类卡密池、错误/空状态和长文本没有相互遮挡。
- API Key 默认保持密码遮罩。
- 浏览器控制台没有业务错误或警告。

## 9. 剩余风险与延后工作

### 仍需业务或平台配合

1. **取件页证据可信度**：取件地址是用户提供的公开页面。当前实现可以分析内容和阻止 SSRF，但无法证明页面内容由可信邮件提供商生成。彻底避免伪造需要固定可信提供商、服务端历史邮件 API 或签名证据契约。
2. **Worker DNS 固定能力**：Cloudflare Worker 无法像 Node Express 一样将校验过的 DNS 地址固定到实际 socket。Worker 已拒绝字面私网地址、限制重定向和响应大小，但其 DNS 重绑定防护弱于本地 Express；高可信邮件检查应优先由受控后端执行。
3. **第三方接口契约**：队列、兑换和 Session 刷新依赖外部服务。未知或部分响应现在会失败关闭，但上游字段变化仍可能使任务保持 `unknown`，需要通过只读查询确认而不能推断成功。
4. **下载文件保护**：成功导出包含业务要求的账号交付字段。浏览器下载完成后不再受应用控制，应限制文件权限并及时清理。

### 延后架构工作

1. `src/App.jsx` 仍约 3,500 行，同时承担状态编排、持久化、自动兑换和 UI 连接。建议按“命令层、任务状态、验证状态、持久化、视图适配”逐步拆分，每一步先固定状态机测试。
2. `src/domain/accountParsing.js` 支持多种兼容格式和包含分隔符的凭证，分支密度高。建议将格式候选解析改为显式语法表/判别器，并保留现有测试向量作为兼容契约。
3. Express 与 Worker 仍有路由编排层重复。已共享无平台依赖的 Session 刷新、响应读取和队列归一化；剩余部分涉及 Node DNS/socket 与 Worker binding，不能直接合并，应通过共享契约测试约束。
4. 当前必要实现文件尚未加入 Git 跟踪。提交前必须按第 7 节清单核对，避免构建在其他机器上缺文件。

## 10. 发布门槛

本轮不部署。未来部署前至少需要：

1. 重新运行完整测试、覆盖率、`npm audit`、生产构建和 `git diff --check`。
2. 确认第 7 节全部必要文件已经进入提交。
3. 在预览 Worker 上验证 Turnstile、三类限流 binding 和安全会话环境变量均已配置；缺失时不得开放变更接口。
4. 使用纯测试账号完成一次端到端验证，不使用待售账号或真实 CDK。
5. 再次执行敏感信息扫描，确认提交、构建产物和部署配置中没有 Cookie、API Key、AT、Session、密码或 2FA。

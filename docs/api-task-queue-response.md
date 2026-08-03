# 兑换任务排队接口文档

本文档说明兑换任务列表接口的请求方式、分页结构和实时排位字段，示例中的账号、CDK 和 Token 均为脱敏占位符。

## 接口地址

```http
GET https://chong.nerver.cc/api/redeem/tasks?page=1&page_size=20
```

项目通过本地代理访问时，路径保持不变：

```http
GET /api/redeem/tasks?page=1&page_size=100
```

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `page` | integer | 否 | 页码，从 `1` 开始，默认 `1` |
| `page_size` | integer | 否 | 每页数量，默认 `100`；建议使用 `100` |

建议请求头：

```http
Accept: application/json
```

如果服务端要求鉴权，在请求头中传递已经配置的外部 API Key：

```http
X-External-Api-Key: <YOUR_API_KEY>
```

不要把 API Key 放进 URL、日志、截图或公开文档中。

## 成功响应

```json
{
  "code": 0,
  "message": "Success",
  "data": {
    "list": [
      {
        "id": "task-id-placeholder",
        "cdk": "CDK-XXXX-XXXX",
        "status": "pending_dispatch",
        "display_status": "Waiting for BR recharge",
        "source": "api",
        "updated_at": "2026-07-31T12:44:14.000Z",
        "already_submitted": true,
        "requires_access_token": true,
        "has_access_token": true,
        "queue_ahead_count": 938,
        "is_vip": false,
        "job_type": "br_redeem",
        "token_tail": "<redacted>",
        "payment_method": "KAKAO"
      }
    ],
    "pagination": {
      "page": 1,
      "page_size": 20,
      "total": 1401
    }
  }
}
```

## 字段说明

### 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | integer | `0` 表示接口业务成功 |
| `message` | string | 服务端消息 |
| `data.list` | array | 当前页任务列表 |
| `data.pagination` | object | 分页信息 |

### 任务字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 任务唯一 ID |
| `cdk` | string | 卡密，前端用它匹配本地任务 |
| `status` | string | 机器可读状态，例如 `pending_dispatch`、`success`、`failed` |
| `display_status` | string | 面向用户的状态文本 |
| `source` | string | 任务来源 |
| `updated_at` | string | 最近更新时间，通常为 ISO 8601 时间 |
| `already_submitted` | boolean | 是否已经提交过 |
| `requires_access_token` | boolean | 是否要求 access token |
| `has_access_token` | boolean | 服务端是否持有 access token |
| `queue_ahead_count` | integer | 当前任务前面等待的任务数 |
| `is_vip` | boolean | 是否 VIP 任务 |
| `job_type` | string | 任务类型，例如 `br_redeem` |
| `token_tail` | string | Token 尾部提示；对外分享时应脱敏 |
| `payment_method` | string | 支付渠道，例如 `KAKAO`、`IDEAL`、`UPI`、`PIX` |

## 实时排位计算

`queue_ahead_count` 是“前方还有多少个任务”，不是从 `1` 开始的绝对排位。

```text
真实排位 = queue_ahead_count + 1
```

例如：

```text
queue_ahead_count = 938
真实排位 = 第 939 位
```

当 `queue_ahead_count = 0` 时，表示当前任务位于队列最前方，排位为第 `1` 位。

该字段对等待中的任务最有意义，例如 `pending_dispatch`。已成功或已失败的历史任务可能返回 `0`，客户端不应将它解释为仍在等待队列。

## 分页处理

当 `pagination.total` 大于当前 `page_size` 时，需要继续请求后续页：

```text
总页数 = ceil(total / page_size)
```

客户端应根据 `cdk` 匹配自己的任务，而不能只使用列表下标。列表顺序可能随着任务状态变化而改变。

## 队列总数接口

如果只需要各渠道的总排队数量，可使用：

```http
GET https://chong.nerver.cc/api/redeem/tasks/queue-summary
```

它返回的是渠道汇总，不包含每个 CDK 的个人排位：

```json
{
  "code": 0,
  "message": "Success",
  "data": {
    "vip_queue_count": 0,
    "normal_queue_count": 1100,
    "upi_queue_count": 0,
    "ideal_queue_count": 0,
    "pix_queue_count": 0,
    "kakao_queue_count": 1100
  }
}
```

## 刷新建议

- 使用 5 秒左右的轮询间隔即可满足页面实时显示。
- 每次刷新同时请求任务列表和队列汇总，并以最新响应覆盖旧数据。
- 请求成功但 `data.list` 为空时，只能显示汇总数量，不能推导某个 CDK 的真实排位。
- 如果某个 CDK 不在返回列表中，不要把它的本地顺序当成后端真实排位。

## 错误响应

服务端可能返回非零 `code`，本地代理也可能返回以下错误格式：

```json
{
  "ok": false,
  "error": "兑换任务列表请求失败",
  "message": "兑换任务列表请求失败"
}
```

客户端应保留上一次成功数据，并在界面标记本次刷新失败；不要把失败响应解释为排队数量为零。

## 安全注意事项

- 不要分享 `X-External-Api-Key`、Cookie、access token 或完整 `token_tail`。
- 对外示例只保留字段结构和脱敏值。
- 日志中建议只记录任务 ID、渠道、状态和排位，不记录完整 CDK 或 Token。

# CDK 后端兑换

Vite React + Express 本地代理的 CDK 后端兑换控制台。

## 功能

- 账号与 CDK 按行配对兑换
- VIP、IDEAL、UPI 三个卡密池
- 状态查询、自动轮询、批量取消、批量重试
- Plus 订阅检查
- UPI / IDEAL 成功结果分池导出
- API Key 仅保存在浏览器本地

## 本地运行

```bash
npm install
npm run dev
```

## 生产运行

```bash
npm install
npm run build
HOST=0.0.0.0 PORT=5173 npm start
```

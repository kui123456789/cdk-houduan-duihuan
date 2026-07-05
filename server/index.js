import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "127.0.0.1";

const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`CDK redeem proxy listening on http://${HOST}:${PORT}`);
});

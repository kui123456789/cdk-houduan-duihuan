import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "127.0.0.1";
const config = { nodeEnv: process.env.NODE_ENV };
if (process.env.ALLOW_SESSION_CREDENTIAL_MODE !== undefined) {
  config.allowSessionCredentialMode = ["1", "true", "yes"].includes(
    String(process.env.ALLOW_SESSION_CREDENTIAL_MODE).trim().toLowerCase()
  );
}

const app = createApp({ config });

app.listen(PORT, HOST, () => {
  console.log(`CDK redeem proxy listening on http://${HOST}:${PORT}`);
});

import { createApp } from "./app.js";
import { createDatabase } from "./db/index.js";
import { executeRedeemRequest } from "./proxy.js";
import { createJobRepository } from "./repositories/jobRepository.js";
import { createProcessSecretStore, createRedeemService } from "./services/redeemService.js";
import { createRedeemWorker } from "./workers/redeemWorker.js";

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "127.0.0.1";
const config = { nodeEnv: process.env.NODE_ENV };
if (process.env.ALLOW_SESSION_CREDENTIAL_MODE !== undefined) {
  config.allowSessionCredentialMode = ["1", "true", "yes"].includes(
    String(process.env.ALLOW_SESSION_CREDENTIAL_MODE).trim().toLowerCase()
  );
}

const jobModeEnabled = ["1", "true", "yes"].includes(
  String(process.env.JOB_MODE_ENABLED || "").trim().toLowerCase()
);
let database = null;
let worker = null;
let jobService = null;
if (jobModeEnabled) {
  database = createDatabase();
  const repository = createJobRepository(database);
  jobService = createRedeemService({
    repository,
    secretStore: createProcessSecretStore(),
    executeRedeem: (request) => executeRedeemRequest({ ...request, config }),
    sessionDefaultApiKey: process.env.SESSION_REDEEM_API_KEY || "",
    allowSessionCredentialMode: config.allowSessionCredentialMode ?? config.nodeEnv !== "production"
  });
  worker = createRedeemWorker({ repository, processItem: (context) => jobService.processItem(context) });
  worker.start();
}

const app = createApp({ config, jobService });

app.listen(PORT, HOST, () => {
  console.log(`CDK redeem proxy listening on http://${HOST}:${PORT}`);
});

async function shutdown() {
  await worker?.stop();
  await database?.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

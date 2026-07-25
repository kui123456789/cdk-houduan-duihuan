import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createDatabase } from "../server/db/index.js";
import { runMigrations } from "../server/db/migrate.js";
import { createJobRepository } from "../server/repositories/jobRepository.js";
import { createAccountLimitService } from "../server/services/accountLimitService.js";
import { createRedeemService } from "../server/services/redeemService.js";
import { createSecretService } from "../server/services/secretService.js";

const connectionString = String(process.env.TEST_DATABASE_URL || "").trim();

test("real PostgreSQL serializes idempotency, leases, and active CDKs", {
  skip: !connectionString
}, async () => {
  const admin = createDatabase({ connectionString, allowExitOnIdle: true });
  const databaseName = `cdk_it_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(connectionString);
  testUrl.pathname = `/${databaseName}`;
  const database = createDatabase({ connectionString: testUrl.toString(), maxConnections: 12 });

  try {
    await runMigrations(database);
    const repository = createJobRepository(database);
    const accountLimitService = createAccountLimitService(database);
    const service = createRedeemService({
      repository,
      accountLimitService,
      secretStore: createSecretService({ database, encryptionKey: Buffer.alloc(32, 7) }),
      hashKey: "postgres-integration-hash-key",
      executeRedeem: async () => ({ status: 200, body: { items: [] } })
    });
    const input = {
      apiKey: "integration-user-key",
      items: [{
        cdkey: "IDEMPOTENT-CDK",
        access_token: "integration-access-token",
        email: "integration@example.com",
        channel: "upi"
      }]
    };

    const [first, second] = await Promise.all([
      service.createJob(input, { idempotencyKey: "integration-idempotency" }),
      service.createJob(input, { idempotencyKey: "integration-idempotency" })
    ]);
    assert.equal(first.id, second.id);

    const claims = await Promise.all([
      repository.claimNextJob({ workerId: "worker-a" }),
      repository.claimNextJob({ workerId: "worker-b" })
    ]);
    assert.equal(claims.filter(Boolean).length, 1);

    const createActive = (suffix) => repository.createJob({
      source: "integration",
      credentialMode: "secret_ref",
      requestHash: `request-${suffix}`,
      items: [{
        cdkey: `ACTIVE-CDK-${suffix}`,
        cdkeyHash: "shared-active-cdk-hash",
        channel: "upi",
        accountHash: `account-${suffix}`,
        tokenHash: `token-${suffix}`,
        secretRef: `db-secret://00000000-0000-4000-8000-00000000000${suffix}`
      }]
    }, {
      accountLimitService,
      createInitialAttempts: true
    });
    const activeResults = await Promise.allSettled([createActive("1"), createActive("2")]);
    assert.equal(activeResults.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = activeResults.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "ACTIVE_CDK_EXISTS");
  } finally {
    await database.end();
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [databaseName]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

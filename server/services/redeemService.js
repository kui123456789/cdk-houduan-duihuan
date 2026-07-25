import { createHmac, randomUUID } from "node:crypto";
import { validateRedeemRequest } from "../../src/domain/redeemRequestValidation.js";
import { sanitizePublicError } from "../../src/domain/upstreamSanitization.js";
import { resolveCredential } from "../../src/backend/redeemProxyCore.js";
import { getAccessTokenEmail } from "../../src/domain/accountParsing.js";

function fingerprint(value, key) {
  return createHmac("sha256", key).update(String(value || "")).digest("hex");
}

function publicItem(item) {
  const { accountHash, tokenHash, secretRef, ...safe } = item || {};
  return safe;
}

function publicJob(job) {
  if (!job) return null;
  const { requestHash, leaseOwner, ...safe } = job;
  return { ...safe, items: Array.isArray(job.items) ? job.items.map(publicItem) : undefined };
}

export function createProcessSecretStore() {
  const secrets = new Map();
  return {
    async put(value) {
      const reference = `process-secret://${randomUUID()}`;
      secrets.set(reference, structuredClone(value));
      return reference;
    },
    async get(reference) {
      const value = secrets.get(reference);
      return value ? structuredClone(value) : null;
    },
    async delete(reference) {
      return secrets.delete(reference);
    }
  };
}

export function createRedeemService({
  repository,
  accountLimitService = null,
  secretStore,
  executeRedeem,
  hashKey = process.env.JOB_HASH_KEY || "development-job-hash-key",
  sessionDefaultApiKey = process.env.SESSION_REDEEM_API_KEY || "",
  allowSessionCredentialMode = true
} = {}) {
  if (!repository) throw new TypeError("repository is required");
  if (!secretStore?.put || !secretStore?.get) throw new TypeError("secretStore is required");
  if (typeof executeRedeem !== "function") throw new TypeError("executeRedeem is required");

  return {
    async createJob(input = {}, context = {}) {
      validateRedeemRequest("/api/redeem/submit", input);
      const idempotencyKey = String(context.idempotencyKey || "").trim();
      if (accountLimitService && !idempotencyKey) {
        const error = new Error("Idempotency-Key is required");
        error.code = "IDEMPOTENCY_KEY_REQUIRED";
        error.status = 400;
        throw error;
      }
      const credential = resolveCredential({
        apiKey: input.apiKey,
        credentialMode: input.credentialMode,
        sessionDefaultApiKey,
        allowSessionCredentialMode
      });
      const normalizedItems = input.items.map((item) => {
        const cdkey = String(item.cdkey || "").trim();
        const accessToken = String(item.access_token || "").trim();
        const channel = String(item.channel || item.pool || item.queue || "").trim();
        const email = String(item.email || getAccessTokenEmail(accessToken) || "").trim().toLowerCase();
        return {
          cdkey,
          accessToken,
          channel,
          cdkeyHash: fingerprint(cdkey, hashKey),
          accountHash: fingerprint(email || `token:${accessToken}`, hashKey),
          tokenHash: fingerprint(accessToken, hashKey)
        };
      });
      const requestHash = fingerprint(
        JSON.stringify({
          credentialHash: fingerprint(credential, hashKey),
          items: normalizedItems.map(({ cdkeyHash, channel, accountHash, tokenHash }) => ({
            cdkeyHash, channel, accountHash, tokenHash
          }))
        }),
        hashKey
      );
      const keyHash = idempotencyKey ? fingerprint(idempotencyKey, hashKey) : "";
      if (keyHash && repository.getJobByIdempotencyKey) {
        const existing = await repository.getJobByIdempotencyKey({ keyHash });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            const error = new Error("Idempotency key was used for another request");
            error.code = "IDEMPOTENCY_CONFLICT";
            error.status = 409;
            throw error;
          }
          return publicJob(existing.job);
        }
      }

      const createdRefs = [];
      try {
        const items = [];
        for (const item of normalizedItems) {
          const { cdkey, accessToken, channel, cdkeyHash, accountHash, tokenHash } = item;
          const secretRef = await secretStore.put({ cdkey, accessToken, credential });
          createdRefs.push(secretRef);
          items.push({
            cdkey,
            cdkeyHash,
            channel,
            accountHash,
            tokenHash,
            secretRef
          });
        }
        const job = await repository.createJob({
          source: "api",
          credentialMode: "secret_ref",
          requestHash,
          metadata: { itemCount: items.length },
          items
        }, {
          accountLimitService,
          createInitialAttempts: Boolean(accountLimitService),
          idempotency: keyHash ? { keyHash, requestHash } : null
        });
        if (job.idempotentReplay) {
          await Promise.allSettled(createdRefs.map((reference) => secretStore.delete?.(reference)));
        }
        return publicJob(job);
      } catch (error) {
        await Promise.allSettled(createdRefs.map((reference) => secretStore.delete?.(reference)));
        if (error?.code === "IDEMPOTENCY_RACE" && keyHash) {
          const existing = await repository.getJobByIdempotencyKey({ keyHash });
          if (existing?.requestHash === requestHash) return publicJob(existing.job);
          if (existing) {
            error.code = "IDEMPOTENCY_CONFLICT";
            error.status = 409;
          }
        }
        throw error;
      }
    },

    async getJob(jobId) {
      return publicJob(await repository.getJob(jobId));
    },

    async listEvents(jobId, options) {
      if (!(await repository.getJob(jobId))) return null;
      return repository.listEvents(jobId, options);
    },

    async cancelJob(jobId) {
      return publicJob(await repository.requestCancel(jobId));
    },

    async retryJob(jobId) {
      return publicJob(await repository.retryJob(jobId, { accountLimitService }));
    },

    async processItem({ item }) {
      const secret = await secretStore.get(item.secretRef);
      if (!secret) {
        const error = new Error("Job secret is unavailable");
        error.code = "JOB_SECRET_UNAVAILABLE";
        throw error;
      }
      const response = await executeRedeem({
        pathname: "/api/redeem/submit",
        body: {
          apiKey: secret.credential,
          items: [{ cdkey: secret.cdkey, access_token: secret.accessToken, channel: item.channel }]
        }
      });
      if (response.status >= 400 || response.body?.ok === false) {
        const reasonText = JSON.stringify(response.body || {});
        await accountLimitService?.recordFailure(item.accountHash, {
          dailyLimit: /daily|24\s*(hours?|小时)|次数已达上限/i.test(reasonText),
          reason: "redeem_failed"
        });
        const error = new Error(response.body?.message || "Redeem request failed");
        error.code = response.body?.code || "REDEEM_REQUEST_FAILED";
        error.public = sanitizePublicError(error);
        throw error;
      }
      return { status: "succeeded", result: response.body?.items?.[0] || {} };
    }
  };
}

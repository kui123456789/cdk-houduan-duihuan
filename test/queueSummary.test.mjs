import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQueueSummary } from "../src/hooks/useQueueSummary.js";
import {
  createTaskQueueTargetKey,
  getTaskQueuePageCount,
  normalizeTaskQueueCdkey,
  normalizeTaskQueuePositions
} from "../src/hooks/useTaskQueuePositions.js";

test("normalizeTaskQueueCdkey uses the same key for backend and table lookups", () => {
  assert.equal(normalizeTaskQueueCdkey(" XkQt- uC7C-JHQS-SGMY "), "xkqt-uc7c-jhqs-sgmy");
});

test("task queue target keys stay stable across order and duplicate changes", () => {
  assert.equal(
    createTaskQueueTargetKey([" CDK-B ", "cdk-a", "CDK-B"]),
    createTaskQueueTargetKey(["CDK-A", "cdk-b"])
  );
});

test("normalizeQueueSummary reads the queue endpoint data shape", () => {
  assert.deepEqual(
    normalizeQueueSummary({
      code: 0,
      data: {
        vip_queue_count: 54,
        normal_queue_count: 730,
        upi_queue_count: 0,
        ideal_queue_count: 0,
        pix_queue_count: 0,
        kakao_queue_count: 784
      }
    }),
    { vip: 54, normal: 730, ideal: 0, upi: 0, pix: 0, kakao: 784 }
  );
});

test("normalizeQueueSummary clamps malformed values to zero", () => {
  assert.deepEqual(
    normalizeQueueSummary({ data: { vip_queue_count: "bad", kakao_queue_count: -4 } }),
    { vip: 0, normal: 0, ideal: 0, upi: 0, pix: 0, kakao: 0 }
  );
});

test("normalizeTaskQueuePositions matches CDKs and derives paged positions", () => {
  assert.deepEqual(
    normalizeTaskQueuePositions(
      [
        {
          data: {
            list: [{ cdkey: "A" }, { cdkey: "B", queue_position: 9 }],
            pagination: { page: 1, page_size: 2 }
          }
        },
        {
          data: {
            list: [{ cdkey: "C" }],
            pagination: { page: 2, page_size: 2 }
          }
        }
      ],
      ["B", "C", "missing"]
    ),
    { B: 9, C: 3 }
  );
});

test("normalizeTaskQueuePositions accepts the backend cdk aliases", () => {
  assert.deepEqual(
    normalizeTaskQueuePositions(
      [{ data: { list: [{ cdk: "CDK-1" }, { cdk_code: "CDK-2" }] } }],
      ["CDK-1", "CDK-2"]
    ),
    { "CDK-1": 1, "CDK-2": 2 }
  );
});

test("normalizeTaskQueuePositions uses backend queue_ahead_count as the live position", () => {
  assert.deepEqual(
    normalizeTaskQueuePositions(
      [{
        data: {
          list: [
            { cdk: "CDK-1", queue_ahead_count: 938 },
            { cdk: "CDK-2", queue_ahead_count: 0 }
          ],
          pagination: { page: 1, page_size: 20, total: 2 }
        }
      }],
      ["CDK-1", "CDK-2"]
    ),
    { "CDK-1": 939, "CDK-2": 1 }
  );
});

test("getTaskQueuePageCount uses the server page size", () => {
  assert.equal(
    getTaskQueuePageCount({ data: { pagination: { total: 1401, page_size: 20 } } }, 100),
    71
  );
});

test("normalizeTaskQueuePositions matches CDKs case-insensitively and ignores whitespace", () => {
  assert.deepEqual(
    normalizeTaskQueuePositions(
      [{ data: { list: [{ cdk: " xkqt- u c7c- jhqs-sgmy ", queue_ahead_count: 12 }] } }],
      ["XKQT-UC7C-JHQS-SGMY"]
    ),
    { "XKQT-UC7C-JHQS-SGMY": 13 }
  );
});

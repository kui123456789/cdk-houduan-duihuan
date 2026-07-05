import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WORKSPACE_TAB } from "../src/config/redeemConstants.js";
import { normalizeUiSettings } from "../src/hooks/useRedeemUiSettings.js";
import { buildRedeemViewModel } from "../src/hooks/useRedeemViewModel.js";

describe("buildRedeemViewModel", () => {
  it("derives account and task counts from facts and rows", () => {
    const model = buildRedeemViewModel({
      rows: [
        { status: "pending_dispatch", email: "a@example.com", cdkey: "A" },
        { status: "running", email: "b@example.com", cdkey: "B" }
      ],
      accountFacts: {
        counts: {
          pool: 10,
          available: 8,
          cooling: 1,
          attemptLimited: 1,
          activeTask: 2,
          completedPlus: 0
        }
      },
      cdkeyFacts: { total: 5, usedCount: 0, unusedCount: 5 }
    });

    assert.equal(model.account.pool, 10);
    assert.equal(model.account.available, 8);
    assert.equal(model.tasks.waiting, 1);
    assert.equal(model.tasks.running, 1);
  });

  it("keeps execute status card labels stable", () => {
    const model = buildRedeemViewModel({
      accountFacts: { counts: { pool: 10, available: 8, cooling: 1 } },
      cdkeyFacts: { total: 5, usedCount: 0, unusedCount: 5 },
      statusCounts: { total: 2, pending_dispatch: 1, running: 1 },
      groupedStatusCounts: { waiting: 1, dispatched: 0, running: 1, failed: 0 }
    });
    const labels = model.executeStatusCards.map((card) => card.label);

    ["可用账号", "冷却账号", "待兑换", "兑换中", "未使用"].forEach((label) => {
      assert.ok(labels.includes(label), `expected execute status cards to include ${label}`);
    });
  });

  it("uses request status grouping fallback for queued dispatching and pm unavailable rows", () => {
    const model = buildRedeemViewModel({
      rows: [
        { status: "queued", email: "a@example.com", cdkey: "A" },
        { status: "dispatching", email: "b@example.com", cdkey: "B" },
        { status: "pm_unavailable", email: "c@example.com", cdkey: "C" },
        { email: "missing-status@example.com", cdkey: "D" }
      ],
      accountFacts: { counts: { pool: 3, available: 1 } },
      cdkeyFacts: { total: 3, usedCount: 0, unusedCount: 3 }
    });
    const cardValues = Object.fromEntries(
      model.executeStatusCards.map((card) => [card.label, card.value])
    );

    assert.equal(model.tasks.waiting, 1);
    assert.equal(model.tasks.dispatched, 1);
    assert.equal(model.tasks.failed, 1);
    assert.equal(model.tasks.total, 4);
    assert.equal(cardValues["总任务"], 4);
    assert.equal(cardValues["等待合计"], 1);
    assert.equal(cardValues["已派发"], 1);
    assert.equal(cardValues["失败"], 1);
  });

  it("keeps skipped card scoped to current task rows instead of input errors", () => {
    const model = buildRedeemViewModel({
      rows: [],
      accountFacts: { counts: { pool: 19, available: 15 } },
      cdkeyFacts: { total: 14, usedCount: 5, unusedCount: 9 },
      counts: {
        taskIssueCount: 21
      }
    });
    const cards = Object.fromEntries(model.executeStatusCards.map((card) => [card.label, card.value]));

    assert.equal(cards["总任务"], 0);
    assert.equal(cards["跳过"], 0);

    const skippedModel = buildRedeemViewModel({
      rows: [{ status: "skipped", email: "skip@example.com", cdkey: "SKIP-CDK" }],
      accountFacts: { counts: { pool: 19, available: 15 } },
      cdkeyFacts: { total: 14, usedCount: 5, unusedCount: 9 }
    });
    const skippedCards = Object.fromEntries(
      skippedModel.executeStatusCards.map((card) => [card.label, card.value])
    );

    assert.equal(skippedCards["总任务"], 1);
    assert.equal(skippedCards["跳过"], 1);
  });
});

describe("normalizeUiSettings", () => {
  it("normalizes tabs detail ids and boolean settings", () => {
    assert.deepEqual(
      normalizeUiSettings({
        activeWorkspaceTab: "not-a-tab",
        activeDetailRowId: 123,
        pollingEnabled: 1,
        showApiKey: "true"
      }),
      {
        activeWorkspaceTab: DEFAULT_WORKSPACE_TAB,
        activeDetailRowId: "123",
        pollingEnabled: false,
        showApiKey: false
      }
    );

    assert.deepEqual(
      normalizeUiSettings({
        activeWorkspaceTab: "execute",
        activeDetailRowId: "row-1",
        pollingEnabled: true,
        showApiKey: true
      }),
      {
        activeWorkspaceTab: "execute",
        activeDetailRowId: "row-1",
        pollingEnabled: true,
        showApiKey: true
      }
    );
  });
});

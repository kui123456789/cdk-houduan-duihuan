import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCdkPoolChoices,
  chooseSubmitPoolDecision,
  restrictCdkeyPoolsToPool
} from "../src/state/cdkPoolSelection.js";

test("buildCdkPoolChoices returns only pools with valid CDKs", () => {
  const choices = buildCdkPoolChoices({
    vip: "VIP-1\nVIP-2",
    ideal: "",
    upi: "UPI-1"
  });

  assert.deepEqual(
    choices.map((choice) => ({ id: choice.id, count: choice.count })),
    [
      { id: "vip", count: 2 },
      { id: "upi", count: 1 }
    ]
  );
});

test("chooseSubmitPoolDecision returns direct for one non-empty pool", () => {
  const decision = chooseSubmitPoolDecision({
    vip: "",
    ideal: "IDEAL-1",
    upi: ""
  });

  assert.equal(decision.kind, "direct");
  assert.equal(decision.poolId, "ideal");
  assert.deepEqual(
    decision.choices.map((choice) => choice.id),
    ["ideal"]
  );
});

test("chooseSubmitPoolDecision returns prompt for multiple non-empty pools", () => {
  const decision = chooseSubmitPoolDecision({
    vip: "VIP-1",
    ideal: "",
    upi: "UPI-1"
  });

  assert.equal(decision.kind, "prompt");
  assert.deepEqual(
    decision.choices.map((choice) => choice.id),
    ["vip", "upi"]
  );
});

test("chooseSubmitPoolDecision returns empty for no non-empty pools", () => {
  const decision = chooseSubmitPoolDecision({
    vip: "",
    ideal: "",
    upi: ""
  });

  assert.equal(decision.kind, "empty");
  assert.deepEqual(decision.choices, []);
});

test("restrictCdkeyPoolsToPool keeps only selected pool text and clears others", () => {
  const restricted = restrictCdkeyPoolsToPool(
    {
      vip: "VIP-1\nVIP-2",
      ideal: "IDEAL-1",
      upi: "UPI-1"
    },
    "upi"
  );

  assert.deepEqual(restricted, {
    vip: "",
    ideal: "",
    upi: "UPI-1"
  });
});

test("chooseSubmitPoolDecision can exclude a finished pool", () => {
  const decision = chooseSubmitPoolDecision(
    {
      vip: "VIP-1",
      ideal: "IDEAL-1",
      upi: "UPI-1"
    },
    { excludePoolId: "vip" }
  );

  assert.equal(decision.kind, "prompt");
  assert.deepEqual(
    decision.choices.map((choice) => choice.id),
    ["ideal", "upi"]
  );
});

test("chooseSubmitPoolDecision returns direct when excluding leaves one remaining pool", () => {
  const decision = chooseSubmitPoolDecision(
    {
      vip: "VIP-1",
      ideal: "IDEAL-1",
      upi: ""
    },
    { excludePoolId: "vip" }
  );

  assert.equal(decision.kind, "direct");
  assert.equal(decision.poolId, "ideal");
  assert.deepEqual(
    decision.choices.map((choice) => choice.id),
    ["ideal"]
  );
});

test("chooseSubmitPoolDecision excludes multiple attempted pools", () => {
  const decision = chooseSubmitPoolDecision(
    {
      vip: "VIP-1",
      ideal: "IDEAL-1",
      upi: "UPI-1"
    },
    { excludePoolIds: ["vip", "ideal"] }
  );

  assert.equal(decision.kind, "direct");
  assert.equal(decision.poolId, "upi");
  assert.deepEqual(
    decision.choices.map((choice) => choice.id),
    ["upi"]
  );
});

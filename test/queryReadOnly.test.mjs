import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync("src/App.jsx", "utf8");

test("query and subscription checks never auto-delete account inputs", () => {
  assert.match(appSource, /await queryStatuses\(activeCdkeys/);
  assert.doesNotMatch(appSource, /plusAccountRowKey/);
  assert.doesNotMatch(
    appSource,
    /deletePlusAccounts\(plusAccountRows,\s*\{\s*auto:\s*true,\s*keepRows:\s*true\s*\}\)/
  );
});

test("Plus account removal remains an explicit user action", () => {
  assert.match(appSource, /onDeletePlus=\{\(\) => deletePlusAccounts\(plusAccountRows\)\}/);
});

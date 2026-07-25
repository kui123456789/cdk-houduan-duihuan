import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { removeExportLines } from "../src/domain/exportFormatting.js";

const exportCardSource = fs.readFileSync("src/components/export/ResultExportCard.jsx", "utf8");
const appSource = fs.readFileSync("src/App.jsx", "utf8");

test("download generation keeps exported rows until explicit cleanup", () => {
  assert.match(appSource, /status:\s*"export_generated"/);
  assert.match(exportCardSource, /确认已保存并清理/);
  assert.match(appSource, /此操作不可撤销/);
  assert.doesNotMatch(
    appSource.match(/function downloadSuccessOutput[\s\S]*?\n  }/)?.[0] || "",
    /markSuccessOutputProcessed/
  );
});

test("confirmed cleanup removes only lines included in the generated export", () => {
  assert.deepEqual(
    removeExportLines(
      ["old@example.com", "new@example.com", "old@example.com"],
      "old@example.com\nmissing@example.com"
    ),
    ["new@example.com"]
  );
});

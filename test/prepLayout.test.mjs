import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const prepCss = fs.readFileSync("src/styles/prep.css", "utf8");
const responsiveCss = fs.readFileSync("src/styles/activity-log.css", "utf8");
const prepWorkspace = fs.readFileSync("src/components/prep/PrepWorkspace.jsx", "utf8");

test("prep workspace keeps account and session inputs balanced", () => {
  assert.match(
    prepCss,
    /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    "account and session cards should use equal columns"
  );
  assert.match(
    prepWorkspace,
    /className="session-action-grid"/,
    "session actions should be grouped in a compact layout container"
  );
  assert.match(
    prepCss,
    /\.session-action-grid\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
    "session actions should use two compact columns"
  );
});

test("CDK grid pairs VIP channels above their standard channels", () => {
  const orderMatch = prepWorkspace.match(
    /const CDK_POOL_GRID_ORDER = (\[[\s\S]*?\]);/
  );

  assert.ok(orderMatch, "prep workspace should define an explicit visual pool order");
  assert.deepEqual(JSON.parse(orderMatch[1]), [
    "vip",
    "upi_vip",
    "pix_vip",
    "ideal",
    "upi",
    "pix"
  ]);
  assert.match(
    prepWorkspace,
    /getCdkPoolsForGrid\(cdk\.poolDefinitions\)\.map/,
    "the pool grid should render the visual order instead of mutating submission priority"
  );
});

test("session heading wraps before its availability badge can overlap actions", () => {
  assert.match(
    prepCss,
    /\.session-input-panel \.section-heading\s*{[^}]*flex-wrap:\s*wrap/s,
    "the Session heading should wrap when the card cannot fit both regions"
  );
  assert.match(
    prepCss,
    /\.session-input-panel \.panel-header\s*{[^}]*flex:\s*1\s+1\s+260px[^}]*min-width:\s*0/s,
    "the Session title region should shrink without forcing the actions to overlap"
  );
  assert.match(
    prepCss,
    /\.session-input-panel \.panel-actions\s*{[^}]*flex:\s*1\s+1\s+300px[^}]*min-width:\s*0[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)/s,
    "the availability badge and action grid should keep independent shrink-safe columns"
  );
});

test("mobile Session heading resets desktop flex bases", () => {
  assert.match(
    responsiveCss,
    /@media \(max-width:\s*560px\)[\s\S]*\.session-input-panel \.panel-header,\s*\.session-input-panel \.panel-actions\s*{[^}]*flex:\s*0\s+1\s+auto[^}]*width:\s*100%/s,
    "column headings should not turn desktop flex bases into excess vertical height"
  );
});

test("prep summary explains the Session default credential", () => {
  assert.match(
    prepWorkspace,
    /summary\.sessionLineCount\s*>\s*0[\s\S]*Session 可使用服务器默认凭证/,
    "empty user API key should explain that Session redemption can use the server credential"
  );
});

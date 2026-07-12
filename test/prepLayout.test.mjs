import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const prepCss = fs.readFileSync("src/styles/prep.css", "utf8");
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

test("prep summary explains the Session default credential", () => {
  assert.match(
    prepWorkspace,
    /summary\.sessionLineCount\s*>\s*0[\s\S]*Session 可使用服务器默认凭证/,
    "empty user API key should explain that Session redemption can use the server credential"
  );
});

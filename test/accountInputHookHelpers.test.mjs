import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountInputNotice,
  mergeAccountInputErrors,
  shouldAppendAccountImport
} from "../src/hooks/useAccountInput.js";

test("shouldAppendAccountImport appends non-empty imported account text", () => {
  assert.equal(shouldAppendAccountImport("a@example.com---p---2fa---at---t"), true);
  assert.equal(shouldAppendAccountImport(""), false);
  assert.equal(shouldAppendAccountImport(" \n\t "), false);
});

test("createAccountInputNotice reports rejected and duplicate rows", () => {
  const notice = createAccountInputNotice({
    added: 3,
    duplicate: 2,
    invalid: 1
  });
  assert.equal(notice, "已添加 3 个账号，跳过重复 2 个，格式错误 1 行");
});

test("mergeAccountInputErrors preserves non-account errors and replaces account errors", () => {
  const existingErrors = [
    { type: "account_format", line: 1 },
    { type: "cdk_duplicate", line: 2 },
    { type: "account_duplicate", line: 3 },
    { type: "preflight", reason: "卡密状态查询失败" }
  ];
  const accountErrors = [{ type: "account_format", line: 4 }];

  assert.deepEqual(mergeAccountInputErrors(existingErrors, accountErrors), [
    { type: "cdk_duplicate", line: 2 },
    { type: "preflight", reason: "卡密状态查询失败" },
    { type: "account_format", line: 4 }
  ]);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountFileUploadNotice,
  createAccountInputNotice,
  mergeAccountInputErrors,
  shouldAppendAccountImport,
  useAccountInput
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

test("createAccountFileUploadNotice identifies rejected file lines without source content", () => {
  const notice = createAccountFileUploadNotice({
    added: 71,
    duplicate: 0,
    invalid: 1,
    errors: [{
      type: "account_format",
      lineNumber: 42,
      reason: "第 4 段必须是邮箱取件码地址",
      source: "private@example.com---secret-password---secret-token"
    }]
  });

  assert.equal(
    notice,
    "上传账号已处理：新增 71 行，拒绝格式错误 1 行，文件第 42 行：第 4 段必须是邮箱取件码地址"
  );
  assert.doesNotMatch(notice, /private@example\.com|secret-password|secret-token/);
});

test("createAccountFileUploadNotice stays empty for a clean file", () => {
  assert.equal(createAccountFileUploadNotice({ added: 61, duplicate: 0, invalid: 0 }), "");
});

test("account file upload reports only errors from the imported file", async () => {
  const notices = [];
  const statuses = [];
  const accountText = "existing-invalid-line";
  const input = useAccountInput({
    accountText,
    accountTextRef: { current: accountText },
    setAccountText: () => {},
    setAccountNotice: (notice) => notices.push(notice),
    setErrors: (updater) => updater([]),
    setStatusMessage: (status) => statuses.push(status),
    readAccountTextFile: async () => "clean@example.com---eyJ.header.payload"
  });

  await input.handleAccountFileUpload({
    target: { files: [{ name: "clean.txt" }], value: "clean.txt" }
  });

  assert.equal(notices.at(-1), "");
  assert.equal(statuses.at(-1), "已追加账号文件：clean.txt，新增 1 行");
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

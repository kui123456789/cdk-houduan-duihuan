import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const testDir = path.resolve(process.cwd(), "test");
const entries = await readdir(testDir, { withFileTypes: true });
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => path.join(testDir, entry.name))
  .sort();

if (!testFiles.length) {
  throw new Error(`没有在 ${testDir} 找到测试文件`);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: process.cwd(),
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(error.message || "无法启动测试");
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
});

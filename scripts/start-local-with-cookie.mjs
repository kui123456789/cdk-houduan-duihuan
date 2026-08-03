import { spawn } from "node:child_process";
import process from "node:process";

function readSecret(prompt) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write(prompt);

  return new Promise((resolve, reject) => {
    let value = "";
    const previousRawMode = stdin.isRaw;

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.pause();
      if (stdin.isTTY) stdin.setRawMode(previousRawMode || false);
      stdout.write("\n");
    };

    const onData = (chunk) => {
      const input = String(chunk);
      if (input.includes("\u0003")) {
        cleanup();
        reject(new Error("已取消"));
        return;
      }
      const newlineIndex = input.search(/[\r\n]/);
      if (newlineIndex >= 0) {
        value += input.slice(0, newlineIndex);
        cleanup();
        resolve(value.trim());
        return;
      }
      value += input;
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

try {
  const sessionToken = await readSecret("粘贴 X-Session-Token 后按回车（可留空）： ");
  const cookie = await readSecret("粘贴本机登录 Cookie 后按回车（可留空）： ");
  const deviceId = await readSecret("粘贴 X-Device-Id 后按回车（可留空）： ");
  if (!sessionToken && !cookie) throw new Error("Session Token 和 Cookie 至少填写一项");

  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SESSION_REDEEM_COOKIE: cookie,
      SESSION_REDEEM_SESSION_TOKEN: sessionToken,
      SESSION_REDEEM_DEVICE_ID: deviceId
    },
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    process.exit(typeof code === "number" ? code : signal ? 1 : 0);
  });
} catch (error) {
  console.error(error.message || "启动失败");
  process.exit(1);
}

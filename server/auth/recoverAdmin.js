import { createDatabase } from "../db/index.js";
import { createSessionService } from "./session.js";

async function main() {
  const database = createDatabase({ allowExitOnIdle: true });
  try {
    const authService = createSessionService({ database });
    const user = await authService.recoverAdmin({
      username: process.env.AUTH_RECOVERY_USERNAME,
      password: process.env.AUTH_RECOVERY_PASSWORD
    });
    console.log(`Recovered administrator: ${user.username}`);
  } finally {
    await database.end();
  }
}

main().catch((error) => {
  console.error(`Administrator recovery failed: ${error.message}`);
  process.exitCode = 1;
});

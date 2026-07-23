# Hong Kong Server Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely update the existing CDK redeem console at `https://cdk.334401.xyz` to Git commit `9e2fd16` and retain a tested rollback archive.

**Architecture:** Deploy in place inside `/opt/cdk-redeem-console/source` because Caddy and systemd already target that directory. Back up the current source first, synchronize to the exact remote commit, validate dependencies/tests/build before restart, then verify both local and public HTTP paths.

**Tech Stack:** Debian 12, OpenSSH, Git, Node.js 22, npm, Vite, Express, systemd, Caddy.

## Global Constraints

- Deploy only through SSH alias `hk`.
- Target exactly `origin/main` commit `9e2fd1640e543ae1e3d3dca68dde5cc891559b69`.
- Do not change Caddy, domain names, ports, SSH configuration, or unrelated services.
- Store the rollback archive under `/opt/cdk-redeem-console/releases`.
- Do not restart the service unless dependency installation, tests, and production build all succeed.
- Roll back immediately if systemd, local HTTP, or public HTTPS verification fails.

---

### Task 1: Capture State and Create Rollback Archive

**Files:**
- Read: `/etc/systemd/system/cdk-redeem-console.service`
- Read: `/opt/cdk-redeem-console/source`
- Create: a timestamped `pre-9e2fd16-*.tgz` archive under `/opt/cdk-redeem-console/releases`

**Interfaces:**
- Consumes: SSH alias `hk` and the currently running application directory.
- Produces: A timestamped archive path used by Task 3 rollback.

- [ ] **Step 1: Record the current service and repository state**

Run:

```powershell
ssh hk 'systemctl is-active cdk-redeem-console.service; cd /opt/cdk-redeem-console/source; git rev-parse HEAD; git status -sb'
```

Expected: service reports `active`; repository reports HEAD `85deefa...` and a dirty working tree representing the current deployed files.

- [ ] **Step 2: Create a rollback archive without generated dependencies**

Run:

```powershell
ssh hk 'set -e; stamp=$(date +%Y%m%d-%H%M%S); archive=/opt/cdk-redeem-console/releases/pre-9e2fd16-$stamp.tgz; tar --exclude=.git --exclude=node_modules --exclude=dist -czf "$archive" -C /opt/cdk-redeem-console/source .; test -s "$archive"; echo "$archive"'
```

Expected: prints one non-empty archive path beginning with `/opt/cdk-redeem-console/releases/pre-9e2fd16-`.

### Task 2: Synchronize, Test, and Build the Target Commit

**Files:**
- Modify: `/opt/cdk-redeem-console/source` to match Git commit `9e2fd16`
- Generate: `/opt/cdk-redeem-console/source/node_modules`
- Generate: `/opt/cdk-redeem-console/source/dist`

**Interfaces:**
- Consumes: target commit `9e2fd1640e543ae1e3d3dca68dde5cc891559b69`.
- Produces: a clean, tested, production-built application tree ready for restart.

- [ ] **Step 1: Fetch and verify the exact target commit**

Run:

```powershell
ssh hk 'set -e; cd /opt/cdk-redeem-console/source; git fetch origin main; test "$(git rev-parse origin/main)" = "9e2fd1640e543ae1e3d3dca68dde5cc891559b69"; echo TARGET_OK'
```

Expected: `TARGET_OK`.

- [ ] **Step 2: Synchronize the working tree to the target**

Run:

```powershell
ssh hk 'set -e; cd /opt/cdk-redeem-console/source; git reset --hard 9e2fd1640e543ae1e3d3dca68dde5cc891559b69; git clean -fd; test -z "$(git status --porcelain)"; git rev-parse --short HEAD'
```

Expected: `HEAD is now at 9e2fd16...`, no dirty status, then `9e2fd16`.

- [ ] **Step 3: Install locked dependencies**

Run:

```powershell
ssh hk 'set -e; cd /opt/cdk-redeem-console/source; export PATH=/opt/node-v22/bin:$PATH; npm ci'
```

Expected: exit code 0 with dependency installation completed.

- [ ] **Step 4: Run the complete test suite**

Run:

```powershell
ssh hk 'set -e; cd /opt/cdk-redeem-console/source; export PATH=/opt/node-v22/bin:$PATH; npm test'
```

Expected: `tests 183`, `pass 183`, `fail 0`.

- [ ] **Step 5: Build production assets**

Run:

```powershell
ssh hk 'set -e; cd /opt/cdk-redeem-console/source; export PATH=/opt/node-v22/bin:$PATH; npm run build; test -s dist/index.html'
```

Expected: Vite build succeeds and `dist/index.html` exists and is non-empty.

### Task 3: Restart, Verify, and Roll Back if Required

**Files:**
- Restart: `cdk-redeem-console.service`
- Read: systemd logs and HTTP responses
- Restore if required: archive created in Task 1

**Interfaces:**
- Consumes: tested build from Task 2 and rollback archive from Task 1.
- Produces: a verified live deployment or a restored previous deployment.

- [ ] **Step 1: Restart the application service**

Run:

```powershell
ssh hk 'set -e; systemctl restart cdk-redeem-console.service; systemctl is-active --quiet cdk-redeem-console.service; systemctl --no-pager --full status cdk-redeem-console.service | sed -n "1,16p"'
```

Expected: service state is `active (running)` and command exits 0.

- [ ] **Step 2: Verify local and public HTTP endpoints**

Run:

```powershell
ssh hk 'set -e; curl --fail --silent --show-error --max-time 15 http://127.0.0.1:5173/ >/dev/null; curl --fail --silent --show-error --max-time 20 https://cdk.334401.xyz/ >/dev/null; echo HTTP_OK'
```

Expected: `HTTP_OK`.

- [ ] **Step 3: Inspect fresh service logs for runtime failures**

Run:

```powershell
ssh hk 'journalctl -u cdk-redeem-console.service --since "5 minutes ago" --no-pager -n 80'
```

Expected: startup message for port 5173 and no crash loop, uncaught exception, or repeated restart.

- [ ] **Step 4: Verify deployed Git state**

Run:

```powershell
ssh hk 'cd /opt/cdk-redeem-console/source; git rev-parse HEAD; test -z "$(git status --porcelain)"; systemctl is-active cdk-redeem-console.service'
```

Expected: full SHA `9e2fd1640e543ae1e3d3dca68dde5cc891559b69`, clean working tree, and `active`.

- [ ] **Step 5: Roll back only if Steps 1-4 fail**

Run; the command selects the newest archive created for this deployment:

```powershell
ssh hk 'set -e; archive=$(find /opt/cdk-redeem-console/releases -maxdepth 1 -type f -name "pre-9e2fd16-*.tgz" -printf "%T@ %p\n" | sort -nr | head -n 1 | cut -d" " -f2-); test -n "$archive"; systemctl stop cdk-redeem-console.service; cd /opt/cdk-redeem-console/source; find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +; tar -xzf "$archive" -C /opt/cdk-redeem-console/source; export PATH=/opt/node-v22/bin:$PATH; npm ci; npm run build; systemctl start cdk-redeem-console.service; systemctl is-active --quiet cdk-redeem-console.service'
```

Expected: the previous application version is rebuilt and the service returns to active state.

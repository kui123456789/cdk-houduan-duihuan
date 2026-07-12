# Hong Kong Server Deployment Design

## Goal

Update the existing CDK redeem console at `https://cdk.334401.xyz` from its current deployed content to `origin/main` commit `9e2fd16`, while preserving a recoverable copy of the running version.

## Existing Environment

- Host: SSH alias `hk`, Debian 12.
- Application directory: `/opt/cdk-redeem-console/source`.
- Process manager: `cdk-redeem-console.service` under systemd.
- Runtime: `/opt/node-v22/bin/node`, listening on port `5173`.
- Reverse proxy: Caddy routes `cdk.334401.xyz` and the server IP to `127.0.0.1:5173`.
- The checked-out Git HEAD is `85deefa`, while the working files correspond to the later `3bd95a4` deployment apart from line-ending and index-state differences.

## Deployment Procedure

1. Record the current service state and commit identifiers.
2. Create a timestamped archive in `/opt/cdk-redeem-console/releases` containing the current application source, excluding `node_modules` and generated build output.
3. Fetch `origin/main`, confirm it resolves to `9e2fd16`, then synchronize the working tree to that exact commit.
4. Install locked dependencies with `npm ci` using `/opt/node-v22/bin`.
5. Run the complete test suite and production build before restarting the service.
6. Restart `cdk-redeem-console.service` only after tests and build succeed.
7. Verify systemd state, the local HTTP endpoint, the public HTTPS endpoint, and recent service logs.

## Failure Handling and Rollback

- If dependency installation, tests, or build fails, do not restart the service; the currently running process remains active.
- If the restarted service or HTTP checks fail, stop the service, restore the timestamped source archive, reinstall dependencies if required, rebuild, and restart the service.
- Do not change the Caddy configuration, domain, ports, SSH configuration, or unrelated services.

## Success Criteria

- The server source is at commit `9e2fd16` with a clean Git working tree.
- `npm test` passes with zero failures.
- `npm run build` succeeds.
- `cdk-redeem-console.service` is active.
- `https://cdk.334401.xyz` returns a successful HTTP response.
- The backup archive path is reported for later rollback.

function labelValue(value) {
  return String(value || "unknown").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function labels(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${labelValue(value)}"`)
    .join(",");
}

export function createMetrics({ database = null, workerHeartbeatService = null } = {}) {
  const http = new Map();
  const workerRuns = new Map();

  return {
    recordHttp({ method, route, statusCode, durationMs }) {
      const key = JSON.stringify([method, route, statusCode]);
      const current = http.get(key) || { count: 0, durationMs: 0 };
      current.count += 1;
      current.durationMs += Number(durationMs) || 0;
      http.set(key, current);
    },

    recordWorker(outcome) {
      const key = String(outcome || "unknown");
      workerRuns.set(key, (workerRuns.get(key) || 0) + 1);
    },

    async render() {
      const lines = [
        "# HELP cdk_http_requests_total Completed HTTP requests.",
        "# TYPE cdk_http_requests_total counter",
        "# HELP cdk_http_request_duration_ms Request duration in milliseconds.",
        "# TYPE cdk_http_request_duration_ms summary"
      ];
      for (const [key, value] of http) {
        const [method, route, statusCode] = JSON.parse(key);
        const labelText = labels({ method, route, status_code: statusCode });
        lines.push(`cdk_http_requests_total{${labelText}} ${value.count}`);
        lines.push(`cdk_http_request_duration_ms_sum{${labelText}} ${value.durationMs.toFixed(3)}`);
        lines.push(`cdk_http_request_duration_ms_count{${labelText}} ${value.count}`);
      }
      lines.push("# HELP cdk_worker_runs_total Worker job loop outcomes.");
      lines.push("# TYPE cdk_worker_runs_total counter");
      for (const [outcome, count] of workerRuns) {
        lines.push(`cdk_worker_runs_total{${labels({ outcome })}} ${count}`);
      }

      let collectionError = 0;
      if (database) {
        try {
          const result = await database.query(
            "SELECT status, COUNT(*)::int AS count FROM redeem_jobs GROUP BY status"
          );
          lines.push("# HELP cdk_redeem_jobs Current jobs by status.");
          lines.push("# TYPE cdk_redeem_jobs gauge");
          for (const row of result.rows) {
            lines.push(`cdk_redeem_jobs{${labels({ status: row.status })}} ${Number(row.count)}`);
          }
        } catch {
          collectionError = 1;
        }
      }
      if (workerHeartbeatService) {
        try {
          const worker = await workerHeartbeatService.check();
          lines.push("# HELP cdk_worker_ready Whether a recent worker heartbeat exists.");
          lines.push("# TYPE cdk_worker_ready gauge");
          lines.push(`cdk_worker_ready ${worker.ready ? 1 : 0}`);
        } catch {
          collectionError = 1;
        }
      }
      lines.push("# HELP cdk_metrics_collection_error Whether dependency metrics failed.");
      lines.push("# TYPE cdk_metrics_collection_error gauge");
      lines.push(`cdk_metrics_collection_error ${collectionError}`);
      return `${lines.join("\n")}\n`;
    }
  };
}

export function createMetricsHandler(metrics) {
  return async (_req, res, next) => {
    try {
      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.set("Cache-Control", "no-store");
      return res.send(await metrics.render());
    } catch (error) {
      return next(error);
    }
  };
}

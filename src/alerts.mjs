// Turns the observability summary into actionable alerts (roadmap Phase 10).
//
// Thresholds default to the Phase 11 beta success criteria, so "are we beta-ready?" is answerable
// from the same data the dashboard already shows:
//   <2s median command acknowledgement, <10s audio-to-prompt dispatch, reliable device reconnect,
//   clear token/device revocation.

export const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  acknowledgementMedianMs: 2000,
  acknowledgementP95Ms: 5000,
  dispatchMedianMs: 10_000,
  commandFailureRatio: 0.1,
  minCommandsForRatio: 5,
  lowBatteryPercent: 20,
});

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

export function loadAlertThresholds(env = process.env) {
  return {
    acknowledgementMedianMs: intEnv(env, "ALERT_ACK_MEDIAN_MS", DEFAULT_ALERT_THRESHOLDS.acknowledgementMedianMs),
    acknowledgementP95Ms: intEnv(env, "ALERT_ACK_P95_MS", DEFAULT_ALERT_THRESHOLDS.acknowledgementP95Ms),
    dispatchMedianMs: intEnv(env, "ALERT_DISPATCH_MEDIAN_MS", DEFAULT_ALERT_THRESHOLDS.dispatchMedianMs),
    commandFailureRatio: floatEnv(env, "ALERT_COMMAND_FAILURE_RATIO", DEFAULT_ALERT_THRESHOLDS.commandFailureRatio),
    minCommandsForRatio: intEnv(env, "ALERT_MIN_COMMANDS", DEFAULT_ALERT_THRESHOLDS.minCommandsForRatio),
    lowBatteryPercent: intEnv(env, "ALERT_LOW_BATTERY_PERCENT", DEFAULT_ALERT_THRESHOLDS.lowBatteryPercent),
  };
}

/**
 * @returns {Array<{id, severity, title, detail, metric, value, threshold}>} most severe first.
 */
export function evaluateAlerts(summary, thresholds = DEFAULT_ALERT_THRESHOLDS) {
  const limits = { ...DEFAULT_ALERT_THRESHOLDS, ...(thresholds ?? {}) };
  const alerts = [];
  const add = (alert) => alerts.push(alert);

  const environments = summary?.environments ?? {};
  if (environments.tokenExpired > 0) {
    add({
      id: "environment.token_expired",
      severity: "critical",
      title: "T3 access token expired",
      detail: `${environments.tokenExpired} environment(s) cannot dispatch until re-paired.`,
      metric: "environments.tokenExpired",
      value: environments.tokenExpired,
      threshold: 0,
    });
  }
  if (environments.unreachable > 0) {
    add({
      id: "environment.unreachable",
      severity: "critical",
      title: "T3 environment unreachable",
      detail: `${environments.unreachable} of ${environments.total} environment(s) failed their last health check.`,
      metric: "environments.unreachable",
      value: environments.unreachable,
      threshold: 0,
    });
  }
  if (environments.tokenExpiringSoon > 0) {
    add({
      id: "environment.token_expiring",
      severity: "warning",
      title: "T3 access token expiring soon",
      detail: `${environments.tokenExpiringSoon} environment(s) expire within a week.`,
      metric: "environments.tokenExpiringSoon",
      value: environments.tokenExpiringSoon,
      threshold: 0,
    });
  }
  if (environments.compatibilityBreakingRisks > 0) {
    add({
      id: "environment.t3_compatibility_breaking",
      severity: "critical",
      title: "T3 Code compatibility change detected",
      detail: `${environments.compatibilityBreakingRisks} environment(s) changed in a way that could break Next Coder.`,
      metric: "environments.compatibilityBreakingRisks",
      value: environments.compatibilityBreakingRisks,
      threshold: 0,
    });
  } else if (environments.compatibilityReviewRequired > 0) {
    add({
      id: "environment.t3_compatibility_review",
      severity: "warning",
      title: "T3 Code version needs compatibility review",
      detail: `${environments.compatibilityReviewRequired} environment(s) run a version newer than Next Coder has certified.`,
      metric: "environments.compatibilityReviewRequired",
      value: environments.compatibilityReviewRequired,
      threshold: 0,
    });
  }
  if (environments.compatibilityUpdatesRecommended > 0) {
    add({
      id: "environment.t3_update_recommended",
      severity: "info",
      title: "T3 Code update recommended",
      detail: `${environments.compatibilityUpdatesRecommended} environment(s) can update to the recommended supported version.`,
      metric: "environments.compatibilityUpdatesRecommended",
      value: environments.compatibilityUpdatesRecommended,
      threshold: 0,
    });
  }

  const devices = summary?.devices ?? {};
  if (devices.total > 0 && devices.offline > 0) {
    add({
      id: "device.offline",
      severity: devices.online === 0 ? "critical" : "warning",
      title: devices.online === 0 ? "All controllers offline" : "Controller offline",
      detail: `${devices.offline} of ${devices.total} controller(s) have not reported recently.`,
      metric: "devices.offline",
      value: devices.offline,
      threshold: 0,
    });
  }
  if (devices.lowBatteryDevices > 0) {
    add({
      id: "device.low_battery",
      severity: "warning",
      title: "Controller battery low",
      detail: `${devices.lowBatteryDevices} controller(s) below ${limits.lowBatteryPercent}%`
        + (devices.lowestBatteryPercent === null ? "." : `; lowest is ${devices.lowestBatteryPercent}%.`),
      metric: "devices.lowBatteryDevices",
      value: devices.lowBatteryDevices,
      threshold: limits.lowBatteryPercent,
    });
  }

  const commands = summary?.commands ?? {};
  const settled = (commands.completed ?? 0) + (commands.failed ?? 0);
  if (settled >= limits.minCommandsForRatio) {
    const ratio = (commands.failed ?? 0) / settled;
    if (ratio > limits.commandFailureRatio) {
      add({
        id: "command.failure_rate",
        severity: "critical",
        title: "Command failure rate is high",
        detail: `${commands.failed} of ${settled} settled command(s) failed (${formatPercent(ratio)}).`,
        metric: "commands.failureRatio",
        value: Number(ratio.toFixed(4)),
        threshold: limits.commandFailureRatio,
      });
    }
  }
  if (commands.approvalRequired > 0) {
    add({
      id: "command.awaiting_approval",
      severity: "info",
      title: "Commands awaiting approval",
      detail: `${commands.approvalRequired} command(s) are held for a decision.`,
      metric: "commands.approvalRequired",
      value: commands.approvalRequired,
      threshold: 0,
    });
  }

  addLatencyAlert(add, {
    id: "command.acknowledgement_median",
    title: "Command acknowledgement is slow",
    metric: "commands.acknowledgement.medianMs",
    value: commands.acknowledgement?.medianMs,
    threshold: limits.acknowledgementMedianMs,
    severity: "warning",
    unit: "median",
  });
  addLatencyAlert(add, {
    id: "command.acknowledgement_p95",
    title: "Command acknowledgement p95 is slow",
    metric: "commands.acknowledgement.p95Ms",
    value: commands.acknowledgement?.p95Ms,
    threshold: limits.acknowledgementP95Ms,
    severity: "warning",
    unit: "p95",
  });
  addLatencyAlert(add, {
    id: "command.dispatch_median",
    title: "Dispatch is slow",
    metric: "commands.dispatch.medianMs",
    value: commands.dispatch?.medianMs,
    threshold: limits.dispatchMedianMs,
    severity: "warning",
    unit: "median",
  });

  const media = summary?.media ?? {};
  if (media.failedProcessing > 0) {
    add({
      id: "media.processing_failed",
      severity: "warning",
      title: "Media processing failed",
      detail: `${media.failedProcessing} upload(s) could not be processed.`,
      metric: "media.failedProcessing",
      value: media.failedProcessing,
      threshold: 0,
    });
  }

  return alerts.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
}

/** Compact roll-up for a status badge. */
export function summarizeAlerts(alerts) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const alert of alerts) counts[alert.severity] += 1;
  return {
    total: alerts.length,
    ...counts,
    worst: alerts[0]?.severity ?? null,
  };
}

function addLatencyAlert(add, { id, title, metric, value, threshold, severity, unit }) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || value <= threshold) return;
  add({
    id,
    severity,
    title,
    detail: `${unit} is ${Math.round(value)}ms against a ${threshold}ms budget.`,
    metric,
    value,
    threshold,
  });
}

function formatPercent(ratio) {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function intEnv(env, key, fallback) {
  const value = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function floatEnv(env, key, fallback) {
  const value = Number.parseFloat(env[key] ?? "");
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

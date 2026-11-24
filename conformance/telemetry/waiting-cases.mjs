// Reuse the shared SDK step streams. The same records and counter must pass
// when the application chooses not to install an OpenTelemetry SDK.
export const waitingCases = {
  'waiting-approval': { decision: 'allow', actor: 'user', status: 'completed' },
  'waiting-approval-decline': { decision: 'decline', actor: 'user', status: 'refused' },
  'waiting-approval-expire-stopped': { decision: 'timeLimit', status: 'notStarted' },
  'waiting-approval-changed-approver': { decision: 'allow', actor: 'reviewer', status: 'refused' },
};
export const waitingRequirements = scenario => Object.hasOwn(waitingCases, scenario)
  ? ['approvalsOutlastTurns', ...(scenario === 'waiting-approval-changed-approver' ? ['severalActors'] : [])] : [];

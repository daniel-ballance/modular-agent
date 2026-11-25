import type { parseModel } from "./harness.js";
import { ToolDispatch } from "./tool-dispatch.js";
import { InterfaceToolRoutes } from "./interface-tool-routes.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { Reservations } from "./reservations.js";
import { HookRegistry } from "./hooks.js";
import { Session } from "./session.js";
import { type Declaration, type HistoryStore, type Provider, type Runtime, type WorkingEnvironment } from "./types.js";

interface DeclarationsOperations {
	runtime(): Runtime | undefined;
	use<T>(capability: string): T | undefined;
	providerFor(s: Session, ref?: ReturnType<typeof parseModel> | null): Provider | undefined;
	interfaceTools(): Pick<InterfaceToolRoutes, "interfaceSources">;
	projectOf(s: Session): string;
	project(): string;
	hooks(): HookRegistry;
	jobReportsStartTurns(): boolean;
	erasure(): Pick<SessionErasure, "pendingRegistry" | "httpErasure">;
	reservations(): Reservations;
	questionsOutlastTurns(): boolean;
	approvals(): Pick<ApprovalReconciliation, "maximum">;
	tools(): Pick<ToolDispatch, "coversNested">;
	settingsDuringTurn(): "nextTurn" | "refused" | undefined;
}

export class Declarations {
	constructor(private readonly operations: DeclarationsOperations) {}

	recoveryPolicy() {
		const supports = this.operations.runtime()?.supports;
		const input = supports?.queuedInputAfterRestart === "run" ? "run" : "handedBack";
		const jobs = supports?.queuedJobReportsAfterRestart ?? (supports?.queuedInputAfterRestart ? input : "run");
		return { input, jobs: jobs === "handedBack" ? "handedBack" : "run" };
	}

	declaration(s?: Session): Declaration {
		const runtime = this.operations.runtime();
		const store = this.operations.use<HistoryStore>("history-store");
		const provider = s ? this.operations.providerFor(s) : undefined;
		const env = this.operations.use<WorkingEnvironment>("working-environment");
		const recovery = this.recoveryPolicy();
		return {
			inputDuringTurn: runtime?.supports.inputDuringTurn === true,
			...(this.operations.interfaceTools().interfaceSources.size > 0 && runtime?.supports.interfaceTools === true ? { interfaceTools: true } : {}),
			waitingThroughRestart: runtime?.supports.waitingThroughRestart === true && !!store && !s?.ephemeral,
			continuesAfterRestart: runtime?.supports.continuesAfterRestart === true,
			rewinding: env?.keepsPoints?.(s ? this.operations.projectOf(s) : this.operations.project()) ?? env?.points === true,
			forking: !!store,
			keepsStateAtProvider: provider?.supports.keepsState === true,
			runsToolsAtProvider: provider?.supports.runsTools === true,
			liveSessions: provider?.supports.liveSessions === true,
			severalActors: true,
			sessionLimits: true,
			tenants: true,
			holdsOutput: this.operations.hooks().raw("output").some(handler => handler.stream),
			outputBypassesAgent: false,
			startsTurnsUnasked: this.operations.jobReportsStartTurns() ? "when a job reports back" : "never",
			cancellingTurnCancelsJobs: false,
			pluginsDuringSession: false,
			erasure: (!!this.operations.erasure().pendingRegistry() || !!this.operations.erasure().httpErasure()) && (!store || !!store.erase),
			inputKeys: true,
			resourceReservations: this.operations.reservations().declaration(),
			telemetry: 1,
			portableSessions: true,
			nestedToolCalls: runtime?.supports.nestedToolCalls === true,
			mixedActorInput: "shared",
			erasureDuringTurn: "refused",
			questionsOutlastTurns: this.operations.questionsOutlastTurns(),
			...(this.operations.approvals().maximum === undefined ? {} : { approvalsOutlastTurns: true, lateAnswersStartTurns: true }),
			...(this.operations.tools().coversNested() ? { approvalCoversNested: true } : {}),
			queuedInputAfterRestart: recovery.input,
			...(recovery.jobs !== recovery.input ? { queuedJobReportsAfterRestart: recovery.jobs } : {}),
			movingWithUnfinishedWork: "refused",
			commandContainment: env?.containment ?? "none",
			confinesFiles: env?.confinesFiles === true,
			settingsDuringTurn: this.operations.settingsDuringTurn() ?? "nextTurn",
		};
	}
}

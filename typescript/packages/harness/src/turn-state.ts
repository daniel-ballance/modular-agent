import type { ConnectionRights } from "./connection-authority.js";
import type { InterfaceConnection } from "./interface-tool-routes.js";
import type { Operation } from "./telemetry.js";
import type { Authority, ToolCall, TurnSnapshot } from "./types.js";

export interface TurnState extends TurnSnapshot { interfaceOffer?: Map<string, InterfaceConnection>; interfaceAllowances?: Map<string, { call: ToolCall; approval: unknown } | null>; dispatched: Set<string>; steps: Map<string, Operation>; startingRights?: Authority[]; connectionRights?: ConnectionRights; endedHook?: boolean; sources: Map<string, string[]>; actors: Set<string>; jobs: Set<string>; tenantLimit?: boolean; capacityLimit?: boolean; stepAfterRunning?: boolean; toolResultError?: string }

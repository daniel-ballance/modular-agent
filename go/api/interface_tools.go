package api

import (
	"context"
	"encoding/json"
)

const InterfaceHandoffKind = "modular-agent.interfaceHandoff"
const MaxSharedTime = 1<<53 - 1

type InterfaceHandoff struct {
	Started  string   `json:"toolStartedId"`
	Actor    string   `json:"executorActorId"`
	Route    string   `json:"routeId"`
	Rights   []string `json:"rights"`
	Deadline int64    `json:"deadline"`
}

type InterfaceReport struct {
	CallID  string          `json:"callId"`
	Status  string          `json:"status"`
	Content Content         `json:"content"`
	Value   json.RawMessage `json:"value,omitempty"`
}

type InterfaceDispatch interface {
	// DispatchInterface consumes an already checked allowance. handled is false
	// for tools that are not Interface-run.
	DispatchInterface(context.Context, Call, string, func(Call) error) (result ToolResult, handled bool)
}

// InterfaceHandoffs includes invalidated checkpoints (tombstones) but not
// copied prefixes. Call identities and terminal identities survive erasure.
func InterfaceHandoffs(s Session) map[string]Entry {
	out := map[string]Entry{}
	for _, e := range s.LiveEntries() {
		if e.WasKind(InterfaceHandoffKind) && e.Call != "" {
			out[e.Call] = e
		}
	}
	return out
}

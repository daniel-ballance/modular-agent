package modular

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

// InterfaceToolSource registers model-only tools without an agent-side handler.
type InterfaceToolSource struct {
	SourceID, ActorID, RouteID string
	ResultTimeoutMS            int64
	Tools                      []ToolDefinition
}

func WithInterfaceTools(sources ...InterfaceToolSource) Option {
	return func(o *options) error {
		for _, spec := range sources {
			source := harness.InterfaceSource{ID: spec.SourceID, Actor: spec.ActorID, Route: spec.RouteID, TimeoutMS: spec.ResultTimeoutMS}
			for _, def := range spec.Tools {
				if !slices.Equal(def.Callers, []string{"model"}) || def.Hints.SafeToRepeat {
					return &Error{Code: InvalidComposition, Message: fmt.Sprintf("Interface tool %q must have only the model caller and cannot promise safe repeat", def.Name)}
				}
				for _, raw := range []json.RawMessage{def.Parameters, def.Returns} {
					if len(raw) != 0 {
						if _, err := api.ResolveSchema(raw); err != nil {
							return appError(err, InvalidComposition)
						}
					}
				}
				if def.Name == "" || len(def.Parameters) == 0 {
					return &Error{Code: InvalidComposition, Message: "Interface tool requires a name and parameters schema"}
				}
				source.Definitions = append(source.Definitions, portable.ReadTool(api.Decode[portable.Object](api.JSON(def))))
			}
			o.interfaceTools = append(o.interfaceTools, source)
		}
		return nil
	}
}

// InterfaceToolConnectionOptions are supplied by the trusted Interface adapter
// after authenticating the connection, never from a request body.
type InterfaceToolConnectionOptions struct {
	ActorID, RouteID string
	Rights           *[]string // nil uses the recorded membership and current scope limits
	Scope            func(project, tenant string) bool
}

type InterfaceToolConnection struct{ connection *harness.InterfaceConnection }

type InterfaceToolReport struct {
	CallID  string          `json:"callId"`
	Status  ToolStatus      `json:"status"`
	Content Content         `json:"content"`
	Value   json.RawMessage `json:"value,omitempty"`
}

type InterfaceToolReportDisposition struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

const (
	InterfaceToolAccepted       = harness.InterfaceAccepted
	InterfaceToolAlreadySettled = harness.InterfaceAlreadySettled
	InterfaceToolRefused        = harness.InterfaceRefused
	InterfaceToolNotReady       = harness.InterfaceNotReady
)

func (a *Agent) ConnectInterfaceTools(sessionID string, options InterfaceToolConnectionOptions) (*InterfaceToolConnection, error) {
	connection, err := a.h.ConnectInterface(sessionID, options.ActorID, options.RouteID, options.Rights, options.Scope)
	if err != nil {
		return nil, appError(err, Forbidden)
	}
	return &InterfaceToolConnection{connection}, nil
}

// Advertise replaces this connection's current availability by registered name.
func (c *InterfaceToolConnection) Advertise(names ...string) error {
	return appError(c.connection.Advertise(names), InvalidRequest)
}

// NextHandoff waits for one live executable request. It never replays a call.
func (c *InterfaceToolConnection) NextHandoff(ctx context.Context) (ToolCall, error) {
	call, err := c.connection.NextHandoff(ctx)
	return ToolCall{ID: call.ID, Name: call.Name, Input: call.Input, StartedBy: call.Origin, ActorID: call.Actor, ParentCallID: call.ParentCall}, appError(err, Forbidden)
}

// ReportToolResult never dispatches the reported call.
func (c *InterfaceToolConnection) ReportToolResult(ctx context.Context, report InterfaceToolReport) (InterfaceToolReportDisposition, error) {
	status, err := c.connection.ReportToolResult(ctx, api.InterfaceReport{CallID: report.CallID, Status: string(report.Status), Content: portable.ReadContent(api.Decode[[]any](api.JSON(report.Content))), Value: report.Value})
	if status == harness.InterfaceNotReady {
		return InterfaceToolReportDisposition{Status: InterfaceToolRefused, Reason: InterfaceToolNotReady}, nil
	}
	return InterfaceToolReportDisposition{Status: status}, appError(err, InvalidRequest)
}

// Close clears presence but does not cancel or settle handed-off calls.
func (c *InterfaceToolConnection) Close() { c.connection.Close() }

// Package approval is an optional feature plugin on the standard tool gate.
package approval

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"strings"
	"time"
)

func Plugin(requested ...time.Duration) api.Plugin {
	return api.Plugin{Name: "approval", Setup: func(a api.API) error {
		if err := a.RegisterCommand("approval", func(ctx context.Context, id string, raw string) (string, error) {
			args := strings.Fields(raw)
			if len(args) != 1 {
				return "", errors.New("usage: /approval off|ask-unless-read-only|ask-always|never")
			}
			switch args[0] {
			case "off", "ask-unless-read-only", "ask-always", "never":
			default:
				return "", errors.New("unknown approval policy")
			}
			s, e := a.Snapshot(id)
			if e != nil {
				return "", e
			}
			s.Settings.Approval = args[0]
			return "Approval policy updated.", a.SetSettings(ctx, id, s.Settings)
		}); err != nil {
			return err
		}
		return a.Handle("runtime.tool.before", "last", func(ctx context.Context, v any) (api.Decision, error) {
			check := v.(api.ToolCheck)
			s, err := a.Snapshot(check.Session)
			if err != nil {
				return api.Decision{}, err
			}
			policy := s.Settings.Approval
			for _, e := range s.Branch() {
				if e.Turn == check.Turn && e.Kind == "turn.start" {
					recorded := api.Decode[api.TurnStart](e.Data).Settings.Approval
					policy = api.ReopenedApproval(recorded)
				}
			}
			switch policy {
			case "", "off":
				return api.Decision{}, nil
			case "ask-unless-read-only":
				if check.Definition.ReadOnly {
					return api.Decision{}, nil
				}
			case "ask-always":
			case "never":
				check.Refused = "Approval policy never asks; call refused"
				return api.Decision{Value: check}, nil
			default:
				return api.Decision{}, errors.New("unknown approval policy")
			}
			if check.ApprovalCovered && check.Call.ParentCall != "" {
				// The parent answered only this gate. In particular never still refuses.
				return api.Decision{}, nil
			}
			q, err := a.Get("questions")
			if err != nil {
				return api.Decision{}, err
			}
			// Include the transformed arguments: an allow for old arguments cannot authorize new ones.
			key := fmt.Sprintf("approval:%s:%x", check.Call.ID, sha256.Sum256(check.Call.Input))
			draft := api.Question{Session: s.ID, Turn: check.Turn, Call: check.Call.ID, Actor: check.Call.Actor, Key: key, Kind: "approval", Prompt: "Allow " + check.Call.Name + " " + string(check.Call.Input) + "?", Wait: time.Minute, ApprovalCall: &check.Call, Definition: &check.Definition, Source: api.Executing(ctx).ToolSource}
			if check.ApprovalAttempt != "" && check.Call.ParentCall == "" {
				draft.CoversNested = true
				draft.Prompt += " An allow covers the nested calls this call makes."
				// A repeated live dispatch must get a new allow, not a replay by call ID.
				draft.Key = fmt.Sprintf("%s:%s:%x", key, check.ApprovalAttempt, sha256.Sum256(api.JSON([]any{draft.Source, draft.Definition})))
			}
			// Live approvals retain the existing one-minute wait. A parked
			// gate without an explicit shorter request uses the operator maximum.
			parked := draft
			parked.Wait = 0
			if len(requested) > 0 {
				parked.Wait = requested[0]
			}
			if host, ok := a.(interface {
				ParkApproval(context.Context, api.Question) (bool, error)
			}); ok {
				if handled, err := host.ParkApproval(ctx, parked); handled {
					return api.Decision{Value: check}, err
				}
			}
			answer, err := q.(api.Questions).Ask(ctx, draft)
			if err != nil {
				return api.Decision{}, err
			}
			if answer.Declined || answer.Value != "allow" {
				check.Refused = "Approval refused"
			} else {
				if draft.CoversNested {
					draft.ID = answer.Request
					check.LiveApproval = &draft
				}
				input := string(check.Call.Input)
				check.Validate = func(call api.Call) error {
					if string(call.Input) != input || !a.Authorize(s.ID, answer.Actor, "approve") {
						return errors.New("approval no longer authorizes this call")
					}
					for _, ref := range answer.Via {
						if !a.Authorize(ref.Session, ref.Actor, "approve") {
							return errors.New("approval authority revoked")
						}
					}
					return nil
				}
			}
			return api.Decision{Value: check}, nil
		})
	}}
}

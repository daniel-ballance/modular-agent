// Package agenthttp exposes the agent through an authenticated HTTP Interface.
// Recorded entry IDs are replay cursors. Transient pieces are best-effort only.
package agenthttp

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"net/http"
	"sync"
	"time"
)

const actor = "local-user" // this binding authenticates one operator-controlled host

type Request struct {
	Op, Session, Key, When, After, Request, Value, Command, Position, Input, Job string
	Content                                                                      api.Content
	Settings                                                                     api.Settings
	Call                                                                         api.Call
	IDs                                                                          []string
	Declined, Rewind                                                             bool
}
type Summary struct {
	ID, Project, Position string
	Settings              api.Settings
}
type Response struct {
	Session    string
	Sessions   []Summary
	Receipt    api.Receipt
	Outcome    api.Outcome
	Questions  []api.Question
	Jobs       []api.Job
	Result     string
	Input      api.Input
	ToolResult api.ToolResult
	Support    json.RawMessage
}
type Frame struct {
	Kind, Cursor string
	Entry        *api.Entry
	Event        *api.Event
}
type Interface struct {
	a         api.API
	project   string
	lifecycle sync.Mutex
}

func Plugin(project string) api.Plugin {
	return api.Plugin{Name: "http-interface", Setup: func(a api.API) error {
		canonical, err := configuration.Canonical(project)
		if err != nil {
			return err
		}
		return a.Provide("interface.http", &Interface{a: a, project: canonical})
	}}
}
func (i *Interface) Handler(token string) http.Handler {
	return servicehttp.Auth(token, http.HandlerFunc(i.serve))
}
func (i *Interface) questions() api.Questions { v, _ := i.a.Get("questions"); return v.(api.Questions) }
func (i *Interface) identify(ctx context.Context, id string) error {
	var rights []string
	for _, r := range api.Rights {
		if i.a.Authorize(id, actor, r) {
			rights = append(rights, r)
		}
	}
	return i.a.Grant(ctx, id, api.Actor{ID: actor, Kind: "host", Rights: rights})
}
func (i *Interface) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var q Request
	if !servicehttp.Decode(w, r, &q) {
		return
	}
	ctx := api.AsActor(r.Context(), actor)
	if r.URL.Path == "/v1/agent/events" {
		i.follow(ctx, w, q)
		return
	}
	if r.URL.Path != "/v1/agent" {
		http.NotFound(w, r)
		return
	}
	var out Response
	var err error
	switch q.Op {
	case "new":
		i.lifecycle.Lock()
		out.Session, err = i.a.New(ctx, i.project)
		if err == nil {
			err = i.identify(ctx, out.Session)
		}
		i.lifecycle.Unlock()
	case "open":
		i.lifecycle.Lock()
		if _, e := i.a.Snapshot(q.Session); e != nil {
			err = i.a.Open(ctx, q.Session)
		}
		if err == nil {
			err = i.identify(ctx, q.Session)
		}
		i.lifecycle.Unlock()
		out.Session = q.Session
	case "list":
		var all []api.Session
		all, err = i.a.List(i.project)
		for _, s := range all {
			out.Sessions = append(out.Sessions, Summary{s.ID, s.Project, s.Position, s.Settings})
		}
	default:
		if !i.a.Authorize(q.Session, actor, "watch") {
			servicehttp.Fail(w, errors.New("session not open or watch refused"))
			return
		}
		switch q.Op {
		case "input":
			out.Receipt, err = i.a.Submit(ctx, q.Session, api.Input{Key: q.Key, When: q.When, Content: q.Content, Actor: actor})
		case "wait":
			out.Outcome, err = i.a.Wait(ctx, q.Session)
		case "cancel":
			err = i.a.CancelAs(ctx, q.Session)
		case "close", "stop":
			i.lifecycle.Lock()
			if q.Op == "close" {
				err = i.a.CloseSession(q.Session)
			} else {
				err = i.a.StopSession(q.Session)
			}
			i.lifecycle.Unlock()
		case "questions":
			var text string
			text, err = i.a.Command(ctx, q.Session, "/requests")
			if err == nil {
				err = json.Unmarshal([]byte(text), &out.Questions)
			}
		case "answer":
			var qs []api.Question
			qs, err = i.questions().List(q.Session)
			if err == nil {
				for _, question := range qs {
					if question.ID == q.Request && question.Kind == "secret" {
						err = errors.New("this agent has no secret credential destination")
						break
					}
				}
			}
			if err == nil {
				err = i.questions().Answer(ctx, q.Session, api.Answer{Request: q.Request, Actor: actor, Value: q.Value, Declined: q.Declined})
			}
		case "settings":
			err = i.a.SetSettings(ctx, q.Session, q.Settings)
		case "command":
			out.Result, err = i.a.Command(ctx, q.Session, q.Command)
		case "support":
			out.Result, err = i.a.Command(ctx, q.Session, "/support")
			if err == nil {
				out.Support = api.JSON(map[string]any{"wire": 1, "agent": json.RawMessage(out.Result), "http_actor": actor, "http_actor_selection": false, "secret_answers": false, "record_cursor": "entry_id", "streamed_piece_replay": false, "new_session_retry": false})
			}
		case "withdraw":
			if !i.a.Authorize(q.Session, actor, "input") {
				err = errors.New("input refused")
			} else {
				out.Input, err = i.a.Withdraw(ctx, q.Session, q.Input)
			}
		case "tool":
			q.Call.Actor = actor
			q.Call.Origin = "ui"
			out.ToolResult, err = i.a.CallTool(ctx, q.Session, q.Call)
		case "jobs":
			var text string
			text, err = i.a.Command(ctx, q.Session, "/jobs")
			if err == nil {
				err = json.Unmarshal([]byte(text), &out.Jobs)
			}
		case "job_cancel":
			v, e := i.a.Get("jobs")
			err = e
			if err == nil {
				err = v.(api.Jobs).Cancel(ctx, q.Session, q.Job)
			}
		case "move":
			err = i.a.Move(ctx, q.Session, q.Position, q.Rewind)
		case "fork":
			out.Session, err = i.a.Fork(ctx, q.Session, q.Position)
		case "erase":
			err = i.a.Erase(ctx, q.Session, q.IDs)
		default:
			err = errors.New("unknown agent operation")
		}
	}
	if err != nil {
		if errors.Is(err, api.ErrSessionLost) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(servicehttp.Failure{Error: api.ErrSessionLost.Error(), Kind: "lost", Code: "lost"})
			return
		}
		servicehttp.Fail(w, err)
		return
	}
	servicehttp.JSON(w, out)
}
func (i *Interface) follow(ctx context.Context, w http.ResponseWriter, q Request) {
	if !i.a.Authorize(q.Session, actor, "watch") {
		servicehttp.Fail(w, errors.New("watch refused"))
		return
	}
	events := make(chan api.Event, 128)
	unsub := i.a.Subscribe(func(e api.Event) {
		if e.Session == q.Session && e.Kind != "history.added" {
			select {
			case events <- e:
			default:
			}
		}
	})
	defer unsub()
	// Only an actual follower counts as a responder. Merely having an HTTP server
	// must not make approvals hang instead of failing closed.
	disconnect := i.questions().Connect(q.Session, actor)
	defer disconnect()
	snap, err := i.a.View(ctx, q.Session)
	if err != nil {
		servicehttp.Fail(w, err)
		return
	}
	cursor := q.After
	if cursor != "" {
		found := false
		for _, e := range snap.Entries {
			if e.ID == cursor {
				found = true
				break
			}
		}
		if !found {
			servicehttp.Fail(w, errors.New("unknown replay cursor"))
			return
		}
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	if servicehttp.Frame(w, Frame{Kind: "ready", Cursor: cursor}) != nil {
		return
	}
	send := func(snap api.Session) bool {
		start := 0
		if cursor != "" {
			found := false
			for n, e := range snap.Entries {
				if e.ID == cursor {
					start = n + 1
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		for _, e := range snap.Entries[start:] {
			if !i.a.Authorize(q.Session, actor, "watch") {
				return false
			}
			if servicehttp.Frame(w, Frame{Kind: "entry", Cursor: e.ID, Entry: &e}) != nil {
				return false
			}
			cursor = e.ID
		}
		return true
	}
	if !send(snap) {
		return
	}
	poll := time.NewTicker(25 * time.Millisecond)
	defer poll.Stop()
	heartbeat := time.NewTicker(time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-events:
			if !i.a.Authorize(q.Session, actor, "watch") {
				return
			}
			if servicehttp.Frame(w, Frame{Kind: "event", Event: &e}) != nil {
				return
			}
		case <-poll.C:
			snap, err = i.a.View(ctx, q.Session)
			if err != nil || !send(snap) {
				return
			}
		case <-heartbeat.C:
			if servicehttp.Frame(w, Frame{Kind: "heartbeat", Cursor: cursor}) != nil {
				return
			}
		}
	}
}

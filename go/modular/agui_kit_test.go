package modular_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type kitClock struct {
	mu     sync.Mutex
	now    time.Time
	timers map[*kitTimer]bool
}
type kitTimer struct {
	c    *kitClock
	at   time.Time
	fire func()
}

func (t *kitTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	active := t.c.timers[t]
	delete(t.c.timers, t)
	return active
}
func (c *kitClock) install() {
	c.now = time.Now()
	c.timers = map[*kitTimer]bool{}
	worktime.Now = func() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
	worktime.At = func(at time.Time, fn func()) worktime.Timer {
		t := &kitTimer{c, at, fn}
		c.mu.Lock()
		if at.After(c.now) {
			c.timers[t] = true
		} else {
			go fn()
		}
		c.mu.Unlock()
		return t
	}
}
func (c *kitClock) advance(ms int64) {
	c.mu.Lock()
	c.now = c.now.Add(time.Duration(ms) * time.Millisecond)
	var tasks []func()
	for t := range c.timers {
		if !t.at.After(c.now) {
			delete(c.timers, t)
			tasks = append(tasks, t.fire)
		}
	}
	c.mu.Unlock()
	for _, fn := range tasks {
		fn()
	}
}

type agFixture struct {
	Name, Project, ControlTokenFile string
	TokenFiles                      map[string]string
	Offer                           modular.ToolDefinition
	dir                             string
	host                            api.API
	clock                           kitClock
	spans                           *tracetest.SpanRecorder
	mu                              sync.Mutex
	redactClient                    string
	edges                           map[string]chan struct{}
	warnings                        []string
	erasure                         api.ProviderErasure
}

func (f *agFixture) edge(name string) chan struct{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.edges[name] == nil {
		f.edges[name] = make(chan struct{})
	}
	return f.edges[name]
}
func (f *agFixture) signal(name string) {
	c := f.edge(name)
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-c:
	default:
		close(c)
	}
}
func (f *agFixture) pause(name string) { f.signal(name); <-f.edge("release:" + name) }
func (f *agFixture) log(name string, v any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	out, err := os.OpenFile(filepath.Join(f.dir, name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(out).Encode(v)
	return errors.Join(err, out.Close())
}
func lines[T any](path string) []T {
	rows := []T{}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return rows
	}
	if err != nil {
		panic(err)
	}
	defer file.Close()
	dec := json.NewDecoder(file)
	for {
		var v T
		err := dec.Decode(&v)
		if err == io.EOF {
			break
		}
		if err != nil {
			panic(err)
		}
		rows = append(rows, v)
	}
	return rows
}

type kitStore struct {
	*history.Store
	fixture *agFixture
}
type kitLease struct {
	api.Lease
	s *kitStore
	n int
}

func (s *kitStore) Acquire(id string) (api.Lease, error) {
	l, e := s.Store.Acquire(id)
	if e != nil {
		return nil, e
	}
	return &kitLease{Lease: l, s: s}, nil
}
func (l *kitLease) Load() (api.Session, error) {
	snap, e := l.Lease.Load()
	if e == nil {
		l.n = len(snap.Entries)
	}
	return snap, e
}
func (l *kitLease) SaveErasure(snap api.Session) error {
	return l.Lease.(api.ExactErasureLease).SaveErasure(snap)
}
func (l *kitLease) Save(snap api.Session) error {
	f := l.s.fixture
	batch := snap.Entries[l.n:]
	if len(batch) == 0 {
		return l.Lease.Save(snap)
	}
	if f.Name == "crash-before-handoff" && slices.ContainsFunc(batch, func(e api.Entry) bool { return e.Kind == api.InterfaceHandoffKind }) {
		f.pause("beforeHandoff")
	}
	if err := l.Lease.Save(snap); err != nil {
		return err
	}
	l.n = len(snap.Entries)
	entries := []json.RawMessage{}
	for _, e := range batch {
		entries = append(entries, portable.HistoryEntry(snap, e))
	}
	if err := f.log(snap.ID+".batches", entries); err != nil {
		return err
	}
	for _, e := range batch {
		if strings.HasPrefix(f.Name, "waiting-") {
			switch {
			case e.Kind == "question.answer":
				f.signal("answerCommitted")
			case e.Kind == "tool.result" && e.Actor == "kit-owner":
				f.signal("reportCommitted")
			case e.Kind == "turn.end" && slices.ContainsFunc(snap.Entries, func(s api.Entry) bool {
				return s.Kind == "turn.start" && s.Turn == e.Turn && api.Decode[api.TurnStart](s.Data).ContinuesTurn != ""
			}):
				f.signal("continuationEnded")
			}
		}
		if f.Name == "crash-after-result" && e.Kind == "tool.result" && e.Actor == "kit-owner" {
			f.pause("afterResult")
		}
		if f.Name == "crash-continuation" && e.Kind == "turn.start" && api.Decode[api.TurnStart](e.Data).ContinuesTurn != "" {
			f.pause("duringContinuation")
		}
	}
	return nil
}

type kitWriter struct {
	http.ResponseWriter
	f      *agFixture
	thread string
	staged []string
}

func (w *kitWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *kitWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	if err != nil || !bytes.HasPrefix(b, []byte("data: ")) {
		return n, err
	}
	var ev struct {
		Type, ThreadID, ToolCallID, ToolCallName string
		Outcome                                  struct{ PendingToolCallIDs []string }
	}
	if json.Unmarshal(bytes.TrimSpace(b[6:]), &ev) == nil {
		if ev.Type == "RUN_STARTED" {
			w.thread = ev.ThreadID
		}
		if ev.Type == "TOOL_CALL_START" && ev.ToolCallName == w.f.Offer.Name {
			w.staged = append(w.staged, ev.ToolCallID)
		}
		if ev.Type == "RUN_FINISHED" {
			ids := ev.Outcome.PendingToolCallIDs
			if strings.HasPrefix(w.f.Name, "waiting-mixed") && len(ids) == 0 {
				ids = w.staged
			}
			for _, id := range ids {
				if err = w.f.log(w.thread+".handoffs", id); err != nil {
					return n, err
				}
			}
		}
	}
	return n, nil
}

func (f *agFixture) parts() api.Plugin {
	return api.Plugin{Name: "kit", Setup: func(a api.API) error {
		err := a.Handle("runtime.tool.before", "first", func(ctx context.Context, v any) (api.Decision, error) {
			c := v.(api.ToolCheck)
			if c.Call.Name == f.Offer.Name {
				if portable.EqualJSON(c.Call.Input, []byte(`{"color":"draft-blue"}`)) {
					c.Call.Input = api.JSON(map[string]string{"color": "dispatch-blue"})
				}
				if strings.HasPrefix(f.Name, "approval") {
					qs, _ := a.Get("questions")
					ans, err := qs.(api.Questions).Ask(ctx, api.Question{Session: c.Session, Turn: c.Turn, Actor: c.Call.Actor, Call: c.Call.ID, Kind: "approval", Key: "check:" + c.Call.ID, Prompt: "Allow " + c.Call.Name + " " + string(c.Call.Input) + "?", ApprovalCall: &c.Call, Wait: 5 * time.Second})
					if err != nil || ans.Value != "allow" || ans.Declined {
						c.Refused = "Approval refused."
					} else {
						c.Validate = func(call api.Call) error {
							if !portable.EqualJSON(call.Input, c.Call.Input) || !a.Authorize(c.Session, ans.Actor, "approve") {
								return api.ErrAuthority
							}
							return nil
						}
					}
				}
			}
			return api.Decision{Value: c}, nil
		})
		if err != nil {
			return err
		}
		if err = a.Handle("runtime.tool.after", "", func(ctx context.Context, v any) (api.Decision, error) {
			x := v.(api.AfterTool)
			if x.Call.Name == f.Offer.Name && x.Result.Status == "completed" {
				x.Result.Content = api.Text("Checked frontend result.")
			}
			return api.Decision{Value: x}, nil
		}); err != nil {
			return err
		}
		ask := func(ctx context.Context, id, turn, actor string) error {
			qs, _ := a.Get("questions")
			_, err := qs.(api.Questions).Ask(ctx, api.Question{Session: id, Turn: turn, Actor: actor, Kind: "choice", Prompt: "Choose yes or no.", Options: []string{"yes", "no"}, Wait: 5 * time.Second})
			var decline *api.QuestionDeclined
			if errors.As(err, &decline) {
				return nil
			}
			return err
		}
		if err = a.Handle("runtime.turn.start", "", func(ctx context.Context, v any) (api.Decision, error) {
			t := v.(api.Turn)
			switch f.Name {
			case "questions":
				return api.Decision{}, ask(ctx, t.Session, t.ID, t.Actor)
			case "output-size":
				a.Emit(ctx, api.Event{Session: t.Session, Turn: t.ID, Kind: "plugin.kit.kit.oversized", Data: api.JSON(strings.Repeat("x", wswire.MaxFrame))})
			case "state-and-gate":
				emit := func(kind string, v any) {
					a.Emit(ctx, api.Event{Session: t.Session, Turn: t.ID, Kind: "plugin.kit." + kind, Data: api.JSON(v)})
				}
				for _, rev := range []int{1, 2, 3, 4, 5} {
					if rev == 4 {
						emit("modular-agent.agui.stateSnapshot", map[string]any{"revisionId": "4", "snapshot": map[string]int{"counter": 4}})
						continue
					}
					base := fmt.Sprint(rev - 1)
					if rev == 2 {
						base = "stale"
					}
					emit("modular-agent.agui.stateDelta", map[string]any{"baseRevisionId": base, "revisionId": fmt.Sprint(rev), "delta": []any{map[string]any{"op": "replace", "path": "/counter", "value": rev}}})
				}
				emit("kit.visible", true)
				emit("kit.hidden", "withheld-extension-sentinel")
				emit("modular-agent.agui.raw", map[string]any{"type": "fixture.foreign"})
				a.Emit(ctx, api.Event{Session: t.Session, Turn: t.ID, Kind: "plugin.other.modular-agent.agui.stateSnapshot", Data: api.JSON("wrong-plugin-sentinel")})
				_, err := a.Record(ctx, t.Session, api.Entry{Kind: "plugin.kit.note", Turn: t.ID, Data: api.JSON("visible note")})
				return api.Decision{}, err
			}
			return api.Decision{}, nil
		}); err != nil {
			return err
		}
		if f.Name == "mixed" {
			if err = a.Handle("runtime.step.after", "", func(ctx context.Context, v any) (api.Decision, error) {
				s := api.Executing(ctx)
				if len(v.(api.AfterStep).Response.Content) > 0 && v.(api.AfterStep).Response.Content[0].Call != nil {
					return api.Decision{}, ask(ctx, s.Session, s.Turn, "kit-owner")
				}
				return api.Decision{}, nil
			}); err != nil {
				return err
			}
		}
		return a.Handle("output.batch", "", func(ctx context.Context, v any) (api.Decision, error) {
			b := v.(api.OutputBatch)
			for i, e := range b.Events {
				f.mu.Lock()
				redact := f.redactClient == b.Recipient && f.redactClient != ""
				f.mu.Unlock()
				if redact && e.Method == "agui.interrupt" {
					e.Data = bytes.ReplaceAll(e.Data, []byte("waiting-counter-sentinel"), []byte("redacted"))
				}
				switch f.Name {
				case "error-gate":
					if e.Method == "agui.discovery" || e.Kind == "plugin.problem" {
						return api.Decision{Refuse: true}, nil
					}
				case "release-gate":
					if e.Method == "agui.event" && bytes.Contains(e.Data, []byte(`"type":"TOOL_CALL_START"`)) {
						f.pause("beforeRelease")
					}
				case "approval-redacted":
					if e.Method == "agui.interrupt" {
						e.Data = bytes.ReplaceAll(e.Data, []byte("dispatch-blue"), []byte("redacted"))
					}
				case "state-and-gate":
					if e.Method == "agui.snapshot" && b.Recipient == "sibling" || e.Kind == "plugin.kit.kit.hidden" || e.Method == "agui.event" && bytes.Contains(e.Data, []byte(`"value":3`)) {
						return api.Decision{Refuse: true}, nil
					}
					if e.Kind == "history.added" || e.Kind == "model.delta" {
						e.Data = bytes.ReplaceAll(e.Data, []byte("kit-hidden-output-sentinel"), []byte("Gated text."))
					}
				case "output-size":
					if e.Method == "agui.snapshot" && b.Recipient == "sibling" {
						e.Data = api.JSON(map[string]string{"snapshot": strings.Repeat("x", wswire.MaxFrame)})
					}
				}
				b.Events[i] = e
			}
			return api.Decision{Value: b}, nil
		})
	}}
}

func (f *agFixture) evidence(id string) map[string]any {
	spans := []any{}
	for _, s := range f.spans.Ended() {
		attrs := map[string]any{}
		for _, a := range s.Attributes() {
			attrs[string(a.Key)] = a.Value.AsInterface()
		}
		if attrs["gen_ai.conversation.id"] != id {
			continue
		}
		links := []any{}
		for _, l := range s.Links() {
			links = append(links, map[string]string{"traceId": l.SpanContext.TraceID().String(), "spanId": l.SpanContext.SpanID().String()})
		}
		spans = append(spans, map[string]any{"name": s.Name(), "spanId": s.SpanContext().SpanID().String(), "traceId": s.SpanContext().TraceID().String(), "parentSpanId": s.Parent().SpanID().String(), "attributes": attrs, "links": links})
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return map[string]any{"counter": len(lines[int](filepath.Join(f.dir, "counter"))), "project": f.Project, "spans": spans, "batches": lines[[]json.RawMessage](filepath.Join(f.dir, id+".batches")), "dispatches": lines[string](filepath.Join(f.dir, id+".handoffs")), "model": lines[json.RawMessage](os.Getenv("MODULAR_AGENT_SCRIPT_LOG")), "warnings": slices.Clone(f.warnings), "erasure": map[string]any{"outOfReach": f.erasure.OutOfReach}}
}
func (f *agFixture) control(ctx context.Context, op, id, name string, ms int64) (any, error) {
	if op == "tls" && f.Name == "tls" {
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(f.dir), "tls-client"))
		return json.RawMessage(raw), err
	}
	if id == "" || filepath.Base(id) != id || strings.ContainsAny(id, ".\\") {
		return nil, errors.New("invalid thread")
	}
	ctx = api.AsActor(ctx, "kit-owner")
	switch op {
	case "inspect":
		if f.Name == "trace" {
			if _, err := f.host.Wait(ctx, id); err != nil {
				return nil, err
			}
		}
		return f.evidence(id), nil
	case "advance":
		f.clock.advance(ms)
		_, err := f.host.Wait(ctx, id)
		return struct{}{}, err
	case "release":
		f.signal("release:beforeRelease")
	case "barrier":
		if name == "presenceLost" {
			_, err := f.host.Wait(ctx, id)
			return struct{}{}, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-f.edge(name):
		}
	case "revoke":
		return struct{}{}, f.host.Grant(ctx, id, api.Actor{ID: "kit-owner", Kind: "user", Rights: slices.DeleteFunc(slices.Clone(api.Rights), func(s string) bool { return s == "tools" })})
	case "move", "erase":
		if _, err := f.host.Wait(ctx, id); err != nil {
			return nil, err
		}
		s, err := f.host.Snapshot(id)
		if err != nil {
			return nil, err
		}
		for _, e := range s.Entries {
			if e.Kind == "input.accepted" {
				if op == "move" {
					return struct{}{}, f.host.Move(ctx, id, e.Parent, false)
				}
				targets := []string{e.ID}
				for _, r := range s.Entries {
					if r.Kind == "model" || r.Kind == "input" {
						targets = append(targets, r.ID)
					}
				}
				report, err := f.host.(interface {
					EraseDetails(context.Context, string, []string) (api.ProviderErasure, error)
				}).EraseDetails(ctx, id, targets)
				f.mu.Lock()
				f.erasure = report
				f.mu.Unlock()
				return struct{}{}, err
			}
		}
		return nil, errors.New("no input")
	default:
		return nil, errors.New("unknown operation")
	}
	return struct{}{}, nil
}

func TestAGUIKitProgram(t *testing.T) {
	path := os.Getenv("MA_AGUI_FIXTURE")
	if path == "" {
		t.Skip("run through conformance/agui")
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	must(err)
	f := agFixture{dir: os.Getenv("MODULAR_AGENT_DATA_DIR"), edges: map[string]chan struct{}{}, warnings: []string{}}
	must(json.Unmarshal(raw, &f))
	f.clock.install()
	f.spans = tracetest.NewSpanRecorder()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()), sdktrace.WithSpanProcessor(f.spans)))
	raw, err = os.ReadFile(os.Getenv("MODULAR_AGENT_SCRIPT"))
	must(err)
	var replies []modulartest.Reply
	must(json.Unmarshal(raw, &replies))
	provider := modulartest.ScriptedProvider(replies)
	request := provider.Request
	provider.Request = func(ctx context.Context, ref modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
		messages := []any{}
		for _, m := range r.Messages {
			entry := map[string]any{"role": m.Role, "text": m.Content.Text()}
			switch m.Role {
			case "assistant":
				calls := []any{}
				for _, part := range m.Content {
					if part.Type == "toolCall" {
						calls = append(calls, map[string]any{"name": part.Fields["name"], "input": part.Fields["arguments"]})
					}
				}
				entry["toolCalls"] = calls
			case "toolResult":
				entry["name"] = m.ToolName
			case "user":
			default:
				continue
			}
			messages = append(messages, entry)
		}
		tools := []string{}
		for _, d := range r.Tools {
			tools = append(tools, d.Name)
		}
		file, err := os.OpenFile(os.Getenv("MODULAR_AGENT_SCRIPT_LOG"), os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0600)
		if err != nil {
			return modular.AssistantMessage{}, err
		}
		err = errors.Join(json.NewEncoder(file).Encode(map[string]any{"system": r.SystemPrompt, "messages": messages, "tools": tools}), file.Close())
		if err != nil {
			return modular.AssistantMessage{}, err
		}
		reply, err := request(ctx, ref, r, pc)
		if f.Name == "state-and-gate" {
			reply.ProviderData = api.JSON("provider-only-sentinel")
		}
		return reply, err
	}
	f.Offer.Callers = []string{"model"}
	if strings.HasPrefix(f.Name, "waiting-mixed-") {
		f.Offer.Hints.ReadOnly = true
	}
	store, err := history.New(filepath.Join(f.dir, "history"))
	must(err)
	mode := modular.Durable
	if f.Name == "crash-before-handoff" {
		mode = modular.Kept
	}
	opts := []modular.Option{modular.WithPluginHost(true), modular.WithProject(f.Project), modular.WithDataDir(f.dir), modular.WithHistory(modular.NewHistoryStore(&kitStore{store, &f}, true, true)), modular.WithEnvironment(modulartest.MemoryEnvironment()), modular.WithDurability(mode), modular.WithProvider(provider), modular.WithModel(modulartest.ScriptedModel), modular.WithSeveralActors(true), modular.WithTenants(map[string]modular.Tenant{"test": {Rights: api.Rights}}), modular.WithInterfaceTools(modular.InterfaceToolSource{SourceID: "kit", ActorID: "kit-owner", RouteID: "kit-primary", ResultTimeoutMS: 60000, Tools: []modular.ToolDefinition{f.Offer}})}
	if strings.HasPrefix(f.Name, "waiting-") {
		v := "untilDeadline"
		if f.Name == "waiting-live" {
			v = "live"
		}
		policy := modular.All
		if strings.HasPrefix(f.Name, "waiting-mixed-") {
			policy = modular.Ask
		}
		opts = append(opts, modular.WithMaxApprovalWaitMs(5000), modular.WithLateAnswersStartTurns(true), modular.WithApproval(policy), modular.WithApprovalCoversNested(true), modular.WithSettings(modular.Settings{"approvalWait": v}), modular.WithTool(modular.NewTool("bump", "Increment the counter.", func(ctx context.Context, _ struct {
			Hold bool   `json:"hold"`
			Note string `json:"note"`
		}, tc *modular.ToolContext) (string, error) {
			if f.Name == "waiting-restart" {
				r, err := tc.Tools.Call(ctx, "increment", struct{}{})
				return r.Text(), err
			}
			return "counted", f.log("counter", 1)
		})))
		if f.Name == "waiting-restart" {
			opts = append(opts, modular.WithTool(modular.NewTool("increment", "Increment the counter.", func(context.Context, struct{}, *modular.ToolContext) (string, error) {
				return "counted", f.log("counter", 1)
			}, modular.Callers("plugin"))))
		}
	}
	a, err := modular.New(t.Context(), opts...)
	must(err)
	port, load := a.AGUIFixturePorts()
	f.host = port
	must(load(f.parts()))
	must(load(api.Plugin{Name: "other", Setup: func(api.API) error { return nil }}))
	opt := modular.ServeAGUIOptions{Listen: os.Getenv("MA_AGUI_LISTEN"), Tenant: "test", ACP: true, JoinOnOpen: new(true), TraceStateKeys: []string{"kit"}, Warn: func(s string) { f.mu.Lock(); defer f.mu.Unlock(); f.warnings = append(f.warnings, s) }}
	if f.Name == "state-and-gate" {
		opt.StatePlugin = "kit"
		opt.CurrentState = func(context.Context, string) (string, json.RawMessage, error) {
			return "0", json.RawMessage(`{"counter":0}`), nil
		}
		opt.RawSources = map[string]string{"kit": "kit"}
	}
	if f.Name == "tls" {
		base := filepath.Dir(path)
		opt.TLS = &modular.TLSOptions{CertFile: filepath.Join(base, "tls-cert"), KeyFile: filepath.Join(base, "tls-key"), ClientCAFile: filepath.Join(base, "tls-ca")}
	}
	for role, file := range f.TokenFiles {
		p := modular.ACPActor{TokenFile: file, ClientID: role, Actor: api.Actor{ID: "kit-owner", Kind: "user", Rights: slices.Clone(api.Rights)}, Projects: []string{f.Project}, Tenants: []string{"test"}}
		switch role {
		case "owner", "rotated":
			p.ClientID, p.TrustTrace = "kit-primary", true
		case "watch":
			p.Actor.Rights = []string{"watch"}
		case "foreign":
			p.Actor.ID = "kit-foreign"
			p.Actor.Rights = []string{"watch", "input", "answer", "approve", "tools"}
		case "tenant":
			p.Tenants = []string{"other"}
		case "project":
			p.Projects = []string{filepath.Dir(f.Project)}
		}
		opt.Actors = append(opt.Actors, p)
	}
	service, err := a.AGUIFixtureListener(t.Context(), opt, func(w http.ResponseWriter) http.ResponseWriter { return &kitWriter{ResponseWriter: w, f: &f} })
	must(err)
	defer service.Close()
	secret, err := wswire.ReadToken(f.ControlTokenFile)
	must(err)
	want := sha256.Sum256([]byte("Bearer " + secret))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	ctrl := http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		digest := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		if subtle.ConstantTimeCompare(want[:], digest[:]) != 1 || r.URL.Path != "/fixture" || r.Method != "POST" {
			w.WriteHeader(403)
			return
		}
		var req struct {
			Operation, ThreadID, Name, Client, Mode string
			Milliseconds                            int64
		}
		if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req) != nil {
			w.WriteHeader(400)
			return
		}
		if req.Operation == "approvalGate" && req.Client == "kit-primary" && req.Mode == "redact" {
			f.mu.Lock()
			f.redactClient = req.Client
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(struct{}{})
			return
		}
		v, err := f.control(r.Context(), req.Operation, req.ThreadID, req.Name, req.Milliseconds)
		if err != nil {
			fmt.Fprintf(os.Stderr, "control %s: %v\n", req.Operation, err)
			w.WriteHeader(409)
			return
		}
		_ = json.NewEncoder(w).Encode(v)
	})}
	go ctrl.Serve(ln)
	must(json.NewEncoder(os.Stdout).Encode(map[string]string{"url": service.URL, "control": "http://" + ln.Addr().String() + "/fixture"}))
	<-service.Done()
}

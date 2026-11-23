package modular

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
)

// ServeAGUIOptions selects one project (the serving Agent's) and creation tenant.
// Use ClientID on each ACPActor. Rotated tokens may share a client only under the same policy.
type ServeAGUIOptions struct {
	Listen  string
	Actors  []ACPActor
	TLS     *TLSOptions
	Tenant  string
	ACP     bool
	Origins []string
	// TraceStateKeys permits these vendor keys from TrustTrace tokens on local work only.
	TraceStateKeys []string
	// JoinOnOpen permits first-time admission of an in-scope actor to an existing multi-actor session.
	JoinOnOpen *bool
	Warn       func(field string)
	// StatePlugin owns the single shared document. CurrentState reads its current revision and snapshot.
	StatePlugin  string
	CurrentState func(context.Context, string) (string, json.RawMessage, error)
	// RawSources maps an explicitly configured plugin to the source for its modular-agent.agui.raw events.
	RawSources map[string]string
}

type agPrincipal struct {
	acpinterface.Principal
	client string
	tools  map[string]api.Tool
}
type agServer struct {
	a       *Agent
	opt     ServeAGUIOptions
	mu      sync.Mutex
	states  map[[2]string]*agClient
	threads map[string]bool // HTTP threads keep their writer when an ACP connection goes away.
	openMu  sync.Mutex
	pageKey [32]byte
}
type agClient struct {
	mu        sync.Mutex
	snapshots sync.Mutex
	cursor    string
	digest    [sha256.Size]byte
	active    bool
	runs      [][32]byte
	presence  *agPresence
	tools     *InterfaceToolConnection // retained only across a live in-turn interrupt
	delivered map[string]agDelivery
}
type agPresence struct {
	ctx    context.Context
	detach map[string]func()
}
type agDelivery struct {
	presence *agPresence
	digest   [32]byte
}
type agQuestion struct {
	q        api.Question
	presence *agPresence
	view     agObject
}
type agRequest struct {
	*agServer
	*agPrincipal
	ctx    context.Context
	id     string
	state  *agClient
	rights []string
	w      http.ResponseWriter
}

// ServeAGUI starts the HTTP/SSE listener. Set ACP to serve ACP upgrades on its root path.
func (a *Agent) ServeAGUI(ctx context.Context, opt ServeAGUIOptions) (*Service, error) {
	return a.serveAGUI(ctx, opt, nil)
}

func (a *Agent) serveAGUI(ctx context.Context, opt ServeAGUIOptions, wrap func(http.ResponseWriter) http.ResponseWriter) (*Service, error) {
	bad := func(s string) (*Service, error) { return nil, &Error{Code: InvalidComposition, Message: s} }
	if opt.Listen == "" || len(opt.Actors) == 0 {
		return bad("AG-UI requires Listen and Actors")
	}
	if opt.Tenant != "" && !a.tenants {
		return bad("AG-UI creation tenant requires a tenant-aware agent")
	}
	for _, o := range opt.Origins {
		u, e := url.Parse(o)
		if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && u.Scheme != "http") {
			return bad("invalid AG-UI origin")
		}
	}
	if (opt.StatePlugin == "") != (opt.CurrentState == nil) {
		return bad("AG-UI state needs a plugin name and snapshot reader")
	}
	if opt.JoinOnOpen == nil {
		singleLocal := true
		for _, p := range opt.Actors {
			if p.Actor.ID != localActor {
				singleLocal = false
			}
		}
		opt.JoinOnOpen = &singleLocal
	}
	srv := &agServer{a: a, opt: opt, states: map[[2]string]*agClient{}, threads: map[string]bool{}}
	rand.Read(srv.pageKey[:])
	tokens := map[string]agPrincipal{}
	clients := map[string]acpinterface.Principal{}
	for _, e := range opt.Actors {
		if !validACPActor(e.Actor) || e.ClientID == "" || !utf8.ValidString(e.ClientID) {
			return bad("invalid AG-UI actor or client ID")
		}
		p, err := acpPolicy(e.Projects, e.Tenants, append([]string{}, e.Actor.Rights...), e.Represents)
		if err != nil {
			return nil, err
		}
		p.Actor.ID, p.Actor.Kind, p.TrustTrace = e.Actor.ID, e.Actor.Kind, e.TrustTrace
		if prev, ok := clients[e.ClientID]; ok && !reflect.DeepEqual(prev, p) {
			return bad("client ID has conflicting identity or scope")
		}
		clients[e.ClientID] = p
		principal := agPrincipal{Principal: p, client: e.ClientID, tools: map[string]api.Tool{}}
		for _, src := range a.interfaceSources {
			if src.Route != e.ClientID {
				continue
			}
			if src.Actor != p.Actor.ID {
				return bad("Interface executor route matches another actor")
			}
			for _, def := range src.Definitions {
				if len(def.Output) == 0 {
					principal.tools[def.Name] = def
				}
			}
		}
		token, err := wswire.ReadToken(e.TokenFile)
		if err != nil {
			return nil, appError(err, InvalidComposition)
		}
		if _, dup := tokens[token]; dup {
			return bad("duplicate AG-UI bearer token")
		}
		tokens[token] = principal
	}
	var ws func(context.Context, *wswire.Conn, agPrincipal)
	if opt.ACP {
		iface, err := a.acpInterface()
		if err != nil {
			return nil, err
		}
		decl, projects := a.acpResources(ServeACPOptions{})
		projects = acpinterface.ShareCompositions(projects)
		projects.RetainWriter = func(id string) bool { srv.mu.Lock(); defer srv.mu.Unlock(); return srv.threads[id] }
		ws = func(ctx context.Context, c *wswire.Conn, p agPrincipal) {
			c.EnableACPControl(0)
			_ = iface.ServePrincipal(ctx, c, c, decl, projects, p.Principal)
		}
	}
	routes := srv.http
	if wrap != nil {
		routes = func(w http.ResponseWriter, r *http.Request, p *agPrincipal) { srv.http(wrap(w), r, p) }
	}
	service, err := wswire.ListenAgent(ctx, opt.Listen, opt.TLS, wswire.ACP, tokens, ws, routes)
	return service, appError(err, InvalidParams)
}
func (s *agServer) warn(field string) {
	if s.opt.Warn != nil {
		s.opt.Warn(field)
	} else {
		log.Printf("AG-UI ignored or stripped field %q", field)
	}
}
func (s *agServer) http(w http.ResponseWriter, r *http.Request, p *agPrincipal) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == "OPTIONS" && len(r.Header.Values("Origin")) == 1 && slices.Contains(s.opt.Origins, r.Header.Get("Origin")) {
		w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MA-History-Cursor, Traceparent, Tracestate")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if p == nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		agHTTPError(w, agCode("unauthenticated"))
		return
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if origins := r.Header.Values("Origin"); len(origins) > 0 {
		if len(origins) != 1 || origins[0] != scheme+"://"+r.Host && !slices.Contains(s.opt.Origins, origins[0]) {
			agHTTPError(w, denied)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origins[0])
		w.Header().Set("Vary", "Origin")
	}
	listing := r.Method == "GET" && r.URL.EscapedPath() == "/agui/v1/threads"
	if !listing && r.URL.RawQuery != "" || r.URL.User != nil {
		agHTTPError(w, invalid)
		return
	}
	q := &agRequest{agServer: s, agPrincipal: p, ctx: api.AsActor(r.Context(), p.Actor.ID), rights: p.Actor.Rights, w: w}
	q.ctx = api.WithSessionScope(api.WithConnectionRights(q.ctx, &q.rights), q.scope)
	if err := q.serve(r); err != nil {
		status, code := agStatus(err)
		if _, gateErr := q.encode("agui.error", agObject{"code": code}); gateErr != nil && status != 404 {
			err = withheld
		}
		agHTTPError(w, err)
	}
}
func agStatus(err error) (int, agCode) {
	var c agCode
	if !errors.As(err, &c) {
		switch {
		case errors.Is(err, api.ErrResultTooLarge), errors.Is(err, api.ErrOutputOverflow):
			c = tooLarge
		case errors.Is(err, api.ErrOutputWithheld):
			c = withheld
		case errors.Is(err, api.ErrCapacity):
			c = "busy"
		case errors.Is(err, api.ErrAuthority), errors.Is(err, api.ErrTenantForbidden), errors.Is(err, api.ErrAnswerAuthority):
			c = denied
		case errors.Is(err, api.ErrInputConflict), errors.Is(err, api.ErrQuestionNotFound):
			c = stale
		case errors.Is(err, api.ErrInvalidAnswer):
			c = invalid
		default:
			c = unavailable
		}
	}
	switch c {
	case invalid, "not_supported":
		return 400, c
	case "unauthenticated":
		return 401, c
	case denied, withheld:
		return 403, c
	case missing:
		return 404, c
	case stale, "cursor_expired":
		return 409, c
	case tooLarge:
		return 413, c
	default:
		return 503, c
	}
}
func agHTTPError(w http.ResponseWriter, err error) {
	status, code := agStatus(err)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(api.JSON(agObject{"code": code}))
}
func (q *agRequest) scope(project, tenant string) bool {
	return project == q.a.project && (q.Projects == nil || slices.Contains(q.Projects, project)) && (q.Tenants == nil && tenant == "" || slices.Contains(q.Tenants, tenant))
}
func (q *agRequest) narrowed(tenant string, limit *[]string) Actor {
	p := q.Actor
	if tenant != "" {
		t := q.a.tenantGrants[tenant]
		p.Rights = *api.IntersectConnectionRights(&p.Rights, &t.Rights)
	}
	if limit != nil {
		p.Rights = slices.DeleteFunc(slices.Clone(p.Rights), func(s string) bool { return s != "administer" && !slices.Contains(*limit, s) })
	}
	return p
}
func (q *agRequest) allowed(right string) bool {
	return slices.Contains(q.rights, right) && q.a.a.Authorize(q.id, q.Actor.ID, right)
}

type agHost interface {
	NewForHost(context.Context, string, string, api.Actor) (string, error)
	OpenForHost(context.Context, string, api.Actor) error
	DiscoverForHost(api.Session, api.Actor) bool
	JoinHost(string, api.Actor) error
	ViewForOutput(context.Context, string) (api.Session, error)
	OutputValueFor(context.Context, string, api.Event) (api.Event, error)
	ErasureEpoch(string) (int, error)
	SubscribeOutput(func(api.Event) string, func(api.Event)) func()
	WatchContinuation(string, string) (<-chan struct{}, func(), error)
	SessionInterruption(string) (<-chan struct{}, <-chan struct{}, error)
}

func (q *agRequest) member(s api.Session) bool {
	if !q.scope(s.Project, s.Tenant) {
		return false
	}
	_, recorded := s.Actors[q.Actor.ID]
	if !recorded && q.Actor.ID != s.Actor && (!*q.opt.JoinOnOpen || !q.a.severalActors) {
		return false
	}
	return q.host().DiscoverForHost(s, q.Actor)
}
func (q *agRequest) host() agHost { return q.a.a.(agHost) }
func (q *agRequest) attach(id string) error {
	if id == "" || !slices.Contains(q.rights, "watch") {
		return missing
	}
	q.id = id
	q.openMu.Lock()
	releaseOpen := sync.OnceFunc(q.openMu.Unlock)
	defer releaseOpen()
	snap, err := q.a.a.Snapshot(id)
	if err != nil {
		if errors.Is(err, api.ErrErasureUnavailable) {
			return err
		}
		list, err := q.a.a.List(q.a.project)
		if err != nil {
			return err
		}
		at := slices.IndexFunc(list, func(s api.Session) bool { return s.ID == id })
		if at < 0 {
			return missing
		}
		snap = list[at]
		if !q.member(snap) {
			return missing
		}
		if err := q.host().OpenForHost(q.ctx, id, q.narrowed(snap.Tenant, snap.Limit)); err != nil {
			return err
		}
		releaseOpen() // Other clients may attach and answer while recovery runs.
		if _, err := q.a.a.Wait(q.ctx, id); err != nil {
			return err
		}
	} else {
		if !q.member(snap) {
			return missing
		}
		grant := q.narrowed(snap.Tenant, snap.Limit)
		if err := q.host().JoinHost(id, grant); err != nil {
			return err
		}
	}
	if a, ok := snap.Actors[q.Actor.ID]; ok {
		q.rights = *api.IntersectConnectionRights(&q.rights, &a.Rights)
	}
	if !q.allowed("watch") {
		return missing
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.threads[id] = true
	key := [2]string{id, q.client}
	q.state = q.states[key]
	if q.state == nil {
		if len(q.states) >= 4096 {
			return agCode("busy")
		}
		q.state = &agClient{}
		q.states[key] = q.state
	}
	return nil
}
func (q *agRequest) epoch() (int, error) {
	if q.id != "" {
		snap, err := q.a.a.Snapshot(q.id)
		if err != nil {
			return 0, err
		}
		if !q.scope(snap.Project, snap.Tenant) || !q.allowed("watch") {
			return 0, missing
		}
	}
	return q.host().ErasureEpoch(q.id)
}
func (q *agRequest) fresh(epoch int) error {
	v, err := q.epoch()
	if err != nil {
		return err
	}
	if v != epoch {
		return stale
	}
	return q.ctx.Err()
}
func (q *agRequest) gate(e api.Event) (api.Event, error) {
	e.Session = q.id
	return q.host().OutputValueFor(q.ctx, q.client, e)
}

// A changed required identity or envelope cannot become a different operation.
func (q *agRequest) encode(method string, v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, withheld
	}
	if len(b) > wswire.MaxFrame {
		return nil, tooLarge
	}
	gated, err := q.gate(api.Event{Kind: "interface.answer", Method: method, Data: b})
	if err != nil {
		return nil, err
	}
	if len(gated.Data) > wswire.MaxFrame {
		return nil, tooLarge
	}
	if !agSameBytes(b, gated.Data) {
		return nil, withheld
	}
	return b, nil
}
func (q *agRequest) jsonReply(status int, method string, v any) error {
	epoch, err := q.epoch()
	if err != nil {
		return err
	}
	b, err := q.encode(method, v)
	if err != nil {
		return err
	}
	if err = q.fresh(epoch); err != nil {
		return err
	}
	q.w.Header().Set("Content-Type", "application/json")
	q.w.WriteHeader(status)
	_, _ = q.w.Write(b)
	return nil
}
func (q *agRequest) serve(r *http.Request) error {
	const base = "/agui/v1"
	path := r.URL.EscapedPath()
	switch {
	case r.Method == "GET" && path == base:
		return q.jsonReply(200, "agui.discovery", agObject{"binding": "modular-agent-agui/1", "protocolVersion": "1.0", "declaration": q.a.Declaration()})
	case r.Method == "GET" && path == base+"/threads":
		return q.listThreads(r.URL.RawQuery)
	case r.Method == "POST" && path == base+"/threads":
		v, err := agRead(r)
		if err != nil {
			return err
		}
		if len(v) != 0 {
			return invalid
		}
		if !q.scope(q.a.project, q.opt.Tenant) || !slices.Contains(q.rights, "watch") || !slices.Contains(q.rights, "input") {
			return denied
		}
		actor := q.narrowed(q.opt.Tenant, nil)
		if !slices.Contains(actor.Rights, "input") || !slices.Contains(actor.Rights, "watch") {
			return denied
		}
		id, err := q.host().NewForHost(q.ctx, q.a.project, q.opt.Tenant, actor)
		if err != nil {
			return err
		}
		q.id = id
		q.mu.Lock()
		q.threads[id] = true
		q.mu.Unlock()
		if !q.allowed("watch") || !q.allowed("input") {
			_ = q.a.a.StopSession(id)
			return denied
		}
		return q.jsonReply(201, "agui.create", agObject{"threadId": id, "declaration": q.a.Declaration()})
	case r.Method == "GET" && strings.HasPrefix(path, base+"/threads/"):
		id, pres := strings.CutSuffix(strings.TrimPrefix(path, base+"/threads/"), "/presence")
		if strings.ContainsAny(id, "/%") {
			return missing
		}
		if err := q.attach(id); err != nil {
			return err
		}
		if pres {
			return q.present()
		}
		return q.snapshotHTTP()
	case r.Method == "POST" && path == base+"/run":
		v, err := agRead(r)
		if err != nil {
			return err
		}
		in, err := agParse(v, q.warn)
		if err != nil {
			return err
		}
		if err = q.attach(in.thread); err != nil {
			return err
		}
		return q.run(r, in)
	}
	return missing
}
func (q *agRequest) present() error {
	s := q.state
	s.mu.Lock()
	if s.presence != nil {
		s.mu.Unlock()
		return stale
	}
	p := &agPresence{ctx: q.ctx}
	s.presence = p
	defer q.a.q.manager().ConnectClient(q.id, q.Actor.ID, q.client)()
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.disconnect()
		s.presence = nil
		for id, v := range s.delivered {
			if v.presence == p {
				delete(s.delivered, id)
			}
		}
		if s.tools != nil && !s.active {
			s.tools.Close()
			s.tools = nil
		}
		s.mu.Unlock()
	}()
	// Presence makes approvals eligible only while there is a run able to deliver them.
	q.w.Header().Set("Content-Type", "text/event-stream")
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		if _, err := q.epoch(); err != nil {
			return nil
		}
		if _, err := io.WriteString(q.w, ": present\n\n"); err != nil {
			return nil
		}
		if http.NewResponseController(q.w).Flush() != nil {
			return nil
		}
		select {
		case <-q.ctx.Done():
			return nil
		case <-t.C:
		}
	}
}
func (q *agRequest) frame(b []byte) error {
	ctrl := http.NewResponseController(q.w)
	_ = ctrl.SetWriteDeadline(time.Now().Add(5 * time.Second))
	defer ctrl.SetWriteDeadline(time.Time{})
	if _, err := fmt.Fprintf(q.w, "data: %s\n\n", b); err != nil {
		return err
	}
	return http.NewResponseController(q.w).Flush()
}

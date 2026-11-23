package historyhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"go.opentelemetry.io/otel/trace"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

type Client struct {
	wire        *servicehttp.Client
	owner       string
	ctx         context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	leases      []*lease
	backend     operations
	localTTL    time.Duration
	coordinated atomic.Bool
}
type lease struct {
	c          *Client
	id, token  string
	mu         sync.Mutex
	closed     bool
	lost       chan struct{}
	lose       sync.Once
	cutoff     atomic.Int64
	revoked    atomic.Pointer[<-chan struct{}]
	stop, done chan struct{}
	known      map[string]json.RawMessage
}

func TokenFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("history token file unavailable")
	}
	token := strings.Trim(string(b), " \t\r\n")
	head := strings.TrimRight(token, "=")
	if head == "" || strings.ContainsFunc(head, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~+/", r))
	}) {
		return "", errors.New("invalid history bearer token")
	}
	return token, nil
}

func NewClient(wire *servicehttp.Client) *Client {
	c := newClient(httpBackend{wire})
	c.wire = wire
	return c
}

// NewLocalClient adapts a local binding-shaped store without an HTTP server.
func NewLocalClient(backend Backend) (*Client, error) {
	ttl := backend.LeaseTTL()
	if ttl <= 0 || ttl%time.Millisecond != 0 {
		return nil, errors.New("history store lease TTL must be a positive number of milliseconds")
	}
	c := newClient(backend)
	c.localTTL = ttl
	return c, nil
}

func newClient(backend operations) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{backend: backend, owner: api.ID(), ctx: ctx, cancel: cancel}
}
func escape(id string) string { return strings.ReplaceAll(url.QueryEscape(id), "+", "%20") }
func path(id string) string   { return "/v1/sessions/" + escape(id) }

// Both Linux CLOCK_BOOTTIME and macOS CLOCK_MONOTONIC advance during suspension.
func leaseClock() int64 {
	var t unix.Timespec
	if unix.ClockGettime(leaseClockID, &t) != nil {
		panic("history writer requires a suspend-aware clock")
	}
	return t.Nano()
}

// Verify checks the history binding before the launcher exposes the agent.
func (c *Client) Verify() error {
	if c.wire == nil {
		return nil // NewLocalClient validated the local declaration.
	}
	out, err := (httpBackend{c.wire}).info(c.ctx)
	if err != nil {
		return err
	}
	if out.Binding != Binding || leaseDuration(out.TTLMS) <= 0 || out.TTLMS != float64(leaseDuration(out.TTLMS).Milliseconds()) {
		return errors.New("unsupported history binding or invalid history TTL")
	}
	version, ok := count(out.PendingErasure)
	c.coordinated.Store(ok && version == 1)
	return nil
}

func (c *Client) read(id string, contexts ...context.Context) (document, error) {
	ctx := operationContext(c.ctx, contexts)
	var d document
	after := ""
	seen := map[string]bool{}
	for {
		page, err := c.backend.Read(ctx, id, after, defaultPageLimit)
		if err != nil {
			return document{}, err
		}
		d.Session = page.Session
		d.Entries = append(d.Entries, page.Entries...)
		if page.Next == "" {
			return d, nil
		}
		if seen[page.Next] {
			return document{}, errors.New("history cursor did not advance")
		}
		seen[page.Next] = true
		after = page.Next
	}
}
func (c *Client) Acquire(id string) (api.Lease, error) { return c.AcquireContext(c.ctx, id) }

func (c *Client) AcquireContext(ctx context.Context, id string) (api.Lease, error) {
	return c.acquire(id, true, ctx)
}

func (c *Client) TryAcquire(id string) (api.Lease, error) {
	return c.acquire(id, false)
}

func (c *Client) acquire(id string, wait bool, contexts ...context.Context) (api.Lease, error) {
	l := &lease{c: c, id: id, lost: make(chan struct{})}
	if err := l.acquire(wait, contexts...); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return c.track(l)
}

// AcquireNew reserves a local handle without contacting the store. The first
// Save checks the append size before sending PUT or acquiring a writer.
func (c *Client) AcquireNew(id string) (api.Lease, error) {
	return c.track(&lease{c: c, id: id, lost: make(chan struct{})})
}

func (c *Client) track(l *lease) (api.Lease, error) {
	c.mu.Lock()
	if err := c.ctx.Err(); err != nil {
		c.mu.Unlock()
		_ = l.Close()
		return nil, err
	}
	c.leases = append(c.leases, l)
	c.mu.Unlock()
	return l, nil
}

type leaseReply struct {
	Grant
	sent int64
}

func (c *Client) takeLease(id string, wait bool, contexts ...context.Context) (_ leaseReply, errOut error) {
	operation := telemetry.Session(operationContext(c.ctx, contexts), id)
	var waitSpan trace.Span
	defer func() {
		if waitSpan != nil {
			telemetry.Finish(waitSpan, errOut)
		}
	}()
	var deadline time.Time
	var lastHeld error
	ambiguous := false
	for {
		out := leaseReply{sent: leaseClock()}
		ctx := operation
		cancel := func() {}
		if !deadline.IsZero() {
			ctx, cancel = context.WithDeadline(ctx, deadline)
		}
		grant, err := c.backend.Acquire(ctx, id, c.owner)
		out.Grant = grant
		canRetry := ctx.Err() == nil
		cancel()
		if err == nil {
			ttl := leaseDuration(out.TTLMS)
			half := int64(ttl / 2)
			if !validLease(out.Lease) || half <= 0 || leaseClock() >= out.sent+half || c.localTTL != 0 && ttl != c.localTTL {
				return leaseReply{}, errors.New("invalid or late history lease response")
			}
			if ambiguous {
				sent := leaseClock()
				ctx, cancel := context.WithTimeout(operation, time.Duration(out.sent+half-sent))
				renewedTTL, err := c.backend.Renew(ctx, id, out.Lease)
				cancel()
				if err != nil || renewedTTL != out.TTLMS || leaseClock() >= min(out.sent+half, sent+half) {
					return leaseReply{}, errors.New("repeated acquire did not establish writer access")
				}
				out.sent = sent
			}
			return out, nil
		}
		if !canRetry && lastHeld != nil && c.ctx.Err() == nil && !time.Now().Before(deadline) {
			return leaseReply{}, lastHeld
		}
		var held *servicehttp.ResponseError
		if !ambiguous && !errors.Is(err, os.ErrNotExist) && !errors.As(err, &held) && canRetry {
			ambiguous = true
			continue
		}
		if !wait || !errors.As(err, &held) || held.Status != http.StatusConflict || held.Code != "held" {
			return leaseReply{}, err
		}
		lastHeld = err
		delay := leaseDuration(held.RetryAfterMS)
		received := time.Now()
		if deadline.IsZero() {
			ttl := c.localTTL
			if c.wire != nil {
				ttl = delay // Older services omit ttlMs.
				if info, e := (httpBackend{c.wire}).info(c.ctx); e == nil && leaseDuration(info.TTLMS) > 0 {
					ttl = leaseDuration(info.TTLMS)
				}
			}
			if ttl <= 0 {
				return leaseReply{}, err
			}
			deadline = received.Add(ttl + time.Second)
			// Older services, including the supplied test service, omit
			// retryAfterMs. Allow one retry after the full advertised TTL.
			if delay <= 0 {
				delay = ttl
			}
		}
		if delay <= 0 {
			return leaseReply{}, err
		}
		next := received.Add(delay)
		if next.After(deadline) {
			return leaseReply{}, err
		}
		if waitSpan == nil {
			operation, waitSpan = telemetry.Start(operation, "modular_agent.capacity.wait", trace.WithAttributes(telemetry.String("modular_agent.capacity.scope", "session")))
		}
		timer := time.NewTimer(time.Until(next))
		select {
		case <-timer.C:
		case <-c.ctx.Done():
			timer.Stop()
			return leaseReply{}, c.ctx.Err()
		}
	}
}

func (l *lease) acquire(wait bool, contexts ...context.Context) error {
	out, err := l.c.takeLease(l.id, wait, contexts...)
	if err != nil {
		return err
	}
	l.token = out.Lease
	l.stop = make(chan struct{})
	l.done = make(chan struct{})
	ttl := leaseDuration(out.TTLMS)
	l.cutoff.Store(out.sent + int64(ttl/2))
	if out.WriterLost != nil {
		l.revoked.Store(&out.WriterLost)
		go func() {
			select {
			case <-out.WriterLost:
				l.fence()
			case <-l.lost:
			}
		}()
	}
	go func() {
		defer close(l.done)
		due := out.sent + int64(ttl/3)
		for {
			t := time.NewTimer(time.Duration(due - leaseClock()))
			select {
			case <-l.stop:
				t.Stop()
				return
			case <-l.c.ctx.Done():
				t.Stop()
				l.fence()
				return
			case <-l.lost:
				t.Stop()
				return
			case <-t.C:
			}
			sent, previous := leaseClock(), l.cutoff.Load()
			if sent >= previous || l.isFenced() {
				l.fence()
				return
			}
			ctx, cancel := context.WithTimeout(l.c.ctx, time.Duration(previous-sent))
			renewedTTL, err := l.c.backend.Renew(ctx, l.id, out.Lease)
			cancel()
			cutoff := sent + int64(ttl/2)
			if err != nil || leaseDuration(renewedTTL) != ttl || leaseClock() >= min(previous, cutoff) {
				l.fence()
				return
			}
			l.cutoff.Store(cutoff)
			due = sent + int64(ttl/3)
		}
	}()
	return nil
}
func leaseDuration(ms float64) time.Duration {
	if ms <= 0 || ms > float64((1<<63-1)/time.Millisecond) {
		return 0
	}
	return time.Duration(ms * float64(time.Millisecond))
}

func (l *lease) CheckWriter() error {
	if revoked := l.revoked.Load(); revoked != nil {
		select {
		case <-*revoked:
			l.fence()
		default:
		}
	}
	cutoff := l.cutoff.Load()
	if l.isFenced() || cutoff != 0 && leaseClock() >= cutoff || l.c.ctx.Err() != nil {
		l.fence()
		return api.ErrWriterLost
	}
	return nil
}

func (l *lease) WriterLost() <-chan struct{} { return l.lost }
func (l *lease) fence()                      { l.lose.Do(func() { close(l.lost) }) }

func (l *lease) isFenced() bool {
	select {
	case <-l.lost:
		return true
	default:
		return false
	}
}
func (l *lease) usable() error {
	if l.closed {
		return errors.New("lease closed")
	}
	return l.CheckWriter()
}
func decodeSession(d document) (api.Session, error) {
	return decodeHistory(d, false)
}

func decodeHistory(d document, physical bool) (api.Session, error) {
	snap := api.Session{Version: 1, ID: d.Session.ID, Project: d.Session.Project, Parent: d.Session.ParentSessionID}
	if origin := d.Session.ForkedFrom; origin != nil {
		snap.ForkedFrom = origin.SessionID + ":" + origin.EntryID
	}
	for _, raw := range d.Entries {
		e, err := portable.ReadEntry(raw)
		if err != nil {
			return api.Session{}, fmt.Errorf("session %q entry %q: %w", snap.ID, entryID(raw), err)
		}
		snap.Entries = append(snap.Entries, e)
	}
	var entries []api.Entry
	if physical {
		entries = slices.Clone(snap.Entries)
	}
	snap = portable.Session(snap)
	if physical {
		snap.Entries = entries
	}
	return snap, nil
}
func (l *lease) Load() (api.Session, error) { return l.LoadContext(l.c.ctx) }

func (l *lease) LoadContext(ctx context.Context) (api.Session, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.usable(); err != nil {
		return api.Session{}, err
	}
	if l.token == "" {
		if err := l.acquire(true, ctx); err != nil {
			return api.Session{}, err
		}
	}
	return l.loadSnapshot(false, ctx)
}

// LoadErasure preserves physical records even when bookkeeping already masks
// their payload in the normal portable view.
func (l *lease) LoadErasure() (api.Session, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.usable(); err != nil {
		return api.Session{}, err
	}
	if l.token == "" {
		return api.Session{}, api.ErrErasureUnavailable
	}
	return l.loadSnapshot(true)
}

func (l *lease) loadSnapshot(physical bool, contexts ...context.Context) (api.Session, error) {
	d, err := l.c.read(l.id, contexts...)
	if err != nil {
		return api.Session{}, err
	}
	snap, err := decodeHistory(d, physical)
	if err != nil {
		return api.Session{}, err
	}
	// Compare future saves against the translated snapshot, not the peer's
	// original JSON. For example, it may omit fields a Go writer includes.
	l.known = make(map[string]json.RawMessage, len(snap.Entries))
	for _, e := range snap.Entries {
		l.known[e.ID] = api.JSON(portable.Entry(e))
	}
	return snap, nil
}
func operationContext(base context.Context, parents []context.Context) context.Context {
	if len(parents) == 0 {
		return base
	}
	return trace.ContextWithSpanContext(base, trace.SpanContextFromContext(parents[0]))
}

func (l *lease) Save(s api.Session) error { return l.SaveContext(l.c.ctx, s) }

func (l *lease) SaveContext(ctx context.Context, s api.Session) error { return l.save(ctx, s, false) }

func (l *lease) SaveErasureRecords(s api.Session) error { return l.save(l.c.ctx, s, true) }

func (l *lease) save(parent context.Context, s api.Session, settling bool) error {
	ctx := trace.ContextWithSpanContext(l.c.ctx, trace.SpanContextFromContext(parent))
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.usable(); err != nil {
		return err
	}
	if s.ID != l.id || s.Version != 1 {
		return errors.New("invalid snapshot")
	}
	if len(s.Entries) == 0 {
		return nil
	}
	var entries []json.RawMessage
	// Count the exact encoding incrementally so a refused fork does not
	// allocate an unbounded contiguous append body.
	token := l.token
	if token == "" {
		token = strings.Repeat("A", maxLeaseBytes)
	}
	size := len(appendBody(token, []json.RawMessage{}))
	for _, e := range s.Entries {
		if e.Session == "" {
			e.Session = s.ID
		}
		encoded := api.JSON(portable.Entry(e))
		if old, ok := l.known[e.ID]; ok {
			if !bytes.Equal(old, encoded) && !equalJSON(old, encoded) {
				return errors.New("history cannot change outside erasure")
			}
			continue
		}
		size += len(encoded)
		if len(entries) > 0 {
			size++ // comma
		}
		if size > appendLimit {
			return api.ErrResultTooLarge
		}
		entries = append(entries, encoded)
	}
	if len(entries) == 0 {
		return nil
	}
	if l.token == "" {
		if l.c.ErasureCoordinated() && s.ForkedFrom != "" {
			if _, err := l.appendRevision(s, entries, false, settling); err != nil {
				return err
			}
		}
		session := Metadata{Project: s.Project, Created: float64(time.Now().UnixMilli()), ParentSessionID: s.Parent}
		if source, entry, ok := strings.Cut(s.ForkedFrom, ":"); ok {
			session.ForkedFrom = &ForkOrigin{SessionID: source, EntryID: entry}
		}
		if err := l.c.backend.Create(ctx, l.id, session); err != nil {
			return err
		}
		if err := l.acquire(false, ctx); err != nil {
			return err
		}
	}
	if l.known == nil {
		if _, err := l.loadSnapshot(false, ctx); err != nil {
			return err
		}
	}
	// An identical initial PUT can recover an already committed batch.
	if len(l.known) != 0 {
		for _, entry := range entries {
			if old, ok := l.known[entryID(entry)]; ok && !equalJSON(old, entry) {
				return errors.New("history cannot change outside erasure")
			}
		}
	}
	var revision string
	if l.c.ErasureCoordinated() {
		var err error
		revision, err = l.appendRevision(s, entries, true, settling)
		if err != nil {
			return err
		}
	}
	if err := l.CheckWriter(); err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, time.Duration(l.cutoff.Load()-leaseClock()))
	defer cancel()
	var err error
	if revision != "" {
		err = l.c.profileCall(writeCtx, "POST", path(l.id)+"/entries", appendBody(l.token, entries), nil, revision)
	} else {
		_, err = l.c.backend.Append(writeCtx, l.id, l.token, entries)
	}
	if err != nil {
		writerLost := l.CheckWriter() != nil
		l.fence()
		var response *servicehttp.ResponseError
		if writerLost || errors.As(err, &response) && response.Code == "lost" {
			return errors.Join(api.ErrWriterLost, err)
		}
		return err
	}
	if err := l.CheckWriter(); err != nil {
		return err
	}
	for _, e := range entries {
		l.known[entryID(e)] = e
	}
	return nil
}
func (c *Client) List(project string) ([]api.Session, error) {
	after := ""
	var sessions []Session
	seen := map[string]bool{}
	for {
		out, err := c.backend.List(c.ctx, project, after, defaultPageLimit)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, out.Sessions...)
		if out.Next == "" {
			break
		}
		if seen[out.Next] {
			return nil, errors.New("history list cursor did not advance")
		}
		seen[out.Next] = true
		after = out.Next
	}
	snaps := []api.Session{}
	for _, session := range sessions {
		d, err := c.read(session.ID)
		if err != nil {
			return nil, err
		}
		snap, err := decodeSession(d)
		if err != nil {
			return nil, err
		}
		snaps = append(snaps, snap)
	}
	return snaps, nil
}
func (c *Client) Erase(ids []string) error {
	// Copy closure is an agent concern, not a service concern.
	all, err := c.List("")
	if err != nil {
		return err
	}
	erased := map[string]bool{}
	kinds := map[string]string{}
	for _, id := range ids {
		erased[id] = true
	}
	for _, s := range all {
		for _, e := range s.Entries {
			if erased[e.ID] && e.AuthorityRecord() {
				return errors.New("authority records cannot be erased")
			}
			kinds[e.ID] = e.Kind
		}
	}
	for changed := true; changed; {
		changed = false
		for _, s := range all {
			for _, e := range s.Entries {
				if erased[e.ID] && e.Kind == "input" {
					for _, source := range e.Copies {
						if (kinds[source] == "input" || kinds[source] == "input.accepted") && !erased[source] {
							erased[source] = true
							changed = true
						}
					}
				}
				if !erased[e.ID] {
					for _, source := range e.Copies {
						if erased[source] {
							erased[e.ID] = true
							changed = true
							break
						}
					}
				}
			}
		}
	}
	type target struct {
		id, token string
		entries   []string
	}
	targets := []target{}
	c.mu.Lock()
	leases := append([]*lease(nil), c.leases...)
	c.mu.Unlock()
	for _, s := range all {
		q := target{id: s.ID}
		for _, e := range s.Entries {
			if erased[e.ID] {
				if !e.AuthorityRecord() {
					q.entries = append(q.entries, e.ID)
				}
			}
		}
		if len(q.entries) == 0 {
			continue
		}
		for _, l := range leases {
			l.mu.Lock()
			if l.id == s.ID && !l.closed && l.CheckWriter() == nil {
				q.token = l.token
			}
			l.mu.Unlock()
		}
		// Preflight every affected session before any destructive request.
		if q.token == "" {
			grant, err := c.backend.Acquire(c.ctx, s.ID, c.owner)
			if err != nil {
				return err
			}
			q.token = grant.Lease
			defer c.backend.Release(context.Background(), q.id, q.token)
		}
		targets = append(targets, q)
	}
	for _, q := range targets {
		if _, err = c.backend.Erase(c.ctx, q.id, q.token, q.entries); err != nil {
			return err
		}
	}
	return nil
}
func (l *lease) Close() error {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	l.fence()
	token := l.token
	if token != "" {
		close(l.stop)
	}
	l.mu.Unlock()
	if token == "" {
		return nil
	}
	<-l.done
	return l.c.backend.Release(context.Background(), l.id, token)
}

// Abort simulates process death without releasing server leases.
func (c *Client) Abort() {
	c.cancel()
	c.mu.Lock()
	ls := append([]*lease(nil), c.leases...)
	c.mu.Unlock()
	for _, l := range ls {
		l.mu.Lock()
		done := l.done
		l.mu.Unlock()
		if done != nil {
			<-done
		}
	}
}
func (c *Client) Close() error {
	c.cancel()
	c.mu.Lock()
	ls := append([]*lease(nil), c.leases...)
	c.mu.Unlock()
	var err error
	for _, l := range ls {
		err = errors.Join(err, l.Close())
	}
	return err
}
func Plugin(wire *servicehttp.Client) api.Plugin {
	c := NewClient(wire)
	return api.Plugin{Name: "history-http", Setup: func(a api.API) error {
		if err := c.Verify(); err != nil {
			return err
		}
		return a.Provide("history", c)
	}, Close: c.Close}
}

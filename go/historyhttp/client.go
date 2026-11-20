package historyhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

type Client struct {
	wire   *servicehttp.Client
	owner  string
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	leases []*lease
}
type lease struct {
	c          *Client
	id, token  string
	mu         sync.Mutex
	closed     bool
	fenced     atomic.Bool
	cutoff     atomic.Int64
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
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{wire: wire, owner: api.ID(), ctx: ctx, cancel: cancel}
}
func escape(id string) string { return strings.ReplaceAll(url.QueryEscape(id), "+", "%20") }
func path(id string) string   { return "/v1/sessions/" + escape(id) }

// CLOCK_BOOTTIME is monotonic and advances while the system is suspended.
func leaseClock() int64 {
	var t unix.Timespec
	if unix.ClockGettime(unix.CLOCK_BOOTTIME, &t) != nil {
		panic("history writer requires a suspend-aware clock")
	}
	return t.Nano()
}

// Verify checks the history binding before the launcher exposes the agent.
func (c *Client) Verify() error {
	var out struct {
		Binding string  `json:"binding"`
		TTL     float64 `json:"ttlMs"`
	}
	if err := c.call(c.ctx, "GET", "/v1", nil, &out); err != nil {
		return err
	}
	if out.Binding != Binding || leaseDuration(out.TTL) <= 0 || out.TTL != float64(leaseDuration(out.TTL).Milliseconds()) {
		return errors.New("unsupported history binding or invalid history TTL")
	}
	return nil
}

func (c *Client) call(ctx context.Context, method, path string, in, out any) error {
	// Every operation in this binding is safe to resend, including body reads.
	return c.wire.CallMethod(ctx, method, path, api.ID(), in, out)
}
func (c *Client) read(id string) (document, error) {
	var d document
	p := path(id)
	seen := map[string]bool{}
	for {
		var page document
		if err := c.call(c.ctx, "GET", p, nil, &page); err != nil {
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
		p = path(id) + "?after=" + escape(page.Next)
	}
}
func (c *Client) Acquire(id string) (api.Lease, error) {
	l := &lease{c: c, id: id}
	if err := l.acquire(true); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return c.track(l)
}

// AcquireNew reserves a local handle without contacting the store. The first
// Save checks the append size before sending PUT or acquiring a writer.
func (c *Client) AcquireNew(id string) (api.Lease, error) {
	return c.track(&lease{c: c, id: id})
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
	Lease string  `json:"lease"`
	TTL   float64 `json:"ttlMs"`
	sent  int64
}

func (c *Client) takeLease(id string, wait bool) (leaseReply, error) {
	var deadline time.Time
	var lastHeld error
	ambiguous := false
	for {
		out := leaseReply{sent: leaseClock()}
		ctx := c.ctx
		cancel := func() {}
		if !deadline.IsZero() {
			ctx, cancel = context.WithDeadline(ctx, deadline)
		}
		err := c.wire.CallMethod(ctx, "POST", path(id)+"/lease", "", map[string]string{"owner": c.owner}, &out)
		canRetry := ctx.Err() == nil
		cancel()
		if err == nil {
			half := int64(leaseDuration(out.TTL) / 2)
			if !validLease(out.Lease) || half <= 0 || leaseClock() >= out.sent+half {
				return leaseReply{}, errors.New("invalid or late history lease response")
			}
			if ambiguous {
				sent := leaseClock()
				ctx, cancel := context.WithTimeout(c.ctx, time.Duration(out.sent+half-sent))
				var renewal leaseReply
				err := c.wire.CallMethod(ctx, "POST", path(id)+"/lease/"+escape(out.Lease)+"/renew", "", nil, &renewal)
				cancel()
				if err != nil || renewal.TTL != out.TTL || leaseClock() >= min(out.sent+half, sent+half) {
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
			var info leaseReply
			ttl := delay // GET /v1 is allowed to omit ttlMs.
			if e := c.call(c.ctx, "GET", "/v1", nil, &info); e == nil && leaseDuration(info.TTL) > 0 {
				ttl = leaseDuration(info.TTL)
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
		timer := time.NewTimer(time.Until(next))
		select {
		case <-timer.C:
		case <-c.ctx.Done():
			timer.Stop()
			return leaseReply{}, c.ctx.Err()
		}
	}
}

func (l *lease) acquire(wait bool) error {
	out, err := l.c.takeLease(l.id, wait)
	if err != nil {
		return err
	}
	l.token = out.Lease
	l.stop = make(chan struct{})
	l.done = make(chan struct{})
	ttl := leaseDuration(out.TTL)
	l.cutoff.Store(out.sent + int64(ttl/2))
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
				l.fenced.Store(true)
				return
			case <-t.C:
			}
			sent, previous := leaseClock(), l.cutoff.Load()
			if sent >= previous || l.fenced.Load() {
				l.fenced.Store(true)
				return
			}
			ctx, cancel := context.WithTimeout(l.c.ctx, time.Duration(previous-sent))
			var reply leaseReply
			err := l.c.wire.CallMethod(ctx, "POST", path(l.id)+"/lease/"+escape(out.Lease)+"/renew", "", nil, &reply)
			cancel()
			cutoff := sent + int64(ttl/2)
			if err != nil || leaseDuration(reply.TTL) != ttl || leaseClock() >= min(previous, cutoff) {
				l.fenced.Store(true)
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
	cutoff := l.cutoff.Load()
	if l.fenced.Load() || cutoff != 0 && leaseClock() >= cutoff {
		l.fenced.Store(true)
		return errors.New("history lease lost")
	}
	return l.c.ctx.Err()
}
func (l *lease) usable() error {
	if l.closed {
		return errors.New("lease closed")
	}
	return l.CheckWriter()
}
func decodeSession(d document) (api.Session, error) {
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
	return portable.Session(snap), nil
}
func (l *lease) Load() (api.Session, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.usable(); err != nil {
		return api.Session{}, err
	}
	if l.token == "" {
		if err := l.acquire(true); err != nil {
			return api.Session{}, err
		}
	}
	return l.loadSnapshot()
}
func (l *lease) loadSnapshot() (api.Session, error) {
	d, err := l.c.read(l.id)
	if err != nil {
		return api.Session{}, err
	}
	snap, err := decodeSession(d)
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
func (l *lease) Save(s api.Session) error {
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
		session := Session{Project: s.Project, Created: float64(time.Now().UnixMilli()), ParentSessionID: s.Parent}
		if source, entry, ok := strings.Cut(s.ForkedFrom, ":"); ok {
			session.ForkedFrom = &ForkOrigin{SessionID: source, EntryID: entry}
		}
		var out any
		if err := l.c.call(l.c.ctx, "PUT", path(l.id), session, &out); err != nil {
			return err
		}
		if err := l.acquire(false); err != nil {
			return err
		}
	}
	if l.known == nil {
		if _, err := l.loadSnapshot(); err != nil {
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
	var out any
	writeCtx, cancel := context.WithTimeout(l.c.ctx, time.Duration(l.cutoff.Load()-leaseClock()))
	defer cancel()
	if err := l.c.call(writeCtx, "POST", path(l.id)+"/entries", appendBody(l.token, entries), &out); err != nil {
		l.fenced.Store(true)
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
	p, separator := "/v1/sessions", "?"
	if project != "" {
		p, separator = p+"?project="+escape(project), "&"
	}
	first := p
	var sessions []Session
	seen := map[string]bool{}
	for {
		var out struct {
			Sessions []Session `json:"sessions"`
			Next     string    `json:"next"`
		}
		if err := c.call(c.ctx, "GET", p, nil, &out); err != nil {
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
		p = first + separator + "after=" + escape(out.Next)
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
			var out struct {
				Lease string `json:"lease"`
			}
			if err = c.call(c.ctx, "POST", path(s.ID)+"/lease", map[string]string{"owner": c.owner}, &out); err != nil {
				return err
			}
			q.token = out.Lease
			defer func(id, token string) {
				var out any
				_ = c.call(context.Background(), "DELETE", path(id)+"/lease/"+url.PathEscape(token), nil, &out)
			}(q.id, q.token)
		}
		targets = append(targets, q)
	}
	for _, q := range targets {
		var out any
		if err = c.call(c.ctx, "POST", path(q.id)+"/erase", map[string]any{"entryIds": q.entries, "lease": q.token}, &out); err != nil {
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
	l.fenced.Store(true)
	token := l.token
	if token != "" {
		close(l.stop)
	}
	l.mu.Unlock()
	if token == "" {
		return nil
	}
	<-l.done
	var out any
	return l.c.call(context.Background(), "DELETE", path(l.id)+"/lease/"+url.PathEscape(token), nil, &out)
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
	return api.Plugin{Name: "history-http", Setup: func(a api.API) error { return a.Provide("history", c) }, Close: c.Close}
}

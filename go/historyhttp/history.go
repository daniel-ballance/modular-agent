// Package historyhttp implements the modular-agent-history/1 HTTP binding.
package historyhttp

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/daniel-ballance/modular-agent/go/api"
)

const Binding = "modular-agent-history/1"
const maxSessions = 100_000

type Session struct {
	ID              string      `json:"id,omitempty"`
	Project         string      `json:"project"`
	Created         float64     `json:"created"`
	ParentSessionID string      `json:"parentSessionId,omitempty"`
	ForkedFrom      *ForkOrigin `json:"forkedFrom,omitempty"`
	wire            fields
}

type ForkOrigin struct {
	SessionID string `json:"sessionId"`
	EntryID   string `json:"entryId"`
}

func (s Session) MarshalJSON() ([]byte, error) {
	if s.wire != nil {
		return json.Marshal(s.wire)
	}
	type plain Session
	return json.Marshal(plain(s))
}
func (s *Session) UnmarshalJSON(b []byte) error {
	type plain Session
	if err := json.Unmarshal(b, (*plain)(s)); err != nil {
		return err
	}
	return json.Unmarshal(b, &s.wire)
}

type document = ReadPage

type held struct {
	owner, token string
	until        time.Time
}

type Server struct {
	mu            sync.Mutex
	dir           string
	ttl           time.Duration
	holdUntil     time.Time
	leaseMu       sync.Mutex // guards held; never held across I/O
	held          map[string]held
	count         int
	lock          *os.File
	store         api.Store
	storeLeases   map[string]api.Lease
	timers        map[string]*time.Timer
	closed        bool
	registry      bool
	revision      string
	registryBytes []byte
}

func New(dir string, ttl time.Duration) (*Server, error) {
	return newServer(dir, ttl, true)
}

func newServer(dir string, ttl time.Duration, registry bool) (*Server, error) {
	if ttl < time.Millisecond {
		ttl = 3 * time.Second
	}
	ttl = ttl.Truncate(time.Millisecond)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, ".service.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("history service store already open")
	}
	s := &Server{dir: dir, ttl: ttl, held: map[string]held{}, lock: f, registry: registry}
	if registry {
		if err := s.startupRegistry(); err != nil {
			f.Close()
			return nil, err
		}
	}
	if err := s.startup(); err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

func (s *Server) startup() error {
	files, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil {
		return err
	}
	s.count = len(files)
	pending, err := filepath.Glob(filepath.Join(s.dir, ".pending-*"))
	if err != nil {
		return err
	}
	for _, name := range pending {
		if err := os.Remove(name); err != nil {
			return err
		}
	}
	// The store remembers the largest TTL before granting any lease. If old
	// records predate this marker, there is no provable exclusion deadline.
	boundPath := filepath.Join(s.dir, ".lease-ttl-ms")
	previous, err := os.ReadFile(boundPath)
	bound := s.ttl
	if err == nil {
		n, err := strconv.ParseInt(string(previous), 10, 64)
		if err != nil || n < 1 || n > int64(maxDuration/time.Millisecond) {
			return errors.New("invalid history restart lease bound")
		}
		bound = max(bound, time.Duration(n)*time.Millisecond)
		s.holdUntil = time.Now().Add(bound)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if len(files) > 0 {
		return errors.New("history store has no prior lease bound; operator migration required")
	}
	return atomicFile(s.dir, boundPath, []byte(strconv.FormatInt(bound.Milliseconds(), 10)))
}

const maxDuration = time.Duration(1<<63 - 1)

func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.store != nil {
		s.closed = true
		var err error
		for id := range s.storeLeases {
			err = errors.Join(err, s.closeStoreLease(id))
		}
		if s.lock != nil {
			err = errors.Join(err, s.lock.Close())
			s.lock = nil
		}
		return err
	}
	if s.lock == nil {
		return nil
	}
	return s.closeFileStore()
}

// closeFileStore is called with mu held. Revoke the in-memory leases before
// releasing the process lock, including after an uncertain commit.
func (s *Server) closeFileStore() error {
	s.leaseMu.Lock()
	s.held = nil
	s.leaseMu.Unlock()
	err := s.lock.Close()
	s.lock = nil
	return err
}

func (s *Server) activeLease(id string) (held, bool) {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	h, ok := s.held[id]
	if ok && !time.Now().Before(h.until) {
		if s.store == nil {
			delete(s.held, id)
		}
		return held{}, false
	}
	return h, ok
}

func (s *Server) setLease(id string, h held) {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	if h.token == "" {
		delete(s.held, id)
	} else {
		s.held[id] = h
	}
}

// A current file-backed lease already proves the session exists. Renewal
// does not read its document or wait for any document or registry I/O.
func (s *Server) renewFileLease(id, token string) bool {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	h, ok := s.held[id]
	now := time.Now()
	if !ok || h.token != token || !now.Before(h.until) {
		return false
	}
	h.until = now.Add(s.ttl)
	s.held[id] = h
	return true
}

func (s *Server) renewed(w http.ResponseWriter) {
	respond(w, 200, map[string]any{"ttlMs": s.ttl.Milliseconds()})
}

func (s *Server) path(id string) string {
	return filepath.Join(s.dir, fmt.Sprintf("%x.json", sha256.Sum256([]byte(id))))
}
func (s *Server) load(id string) (document, error) {
	var d document
	if s.store != nil {
		return s.loadStore(id)
	}
	b, err := os.ReadFile(s.path(id))
	if err != nil {
		return d, err
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return d, err
	}
	if d.Session.ID != id {
		return d, errors.New("invalid history document")
	}
	return d, nil
}

// uncertainCommit means the rename succeeded, but directory durability has
// not been proven. An ordinary HTTP error would misreport that as a refusal.
var uncertainCommit = errors.New("history commit is uncertain")

func atomicFile(dir, path string, data []byte) error {
	f, err := os.CreateTemp(dir, ".pending-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return errors.Join(uncertainCommit, err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return errors.Join(uncertainCommit, err)
	}
	return nil
}

func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw(v))
}
func failure(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]string{"error": message, "code": code})
}
func invalid(w http.ResponseWriter)     { failure(w, 400, "invalid_request", "invalid history request") }
func unavailable(w http.ResponseWriter) { failure(w, 503, "unavailable", "history store unavailable") }
func lost(w http.ResponseWriter)        { failure(w, 409, "lost", "lease lost") }
func heldFailure(w http.ResponseWriter, remaining time.Duration) {
	ms := remaining.Milliseconds()
	if remaining%time.Millisecond != 0 {
		ms++
	}
	respond(w, 409, map[string]any{"error": "writer exclusion in effect", "code": "held", "retryAfterMs": max(ms, 1)})
}

func (s *Server) save(w http.ResponseWriter, d document, erasing bool) bool {
	if s.store != nil {
		if err := s.saveStore(d, erasing); err != nil {
			unavailable(w)
			return false
		}
		return true
	}
	if !s.commit(w, s.path(d.Session.ID), raw(d)) {
		return false
	}
	if s.registry {
		s.revision = api.ID()
	}
	return true
}

func (s *Server) commit(w http.ResponseWriter, path string, b []byte) bool {
	err := atomicFile(s.dir, path, b)
	if errors.Is(err, uncertainCommit) {
		_ = s.closeFileStore()
		panic(http.ErrAbortHandler)
	}
	if err != nil {
		unavailable(w)
		return false
	}
	return true
}

func (s *Server) Handler(token string) http.Handler {
	expected := sha256.Sum256([]byte("Bearer " + token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Values("Authorization")
		var actual [32]byte
		if len(auth) == 1 {
			actual = sha256.Sum256([]byte(auth[0]))
		}
		if token == "" || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			failure(w, 401, "unauthorized", "authentication required")
			return
		}
		q, ok := parseRequest(w, r, s.registry)
		if !ok {
			return
		}
		if s.store == nil && q.op == "renew" && s.renewFileLease(q.id, q.lease) {
			s.renewed(w)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.closed || (s.lock == nil && s.store == nil) {
			unavailable(w)
			return
		}
		s.serve(w, q)
	})
}

type request struct {
	op, id, lease, owner, project, after string
	filtered                             bool
	limit                                int
	meta                                 Session
	entries                              []json.RawMessage
	erase                                []string
	revision, intentID                   string
	publish                              publication
}

func parseRequest(w http.ResponseWriter, r *http.Request, registry bool) (q request, ok bool) {
	p := strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/")
	for i, part := range p {
		decoded, err := url.PathUnescape(part)
		if err != nil || !utf8.ValidString(decoded) || decoded == "." || decoded == ".." {
			invalid(w)
			return q, false
		}
		p[i] = decoded
	}
	method := ""
	switch {
	case len(p) == 1 && p[0] == "v1":
		q.op, method = "version", "GET"
	case len(p) == 2 && p[0] == "v1" && p[1] == "sessions":
		q.op, method = "list", "GET"
	case len(p) >= 3 && p[0] == "v1" && p[1] == "sessions" && p[2] != "":
		q.id = p[2]
		switch {
		case len(p) == 3:
			q.op, method = "read", "GET, PUT"
			if r.Method == "PUT" {
				q.op = "put"
			}
		case len(p) == 4 && (p[3] == "entries" || p[3] == "erase" || p[3] == "lease"):
			q.op, method = p[3], "POST"
		case registry && len(p) == 4 && p[3] == "pending-erasure":
			q.op, method = "plans", "GET, POST"
			if r.Method == "POST" {
				q.op = "publish"
			}
		case registry && len(p) == 6 && p[3] == "pending-erasure" && p[4] != "" && p[5] == "complete":
			q.op, q.intentID, method = "complete", p[4], "POST"
		case len(p) == 5 && p[3] == "lease" && p[4] != "":
			q.op, q.lease, method = "release", p[4], "DELETE"
		case len(p) == 6 && p[3] == "lease" && p[4] != "" && p[5] == "renew":
			q.op, q.lease, method = "renew", p[4], "POST"
		}
	}
	if method == "" {
		failure(w, 404, "not_found", "unknown path")
		return q, false
	}
	if !slices.Contains(strings.Split(method, ", "), r.Method) {
		w.Header().Set("Allow", method)
		failure(w, 405, "method_not_allowed", "method not allowed")
		return q, false
	}
	if r.ContentLength > appendLimit {
		failure(w, 413, "request_too_large", "request exceeds size limit")
		return q, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, appendLimit+1))
	if len(body) > appendLimit {
		failure(w, 413, "request_too_large", "request exceeds size limit")
		return q, false
	}
	if err != nil {
		invalid(w)
		return q, false
	}
	if len(r.Header.Values("Content-Encoding")) != 0 {
		failure(w, 415, "unsupported_media_type", "content encoding is not supported")
		return q, false
	}
	if len(body) != 0 {
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/json" {
			failure(w, 415, "unsupported_media_type", "expected application/json")
			return q, false
		}
	}
	if registry && q.op == "entries" {
		if values := r.Header.Values(revisionHeader); len(values) != 0 {
			if len(values) != 1 || !validLease(values[0]) {
				invalid(w)
				return q, false
			}
			q.revision = values[0]
		}
	}
	if !q.query(r.URL.RawQuery) || !q.body(body) {
		invalid(w)
		return q, false
	}
	return q, true
}

func (q *request) query(query string) bool {
	q.limit = 500
	if query == "" {
		return true
	}
	if q.op != "read" && q.op != "list" && q.op != "plans" {
		return false
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(query, "&") {
		k, v, has := strings.Cut(part, "=")
		if !has {
			return false
		}
		k, err := url.PathUnescape(k)
		if err != nil || seen[k] {
			return false
		}
		seen[k] = true
		v, err = url.PathUnescape(v)
		if err != nil || !utf8.ValidString(v) {
			return false
		}
		switch k {
		case "project":
			if q.op != "list" {
				return false
			}
			q.project, q.filtered = v, true
		case "after":
			if v == "" {
				return false
			}
			q.after = v
		case "limit":
			for _, c := range v {
				if c < '0' || c > '9' {
					return false
				}
			}
			q.limit, err = strconv.Atoi(v)
			if err != nil || q.limit < 1 || q.limit > 500 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func (q *request) body(body []byte) bool {
	switch q.op {
	case "put", "lease", "entries", "erase", "publish", "complete":
	default:
		return len(body) == 0
	}
	f, err := strictObject(body)
	if err != nil {
		return false
	}
	switch q.op {
	case "put":
		if _, exists := f["id"]; exists {
			return false
		}
		project, p := textOf(f["project"])
		created, c := count(f["created"])
		if !p || !c {
			return false
		}
		parent := idOf(f["parentSessionId"])
		if f["parentSessionId"] != nil && parent == "" {
			return false
		}
		var origin *ForkOrigin
		if f["forkedFrom"] != nil {
			from := objectOf(f["forkedFrom"])
			origin = &ForkOrigin{SessionID: idOf(from["sessionId"]), EntryID: idOf(from["entryId"])}
			if origin.SessionID == "" || origin.EntryID == "" {
				return false
			}
		}
		f["id"] = raw(q.id)
		q.meta = Session{ID: q.id, Project: project, Created: float64(created), ParentSessionID: parent, ForkedFrom: origin, wire: f}
	case "lease":
		q.owner = idOf(f["owner"])
		return q.owner != ""
	case "entries":
		q.lease = idOf(f["lease"])
		if !validLease(q.lease) || json.Unmarshal(f["entries"], &q.entries) != nil || q.entries == nil {
			return false
		}
		for _, entry := range q.entries {
			e := objectOf(entry)
			if idOf(e["id"]) == "" || (!bytes.Equal(e["parentId"], []byte("null")) && idOf(e["parentId"]) == "") || bytes.Equal(e["erased"], []byte("true")) {
				return false
			}
		}
	case "publish":
		return q.parsePublication(f)
	case "complete":
		q.lease = idOf(f["lease"])
		var ok bool
		q.erase, ok = distinctIDs(f["entryIds"], false)
		return len(f) == 2 && validLease(q.lease) && ok
	case "erase":
		q.lease = idOf(f["lease"])
		if f["lease"] != nil && !validLease(q.lease) {
			return false
		}
		var ok bool
		q.erase, ok = idsOf(f["entryIds"], true)
		return ok
	}
	return true
}

func (s *Server) serve(w http.ResponseWriter, q request) {
	switch q.op {
	case "version":
		out := map[string]any{"binding": Binding, "ttlMs": s.ttl.Milliseconds()}
		if s.registry {
			out["pendingErasure"] = 1
		}
		respond(w, 200, out)
		return
	case "list":
		s.list(w, q)
		return
	}
	if q.op == "plans" {
		w.Header().Set("Cache-Control", "no-store")
	}
	d, err := s.load(q.id)
	if q.op == "put" {
		s.put(w, q.meta, d, err)
		return
	}
	if errors.Is(err, os.ErrNotExist) {
		unknownSession(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	if q.op == "plans" {
		s.readPlans(w, q)
		return
	}
	if q.op == "read" {
		read(w, q, d)
		return
	}
	h, active := s.activeLease(q.id)
	if !active && s.store != nil {
		_ = s.closeStoreLease(q.id)
		s.setLease(q.id, held{})
	}
	current := func() bool {
		latest, active := s.activeLease(q.id)
		if !active || latest.token != q.lease {
			return false
		}
		if l, ok := s.storeLeases[q.id].(interface{ CheckWriter() error }); ok {
			return l.CheckWriter() == nil
		}
		return true
	}
	switch q.op {
	case "lease":
		if remaining := time.Until(s.holdUntil); remaining > 0 {
			heldFailure(w, remaining)
			return
		}
		if active {
			if h.owner != q.owner {
				heldFailure(w, time.Until(h.until))
				return
			}
		} else {
			if s.store != nil {
				l, err := s.store.Acquire(q.id)
				if err != nil {
					heldFailure(w, s.ttl)
					return
				}
				s.storeLeases[q.id] = l
			}
			h = held{owner: q.owner, token: api.ID(), until: time.Now().Add(s.ttl)}
			s.setLease(q.id, h)
			s.expireStoreLease(q.id, h)
		}
		respond(w, 200, map[string]any{"lease": h.token, "ttlMs": s.ttl.Milliseconds()})
	case "release":
		if current() {
			if err := s.closeStoreLease(q.id); err != nil {
				unavailable(w)
				return
			}
			s.setLease(q.id, held{})
		}
		respond(w, 200, fields{})
	case "renew":
		if s.store == nil {
			// The slow path still distinguishes unknown sessions from lost leases.
			if s.renewFileLease(q.id, q.lease) {
				s.renewed(w)
			} else {
				lost(w)
			}
			return
		}
		if !current() {
			lost(w)
			return
		}
		h.until = time.Now().Add(s.ttl)
		s.setLease(q.id, h)
		s.expireStoreLease(q.id, h)
		s.renewed(w)
	case "entries":
		if !current() {
			lost(w)
			return
		}
		if q.revision != "" {
			if _, err := s.loadRegistry(); err != nil {
				unavailable(w)
				return
			}
			if q.revision != s.revision {
				staleRevision(w)
				return
			}
		}
		s.append(w, d, q.entries, current)
	case "publish", "complete":
		if !current() {
			lost(w)
			return
		}
		if q.op == "publish" {
			s.publishPlans(w, d, q, current)
		} else {
			s.completePlan(w, d, q, current)
		}
	case "erase":
		if q.lease != "" {
			if !current() {
				lost(w)
				return
			}
		} else {
			if remaining := time.Until(s.holdUntil); remaining > 0 {
				heldFailure(w, remaining)
				return
			}
			if active {
				heldFailure(w, time.Until(h.until))
				return
			}
		}
		s.erase(w, d, q.erase, func() bool { return q.lease == "" || current() })
	}
}

func (s *Server) put(w http.ResponseWriter, session Session, old document, err error) {
	if err == nil {
		if !equalJSON(raw(old.Session), raw(session)) {
			failure(w, 409, "conflict", "session metadata differs")
			return
		}
	} else {
		if !errors.Is(err, os.ErrNotExist) || s.count >= maxSessions {
			unavailable(w)
			return
		}
		if len(raw(map[string]any{"sessions": []Session{session}, "next": session.ID})) > pageLimit || len(raw(document{Session: session, Entries: []json.RawMessage{}})) > pageLimit {
			failure(w, 413, "request_too_large", "metadata cannot fit a page")
			return
		}
		if !s.save(w, document{Session: session, Entries: []json.RawMessage{}}, false) {
			return
		}
		s.count++
	}
	respond(w, 200, fields{})
}

func (s *Server) append(w http.ResponseWriter, d document, entries []json.RawMessage, current func() bool) {
	seen := make(map[string]json.RawMessage, len(d.Entries))
	for _, e := range d.Entries {
		seen[entryID(e)] = e
	}
	kept := 0
	meta := raw(d.Session)
	for _, e := range entries {
		f := objectOf(e)
		id := idOf(f["id"])
		if old, ok := seen[id]; ok {
			if !equalJSON(old, e) {
				failure(w, 409, "conflict", "entry content differs")
				return
			}
			continue
		}
		base := pageSize("session", meta, "entries", 1, 0, id)
		compact := raw(e)
		if base+len(compact) > pageLimit || base+len(tombstone(f)) > pageLimit {
			failure(w, 413, "entry_too_large", "entry cannot fit a page")
			return
		}
		seen[id] = compact
		d.Entries = append(d.Entries, compact)
		kept++
	}
	if !current() {
		lost(w)
		return
	}
	if kept > 0 {
		if !s.save(w, d, false) {
			return
		}
	}
	respond(w, 200, map[string]int{"kept": kept})
}

func (s *Server) erase(w http.ResponseWriter, d document, ids []string, current func() bool) {
	indices := make(map[string]int, len(d.Entries))
	for i, e := range d.Entries {
		indices[entryID(e)] = i
	}
	seen := map[string]bool{}
	erased := []string{}
	changed := false
	for _, id := range ids {
		i, known := indices[id]
		if !known || seen[id] {
			continue
		}
		seen[id] = true
		erased = append(erased, id)
		f := objectOf(d.Entries[i])
		if !bytes.Equal(f["erased"], []byte("true")) {
			d.Entries[i] = tombstone(f)
			changed = true
		}
	}
	if !current() {
		lost(w)
		return
	}
	if changed {
		if !s.save(w, d, true) {
			return
		}
	}
	respond(w, 200, map[string]any{"erased": erased})
}

func (s *Server) list(w http.ResponseWriter, q request) {
	if s.store != nil {
		all, err := s.store.List(q.project)
		if err != nil {
			unavailable(w)
			return
		}
		sessions := []Session{}
		for _, snap := range all {
			if len(snap.Entries) == 0 || q.filtered && snap.Project != q.project {
				continue
			}
			meta, err := storeMetadata(snap)
			if err != nil {
				unavailable(w)
				return
			}
			sessions = append(sessions, meta)
		}
		listPage(w, q, sessions)
		return
	}
	files, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil {
		unavailable(w)
		return
	}
	sessions := []Session{}
	for _, file := range files {
		var d document
		b, err := os.ReadFile(file)
		if err != nil || json.Unmarshal(b, &d) != nil || d.Session.ID == "" {
			unavailable(w)
			return
		}
		if len(d.Entries) > 0 && (!q.filtered || d.Session.Project == q.project) {
			sessions = append(sessions, d.Session)
		}
	}
	listPage(w, q, sessions)
}
func listPage(w http.ResponseWriter, q request, sessions []Session) {
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Created == sessions[j].Created {
			return sessions[i].ID < sessions[j].ID
		}
		return sessions[i].Created > sessions[j].Created
	})
	items := make([]json.RawMessage, len(sessions))
	for i, session := range sessions {
		items[i] = raw(session)
	}
	page(w, q, "", nil, "sessions", items, "id", "unknown_session")
}

func read(w http.ResponseWriter, q request, d document) {
	page(w, q, "session", raw(d.Session), "entries", d.Entries, "id", "unknown_entry")
}

func pageSize(metaKey string, meta json.RawMessage, key string, n, payload int, next string) int {
	// Account for the exact compact envelope used below, including the cursor.
	size := len(`{"":[]}`) + len(key) + payload + max(n-1, 0)
	if meta != nil {
		size += len(`,"":`) + len(metaKey) + len(meta)
	}
	if next != "" {
		size += len(`,"next":`) + len(raw(next))
	}
	return size
}

func page(w http.ResponseWriter, q request, metaKey string, meta json.RawMessage, key string, items []json.RawMessage, cursorKey, code string) {
	id := func(item json.RawMessage) string { return idOf(objectOf(item)[cursorKey]) }
	if q.after != "" {
		i := 0
		for ; i < len(items) && id(items[i]) != q.after; i++ {
		}
		if i == len(items) {
			failure(w, 404, code, "unknown cursor")
			return
		}
		items = items[i+1:]
	}
	n, payload, cursor := 0, 0, ""
	for i := 0; i < min(q.limit, len(items)); i++ {
		payload += len(items[i])
		if pageSize(metaKey, meta, key, i+1, payload, "") > pageLimit {
			break
		}
		next := ""
		if i+1 < len(items) {
			next = id(items[i])
		}
		if pageSize(metaKey, meta, key, i+1, payload, next) <= pageLimit {
			n, cursor = i+1, next
		}
	}
	if n == 0 && len(items) > 0 {
		unavailable(w)
		return
	}
	if items == nil {
		items = []json.RawMessage{}
	}
	out := map[string]any{key: items[:n]}
	if meta != nil {
		out[metaKey] = meta
	}
	if cursor != "" {
		out["next"] = cursor
	}
	respond(w, 200, out)
}

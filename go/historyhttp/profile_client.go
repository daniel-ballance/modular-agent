package historyhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
)

func (c *Client) ErasureCoordinated() bool { return c.coordinated.Load() }

func (c *Client) profileCall(ctx context.Context, method, path string, in any, out *fields, revision string) error {
	headers := make(http.Header)
	if revision != "" {
		headers.Set(revisionHeader, revision)
	}
	if method == "GET" {
		headers.Set("Cache-Control", "no-cache")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res, err := c.wire.OpenMethodHeaders(ctx, method, path, "", in, headers)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, pageLimit+1))
	if err != nil || len(b) > pageLimit {
		return api.ErrErasureUnavailable
	}
	f, err := strictObject(b)
	if err == nil && out != nil {
		*out = f
	}
	return err
}

func (c *Client) ErasurePlans(id string) ([]api.ErasurePlan, string, error) {
	if !c.ErasureCoordinated() {
		return nil, "", api.ErrErasureUnsupported
	}
	var plans []api.ErasurePlan
	var revision, after string
	seen := map[string]bool{}
	for {
		var f fields
		if err := c.profileCall(c.ctx, "GET", path(id)+"/pending-erasure"+pageQuery(url.Values{}, after, defaultPageLimit), nil, &f, ""); err != nil {
			return nil, "", errors.Join(api.ErrErasureUnavailable, err)
		}
		pageRevision, next := idOf(f["revision"]), idOf(f["next"])
		if !validLease(pageRevision) || revision != "" && revision != pageRevision ||
			(next == "" && len(f) != 2) || (next != "" && (len(f) != 3 || !validSegment(next))) {
			return nil, "", api.ErrErasureUnavailable
		}
		revision = pageRevision
		var items []json.RawMessage
		if json.Unmarshal(f["plans"], &items) != nil || items == nil || len(items) > defaultPageLimit || (len(items) == 0 && (after != "" || next != "")) {
			return nil, "", api.ErrErasureUnavailable
		}
		for _, item := range items {
			p, ok := readPlan(id, objectOf(item))
			if !ok || seen[p.IntentID] {
				return nil, "", api.ErrErasureUnavailable
			}
			seen[p.IntentID] = true
			plans = append(plans, p)
		}
		if next == "" {
			return plans, revision, nil
		}
		if plans[len(plans)-1].IntentID != next {
			return nil, "", api.ErrErasureUnavailable
		}
		after = next
	}
}

func readPlan(id string, f fields) (api.ErasurePlan, bool) {
	p := api.ErasurePlan{IntentID: idOf(f["intentId"]), SourceID: idOf(f["sourceSessionId"]), RecordID: idOf(f["recordId"])}
	var copies []json.RawMessage
	if len(f) != 4 || !validSegment(p.IntentID) || !validSegment(p.SourceID) || p.RecordID == "" || json.Unmarshal(f["copies"], &copies) != nil || len(copies) == 0 {
		return p, false
	}
	seen := map[string]bool{}
	for _, item := range copies {
		f := objectOf(item)
		entry := idOf(f["entryId"])
		complete := string(f["complete"])
		if len(f) != 2 || entry == "" || seen[entry] || (complete != "true" && complete != "false") {
			return p, false
		}
		seen[entry] = true
		p.Copies = append(p.Copies, api.ErasureCopy{EntryPair: api.EntryPair{SessionID: id, ID: entry}, Complete: complete == "true"})
	}
	return p, true
}

func (l *lease) appendRevision(s api.Session, entries []json.RawMessage, destination, settling bool) (string, error) {
	var revision string
	marked := map[string]bool{}
	read := func(id string, dest bool) error {
		plans, rev, err := l.c.ErasurePlans(id)
		if err != nil {
			return err
		}
		if revision != "" && revision != rev {
			return api.ErrErasureUnavailable
		}
		revision = rev
		for _, p := range plans {
			for _, copy := range p.Copies {
				marked[copy.ID] = true
				if dest && !settling && (!copy.Complete || !isTombstone(l.known[copy.ID])) {
					return api.ErrErasureUnavailable
				}
			}
		}
		return nil
	}
	if destination {
		if err := read(s.ID, true); err != nil {
			return "", err
		}
	}
	origin, _, fork := strings.Cut(s.ForkedFrom, ":")
	initialFork := fork && len(l.known) == 0
	if initialFork {
		if err := read(origin, false); err != nil {
			return "", err
		}
	}
	staged := map[string]json.RawMessage{}
	for _, entry := range entries {
		staged[entryID(entry)] = entry
	}
	var unbound []string
	for _, entry := range entries {
		ids, _ := idsOf(objectOf(entry)["sources"], true)
		for _, id := range ids {
			if marked[id] || isTombstone(l.known[id]) {
				return "", api.ErrErasureUnavailable
			}
			if l.known[id] == nil && staged[id] == nil {
				unbound = append(unbound, id)
			}
		}
	}
	if len(unbound) == 0 {
		return revision, nil
	}
	if initialFork {
		d, err := l.c.read(origin)
		if err != nil {
			return "", errors.Join(api.ErrErasureUnavailable, err)
		}
		index := indexEntries(d)
		for _, id := range unbound {
			if index[id] == nil || isTombstone(index[id]) {
				return "", api.ErrErasureUnavailable
			}
		}
		return revision, nil
	}
	// A record may cite an entry from another session. Find it in the
	// shared store and include the authoritative marks for that scope.
	all, err := l.c.List("")
	if err != nil {
		return "", errors.Join(api.ErrErasureUnavailable, err)
	}
	found := map[string]bool{}
	for _, row := range all {
		matches := false
		for _, e := range row.Entries {
			if slices.Contains(unbound, e.ID) {
				if e.IsErased() {
					return "", api.ErrErasureUnavailable
				}
				matches, found[e.ID] = true, true
			}
		}
		if matches && row.ID != s.ID {
			if err := read(row.ID, false); err != nil {
				return "", err
			}
		}
	}
	for _, id := range unbound {
		if !found[id] || marked[id] {
			return "", api.ErrErasureUnavailable
		}
	}
	return revision, nil
}

func isTombstone(entry json.RawMessage) bool {
	return bytes.Equal(objectOf(entry)["erased"], []byte("true"))
}

func (l *lease) PublishErasure(revision string, intent api.ErasureIntent) (api.ErasurePublication, error) {
	p := publication{Revision: revision, IntentID: intent.ID, EntryIDs: intent.Targets}
	indices := map[string]int{}
	for _, copy := range intent.Copies {
		i, exists := indices[copy.SessionID]
		if !exists {
			i = len(p.Copies)
			indices[copy.SessionID] = i
			p.Copies = append(p.Copies, copySet{SessionID: copy.SessionID, RecordID: api.ID()})
		}
		p.Copies[i].EntryIDs = append(p.Copies[i].EntryIDs, copy.ID)
	}
	return l.mutateRegistry(path(l.id)+"/pending-erasure", func(token string) any { p.Lease = token; return p }, true)
}

func (l *lease) CompleteErasure(intentID string, ids []string) error {
	_, err := l.mutateRegistry(path(l.id)+"/pending-erasure/"+escape(intentID)+"/complete", func(token string) any { return completion{Lease: token, EntryIDs: ids} }, false)
	return err
}

func (l *lease) mutateRegistry(path string, body func(string) any, publish bool) (result api.ErasurePublication, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.usable(); err != nil {
		return result, err
	}
	if l.token == "" || !l.c.ErasureCoordinated() {
		return result, api.ErrErasureUnavailable
	}
	ctx, cancel := context.WithTimeout(l.c.ctx, time.Duration(l.cutoff.Load()-leaseClock()))
	defer cancel()
	var out fields
	if err := l.c.profileCall(ctx, "POST", path, body(l.token), &out, ""); err != nil {
		var refusal *servicehttp.ResponseError
		if errors.As(err, &refusal) && refusal.Code == "lost" {
			l.fence()
			return result, errors.Join(api.ErrWriterLost, err)
		}
		if !errors.As(err, &refusal) && !errors.Is(err, os.ErrNotExist) {
			l.fence()
		}
		return result, errors.Join(api.ErrErasureUnavailable, err)
	}
	if err := l.CheckWriter(); err != nil {
		return result, err
	}
	if !publish && len(out) == 0 {
		return result, nil
	}
	if publish && len(out) == 2 {
		id := idOf(out["intentId"])
		sessions, ok := distinctIDs(out["sessionIds"])
		if validSegment(id) && ok && slices.Contains(sessions, l.id) &&
			!slices.ContainsFunc(sessions, func(id string) bool { return !validSegment(id) }) {
			return api.ErasurePublication{IntentID: id, SessionIDs: sessions}, nil
		}
	}
	return result, api.ErrErasureUnavailable
}

// SaveErasure sends only exact tombstones. Reconciliation reloads the
// records under the lease before acknowledging any of them.
func (l *lease) SaveErasure(next api.Session) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.usable(); err != nil {
		return err
	}
	if next.ID != l.id || l.token == "" || l.known == nil {
		return api.ErrErasureUnavailable
	}
	var ids []string
	for _, entry := range next.Entries {
		if old := l.known[entry.ID]; old != nil && entry.IsErased() && !isTombstone(old) {
			ids = append(ids, entry.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(l.c.ctx, time.Duration(l.cutoff.Load()-leaseClock()))
	defer cancel()
	if _, err := l.c.backend.Erase(ctx, l.id, l.token, ids); err != nil {
		l.fence()
		return err
	}
	return l.CheckWriter()
}

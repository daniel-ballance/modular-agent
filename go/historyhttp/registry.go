package historyhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
)

const revisionHeader = "History-Revision"

type copySet struct {
	SessionID string   `json:"sessionId"`
	RecordID  string   `json:"recordId"`
	EntryIDs  []string `json:"entryIds"`
}

type publication struct {
	Lease    string    `json:"lease"`
	Revision string    `json:"revision"`
	IntentID string    `json:"intentId"`
	EntryIDs []string  `json:"entryIds"`
	Copies   []copySet `json:"copies"`
}

type completion struct {
	Lease    string   `json:"lease"`
	EntryIDs []string `json:"entryIds"`
}

type planCopy struct {
	EntryID  string `json:"entryId"`
	Complete bool   `json:"complete"`
}

type plan struct {
	IntentID        string     `json:"intentId"`
	SourceSessionID string     `json:"sourceSessionId"`
	RecordID        string     `json:"recordId"`
	Copies          []planCopy `json:"copies"`
}

type planPage struct {
	Revision string `json:"revision"`
	Plans    []plan `json:"plans"`
	Next     string `json:"next,omitempty"`
}

type intentRecord struct {
	ID         string          `json:"intentId"`
	Source     string          `json:"sourceSessionId"`
	Targets    []string        `json:"entryIds"`
	SessionIDs []string        `json:"sessionIds"`
	Plans      map[string]plan `json:"plans"`
}

func (row intentRecord) publicationResult() fields {
	return fields{"intentId": raw(row.ID), "sessionIds": raw(row.SessionIDs)}
}

func (s *Server) registryFile() string { return filepath.Join(s.dir, ".history-erasure-v1") }

func (s *Server) startupRegistry() error {
	// A new revision invalidates every pre-restart scan, even if the previous
	// process died after a commit and before acknowledging it.
	s.revision = api.ID()
	for _, name := range []string{".lease-ttl-ms", ".erasure-registry", ".erasure-required"} {
		if _, err := os.Stat(filepath.Join(s.dir, name)); !errors.Is(err, os.ErrNotExist) {
			// Never initialize an empty authority in an existing store. Older
			// stores need an operator-led migration to a new namespace.
			return nil
		}
	}
	files, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil || len(files) != 0 {
		return err
	}
	if _, err := os.Stat(s.registryFile()); errors.Is(err, os.ErrNotExist) {
		return atomicFile(s.dir, s.registryFile(), []byte("[]"))
	}
	return nil
}

// The authority is read under the same lock as history mutations. Retain an
// identity-only copy to detect replacement or truncation during service use.
func (s *Server) loadRegistry() ([]intentRecord, error) {
	b, err := os.ReadFile(s.registryFile())
	if err != nil || s.registryBytes != nil && !bytes.Equal(s.registryBytes, b) {
		return nil, api.ErrErasureUnavailable
	}
	var records []intentRecord
	if json.Unmarshal(b, &records) != nil || records == nil || !bytes.Equal(b, raw(records)) {
		return nil, api.ErrErasureUnavailable
	}
	for _, row := range records {
		if len(row.SessionIDs) == 0 || len(row.SessionIDs) != len(row.Plans) {
			return nil, api.ErrErasureUnavailable
		}
	}
	s.registryBytes = b
	return records, nil
}

func (s *Server) saveRegistry(w http.ResponseWriter, records []intentRecord) bool {
	b := raw(records)
	if !s.commit(w, s.registryFile(), b) {
		return false
	}
	s.registryBytes, s.revision = b, api.ID()
	return true
}

func distinctIDs(v json.RawMessage) ([]string, bool) {
	ids, ok := idsOf(v, false)
	if !ok {
		return nil, false
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return nil, false
		}
		seen[id] = true
	}
	return ids, true
}

func validSegment(id string) bool { return id != "" && id != "." && id != ".." }

func (q *request) parsePublication(f fields) bool {
	p := &q.publish
	q.lease = idOf(f["lease"])
	p.IntentID, p.Revision = idOf(f["intentId"]), idOf(f["revision"])
	if len(f) != 5 || !validLease(q.lease) || !validLease(p.Revision) || !validSegment(p.IntentID) {
		return false
	}
	var ok bool
	if p.EntryIDs, ok = distinctIDs(f["entryIds"]); !ok {
		return false
	}
	var sets []json.RawMessage
	if json.Unmarshal(f["copies"], &sets) != nil || len(sets) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, item := range sets {
		f := objectOf(item)
		s := copySet{SessionID: idOf(f["sessionId"]), RecordID: idOf(f["recordId"])}
		s.EntryIDs, ok = distinctIDs(f["entryIds"])
		if len(f) != 3 || !validSegment(s.SessionID) || s.RecordID == "" || !ok || seen[s.SessionID] {
			return false
		}
		seen[s.SessionID] = true
		if s.SessionID == q.id {
			entries := map[string]bool{}
			for _, id := range s.EntryIDs {
				entries[id] = true
			}
			for _, id := range p.EntryIDs {
				if !entries[id] {
					return false
				}
			}
		}
		p.Copies = append(p.Copies, s)
	}
	return seen[q.id]
}

func (s *Server) readPlans(w http.ResponseWriter, q request) {
	rows, err := s.loadRegistry()
	if err != nil {
		unavailable(w)
		return
	}
	items := []json.RawMessage{}
	for _, row := range rows {
		if p, ok := row.Plans[q.id]; ok {
			items = append(items, raw(p))
		}
	}
	page(w, q, "revision", raw(s.revision), "plans", items, "intentId", "unknown_intent")
}

func staleRevision(w http.ResponseWriter) {
	failure(w, 409, "stale_revision", "history revision changed")
}

func unknownSession(w http.ResponseWriter) { failure(w, 404, "unknown_session", "unknown session") }

func (s *Server) publishPlans(w http.ResponseWriter, source document, q request, current func() bool) {
	rows, err := s.loadRegistry()
	if err != nil {
		unavailable(w)
		return
	}
	p := q.publish
	targets := slices.Clone(p.EntryIDs)
	slices.Sort(targets)
	var existing *intentRecord
	for i := range rows {
		row := &rows[i]
		sameOp := row.Source == q.id && slices.Equal(row.Targets, targets)
		if row.ID == p.IntentID && (!sameOp || !sameCopySets(row.Plans, p.Copies)) {
			failure(w, 409, "conflict", "intent ID already names another publication")
			return
		}
		if sameOp {
			existing = row
		}
	}
	if existing != nil {
		respond(w, 200, existing.publicationResult())
		return
	}
	if p.Revision != s.revision {
		staleRevision(w)
		return
	}
	row := intentRecord{ID: p.IntentID, Source: q.id, Targets: targets, Plans: make(map[string]plan)}
	for _, set := range p.Copies {
		d := source
		if set.SessionID != q.id {
			d, err = s.load(set.SessionID)
			if errors.Is(err, os.ErrNotExist) {
				unknownSession(w)
				return
			}
			if err != nil {
				unavailable(w)
				return
			}
		}
		entries := indexEntries(d)
		result := plan{IntentID: p.IntentID, SourceSessionID: q.id, RecordID: set.RecordID}
		for _, id := range set.EntryIDs {
			if entries[id] == nil {
				failure(w, 404, "unknown_entry", "unknown copy entry")
				return
			}
			result.Copies = append(result.Copies, planCopy{EntryID: id})
		}
		if entries[set.RecordID] != nil || slices.ContainsFunc(rows, func(r intentRecord) bool { return r.Plans[set.SessionID].RecordID == set.RecordID }) {
			failure(w, 409, "conflict", "bookkeeping ID already used")
			return
		}
		if len(raw(planPage{Revision: strings.Repeat("A", maxLeaseBytes), Plans: []plan{result}, Next: p.IntentID})) > pageLimit {
			failure(w, 413, "request_too_large", "plan cannot fit a page")
			return
		}
		row.SessionIDs = append(row.SessionIDs, set.SessionID)
		row.Plans[set.SessionID] = result
	}
	if !current() {
		lost(w)
		return
	}
	if s.saveRegistry(w, append(rows, row)) {
		respond(w, 200, row.publicationResult())
	}
}

func indexEntries(d document) map[string]json.RawMessage {
	entries := make(map[string]json.RawMessage, len(d.Entries))
	for _, entry := range d.Entries {
		entries[entryID(entry)] = entry
	}
	return entries
}

func sameCopySets(plans map[string]plan, copies []copySet) bool {
	if len(plans) != len(copies) {
		return false
	}
	for _, set := range copies {
		p := plans[set.SessionID]
		if p.RecordID != set.RecordID || len(p.Copies) != len(set.EntryIDs) {
			return false
		}
		// Copy order is fixed at first publication, not on a resend.
		ids := make(map[string]bool, len(p.Copies))
		for _, copy := range p.Copies {
			ids[copy.EntryID] = true
		}
		for _, id := range set.EntryIDs {
			if !ids[id] {
				return false
			}
		}
	}
	return true
}

func (s *Server) completePlan(w http.ResponseWriter, d document, q request, current func() bool) {
	rows, err := s.loadRegistry()
	if err != nil {
		unavailable(w)
		return
	}
	for _, row := range rows {
		p, exists := row.Plans[q.id]
		if row.ID != q.intentID || !exists {
			continue
		}
		indices := make(map[string]int, len(p.Copies))
		for i, copy := range p.Copies {
			indices[copy.EntryID] = i
		}
		for _, id := range q.erase {
			if _, ok := indices[id]; !ok {
				invalid(w)
				return
			}
		}
		entries := indexEntries(d)
		record := objectOf(entries[p.RecordID])
		ids, _ := idsOf(objectOf(record["data"])["entryIds"], false)
		evidence := make(map[string]bool, len(ids))
		for _, id := range ids {
			evidence[id] = true
		}
		changed := false
		for _, id := range q.erase {
			if idOf(record["kind"]) != "erasure" || bytes.Equal(record["erased"], []byte("true")) || !evidence[id] || !bytes.Equal(objectOf(entries[id])["erased"], []byte("true")) {
				failure(w, 409, "conflict", "missing erasure evidence")
				return
			}
			i := indices[id]
			changed = changed || !p.Copies[i].Complete
			p.Copies[i].Complete = true
		}
		if !current() {
			lost(w)
			return
		}
		if !changed || s.saveRegistry(w, rows) {
			respond(w, 200, fields{})
		}
		return
	}
	failure(w, 404, "unknown_intent", "unknown erasure plan")
}

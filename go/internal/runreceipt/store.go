// Package runreceipt keeps deployment-local AG-UI release markers. The empty
// slot is durable before admission. Its name alone is not a binding: only the
// matching first operation entry (in the history transaction) claims the ID.
package runreceipt

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"syscall"

	"github.com/daniel-ballance/modular-agent/go/api"
)

const SlotBytes = 8192

func digest(v any) string { d := sha256.Sum256(api.JSON(v)); return hex.EncodeToString(d[:]) }
func Key(thread, actor, client, run string) string {
	return digest([]string{"agui.run/1", thread, actor, client, run})
}
func dir(root, thread string) string { return filepath.Join(root, digest(thread)) }
func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

type Marker struct {
	Class     string   `json:"terminal,omitempty"`
	Questions []string `json:"questions,omitempty"`
	Calls     []string `json:"calls,omitempty"`
	Code      string   `json:"code,omitempty"`
	// Only a handoff group needs its snapshot position and cursor. The
	// digest checks that the gate sees the original group, not a subset.
	Position    string `json:"position,omitempty"`
	Cursor      string `json:"cursor,omitempty"`
	GroupDigest string `json:"groupDigest,omitempty"`
	FixedError  bool   `json:"fixedError,omitempty"`
}

type Slot struct{ file *os.File }

func Reserve(root, thread, key string) (*Slot, error) {
	folder := dir(root, thread)
	if err := os.MkdirAll(folder, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(folder, key), os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Slot, error) { _ = f.Close(); return nil, err }
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail(api.ErrInputConflict)
	}
	st, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if st.Size() != SlotBytes {
		if _, err = f.WriteAt(make([]byte, SlotBytes), 0); err != nil {
			return fail(err)
		}
	}
	for _, sync := range []func() error{f.Sync, func() error { return syncDir(folder) }, func() error { return syncDir(root) }, func() error { return syncDir(filepath.Dir(root)) }} {
		if err = sync(); err != nil {
			return fail(err)
		}
	}
	return &Slot{f}, nil
}
func (s *Slot) Close()                           { _ = s.file.Close() }
func (s *Slot) Discard()                         { _ = os.Remove(s.file.Name()) }
func GroupDigest(group []json.RawMessage) string { return digest(group) }
func Fits(m Marker) bool                         { return len(api.JSON(m))+sha256.Size <= SlotBytes }
func (s *Slot) Release(m Marker) error {
	if !Fits(m) {
		return api.ErrCapacity
	}
	b := api.JSON(m)
	sum := sha256.Sum256(b)
	buf := make([]byte, SlotBytes)
	copy(buf, sum[:])
	copy(buf[sha256.Size:], b)
	if _, err := s.file.WriteAt(buf, 0); err != nil {
		return err
	}
	return s.file.Sync()
}
func Read(root, thread, key string) (Marker, error) {
	b, err := os.ReadFile(filepath.Join(dir(root, thread), key))
	if err != nil {
		return Marker{}, err
	}
	if len(b) != SlotBytes {
		return Marker{}, api.ErrErasureUnavailable
	}
	p := bytes.TrimRight(b[sha256.Size:], "\x00")
	sum := sha256.Sum256(p)
	// A crash during the release write never confirms a class.
	if !bytes.Equal(sum[:], b[:sha256.Size]) {
		return Marker{}, nil
	}
	var m Marker
	err = json.Unmarshal(p, &m)
	return m, err
}

// Work lists the records which support a disposition. An ended origin is not
// its own continuation. Keep tombstones in the fold so erasure cannot turn a
// hidden disposition into an apparently unsettled one.
type Work struct {
	Bound         api.Entry
	Turn          string
	End, Returned api.Entry
	Sources       []api.Entry
	Continued     bool
}

func Fold(entries []api.Entry, key string, m Marker) (w Work) {
	at := slices.IndexFunc(entries, func(e api.Entry) bool { return e.ID == key })
	if at < 0 {
		return
	}
	w.Bound = entries[at]
	w.Sources = append(w.Sources, w.Bound)
	origin := w.Bound.Turn
	input := w.Bound.InputRef
	if w.Bound.Kind == "input.accepted" {
		input = api.Decode[api.Input](w.Bound.Data).ID
	}
	decision := api.Decode[api.Answer](w.Bound.Data).Request
	if origin != "" {
		w.Continued = w.Bound.WasKind("tool.result") || slices.ContainsFunc(entries[:at], func(e api.Entry) bool { return e.Turn == origin && e.WasKind("turn.end") })
		if !w.Continued {
			w.Turn = origin
		}
	}
	for _, e := range entries {
		if input != "" {
			if e.WasKind("input") && e.InputID() == input {
				w.Turn = e.Turn
				w.Sources = append(w.Sources, e)
			}
			if slices.Contains(e.HandedBackIDs(), input) {
				w.Returned = e
				w.Sources = append(w.Sources, e)
			}
		}
		if w.Continued && e.WasKind("turn.start") && origin != "" && api.Decode[api.TurnStart](e.Data).ContinuesTurn == origin {
			w.Turn = e.Turn
			w.Sources = append(w.Sources, e)
		}
		if e.WasKind("question.open") && (e.ID == decision || slices.Contains(m.Questions, e.ID)) || e.WasKind("tool.started") && (slices.Contains(m.Calls, e.Call) || w.Bound.WasKind("tool.result") && e.Call == w.Bound.Call) {
			w.Sources = append(w.Sources, e)
		}
	}
	for _, e := range entries {
		if e.Turn != "" && e.Turn == w.Turn {
			if e.WasKind("turn.start") {
				w.Sources = append(w.Sources, e)
			}
			if e.WasKind("turn.end") {
				w.End = e
				w.Sources = append(w.Sources, e)
			}
		}
	}
	return
}

// Erase removes private markers before their source tombstones are completed.
// Source entry identities still bar a second admission or decision.
func Erase(root string, row api.Session, ids []string) error {
	if root == "" {
		return nil
	}
	folder := dir(root, row.ID)
	files, err := os.ReadDir(folder)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	changed := false
	for _, f := range files {
		m, err := Read(root, row.ID, f.Name())
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		w := Fold(row.Entries, f.Name(), m)
		if m.GroupDigest != "" {
			// The snapshot in an executable release depends on displayed
			// messages on this prefix, not later turns or another branch.
			prefix := row
			prefix.Position = m.Position
			for _, e := range prefix.Branch() {
				switch e.Kind {
				case "input", "model", "tool.started", "tool.result":
					w.Sources = append(w.Sources, e)
				}
			}
		}
		for _, e := range w.Sources {
			if slices.Contains(ids, e.ID) {
				if err = os.Remove(filepath.Join(folder, f.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
				changed = true
				break
			}
		}
	}
	if changed {
		return syncDir(folder)
	}
	return nil
}

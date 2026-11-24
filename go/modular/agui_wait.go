package modular

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

// WaitClosure is status, never an answer or authorization to execute a call.
type WaitClosure struct {
	Cursor     string `json:"cursor"`
	RequestID  string `json:"requestId,omitempty"`
	ToolCallID string `json:"toolCallId,omitempty"`
	Reason     string `json:"reason"`
	Status     string `json:"status,omitempty"`
}

func branchVersion(s api.Session) string {
	for _, e := range slices.Backward(s.Entries) {
		if e.WasKind("position") {
			return e.ID
		}
	}
	return ""
}

func (q *agRequest) waitCipher(s api.Session) (cipher.AEAD, []byte) {
	block, _ := aes.NewCipher(q.pageKey[:])
	seal, _ := cipher.NewGCMWithRandomNonce(block)
	return seal, api.JSON([]string{"wait", q.Actor.ID, q.client, s.ID, branchVersion(s)})
}
func (q *agRequest) waitCursor(s api.Session, index int) string {
	seal, scope := q.waitCipher(s)
	return base64.RawURLEncoding.EncodeToString(seal.Seal(nil, nil, binary.BigEndian.AppendUint64(binary.BigEndian.AppendUint64(nil, uint64(index)), uint64(worktime.Now().Add(24*time.Hour).Unix())), scope))
}
func (q *agRequest) waitAfter(s api.Session, cursor string) (int, error) {
	seal, scope := q.waitCipher(s)
	if len(cursor) == base64.RawURLEncoding.EncodedLen(16+seal.Overhead()) {
		b, err := base64.RawURLEncoding.Strict().DecodeString(cursor)
		if err == nil {
			if p, err := seal.Open(nil, nil, b, scope); err == nil && len(p) == 16 && worktime.Now().Unix() < int64(binary.BigEndian.Uint64(p[8:])) {
				if n := binary.BigEndian.Uint64(p); n <= uint64(len(s.Entries)) {
					return int(n), nil
				}
			}
		}
	}
	return 0, agCode("cursor_expired")
}
func oneQuery(raw, key string) (string, error) {
	v, err := url.ParseQuery(raw)
	if err != nil || len(v) != 1 || len(v[key]) != 1 {
		return "", invalid
	}
	return v[key][0], nil
}

type agReadCut struct {
	snap    api.Session
	changed <-chan struct{}
	epoch   int
}

func (q *agRequest) readCut() (agReadCut, error) {
	epoch, err := q.host().ErasureEpoch(q.id)
	if err != nil {
		return agReadCut{}, err
	}
	snap, next, err := q.host().ReadForHost(q.ctx, q.a.project, q.id)
	if errors.Is(err, api.ErrAuthority) {
		err = missing
	}
	if err != nil {
		return agReadCut{}, err
	}
	return agReadCut{snap, next, epoch}, q.ctx.Err()
}

func (q *agRequest) waitClosures(raw string) error {
	cut, err := q.readCut()
	if err != nil {
		return err
	}
	cursor, err := oneQuery(raw, "after")
	if err != nil {
		return err
	}
	i, err := q.waitAfter(cut.snap, cursor)
	if err != nil {
		return err
	}
	version := branchVersion(cut.snap)
	// The first cut includes all catch-up. Later cuts cover only new commits.
	// The ledger is the queue. Keep a bounded lag and never skip a live commit.
	const maxLag = 256
	q.w.Header().Set("Content-Type", "text/event-stream")
	if http.NewResponseController(q.w).Flush() != nil {
		return nil
	}
	q.boundary("waitFollowing", "")
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()
	for {
		for ; i < len(cut.snap.Entries); i++ {
			e := cut.snap.Entries[i]
			if e.Kind != "question.answer" && e.Kind != "tool.result" {
				continue
			}
			q.boundary("beforeWaitDelivery", "")
			now, err := q.readCut()
			if err != nil || branchVersion(now.snap) != version || len(now.snap.Entries)-len(cut.snap.Entries) > maxLag {
				return nil
			}
			if i >= len(now.snap.Entries) || now.snap.Entries[i].ID != e.ID {
				return nil
			}
			b, err := q.waitItem(now.snap, i)
			if errors.Is(err, api.ErrOutputWithheld) {
				continue
			}
			if err != nil {
				return nil
			}
			if b == nil {
				continue
			}
			final, err := q.readCut()
			if err != nil || branchVersion(final.snap) != version || final.epoch != now.epoch {
				return nil
			}
			if err = q.frame(b); err != nil {
				return nil
			}
		}
		select {
		case <-q.ctx.Done():
			return nil
		case <-cut.changed:
		case <-heartbeat.C:
			if _, err := q.readCut(); err != nil {
				return nil
			}
			ctrl := http.NewResponseController(q.w)
			_ = ctrl.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_, err := q.w.Write([]byte(": watching\n\n"))
			if err != nil || ctrl.Flush() != nil {
				return nil
			}
			_ = ctrl.SetWriteDeadline(time.Time{})
		}
		cut, err = q.readCut()
		if err != nil || branchVersion(cut.snap) != version || len(cut.snap.Entries) < i || len(cut.snap.Entries)-i > maxLag {
			return nil
		}
	}
}

// source gates the ordinary entry, including the native history view. Never
// use the raw decision as a substitute for a withheld source.
type agSources struct {
	q       *agRequest
	entries map[string]api.Entry
}

func (q *agRequest) sources(s api.Session) (agSources, error) {
	view, err := q.host().HostHistoryView(q.ctx, s)
	if err != nil {
		return agSources{}, err
	}
	a := agSources{q, map[string]api.Entry{}}
	for _, e := range view.Branch() {
		if !e.IsErased() {
			a.entries[e.ID] = e
		}
	}
	return a, nil
}
func (a agSources) entry(raw api.Entry) (api.Entry, error) {
	e, ok := a.entries[raw.ID]
	if !ok || e.Kind != raw.Kind {
		return api.Entry{}, api.ErrOutputWithheld
	}
	g, err := a.q.gate(api.Event{Kind: "history.added", Actor: e.Actor, Turn: e.Turn, Step: e.Step, Call: e.Call, Data: api.JSON(e)})
	if err != nil {
		return api.Entry{}, err
	}
	e = api.Decode[api.Entry](g.Data)
	if e.ID != raw.ID || e.Kind != raw.Kind || e.Call != raw.Call || e.Turn != raw.Turn {
		return api.Entry{}, api.ErrOutputWithheld
	}
	return e, nil
}
func answerReason(a api.Answer) string {
	if a.Actor != "" {
		if a.Stored != "" {
			return ""
		}
		if a.Declined {
			return "declined"
		}
		return "answered"
	}
	if !a.Declined {
		return ""
	}
	switch a.Reason {
	case "timeLimit":
		return "expired"
	case "noLongerAnswerable", "refused":
		if a.Cause == "revoked" {
			return "revoked"
		}
		return a.Reason
	case "cancelled", "superseded":
		return a.Reason
	}
	return ""
}
func (q *agRequest) waitItem(s api.Session, i int) ([]byte, error) {
	e := s.Entries[i]
	if e.IsErased() {
		return nil, nil
	}
	a, err := q.sources(s)
	if err != nil {
		return nil, err
	}
	closed, err := a.entry(e)
	if err != nil {
		return nil, err
	}
	item := WaitClosure{}
	switch e.Kind {
	case "question.answer":
		ans := api.Decode[api.Answer](closed.Data)
		raw := api.Decode[api.Answer](e.Data)
		reason := answerReason(ans)
		if reason == "" || reason != answerReason(raw) || raw.Request == "" || raw.Request != ans.Request {
			return nil, nil
		}
		var opened api.Entry
		for _, v := range s.Branch() {
			if v.ID == e.ID {
				break
			}
			if v.Kind == "question.open" && v.ID == ans.Request {
				opened = v
			}
			if v.Kind == "question.answer" && api.Decode[api.Answer](v.Data).Request == ans.Request {
				return nil, nil
			}
		}
		visible, err := a.entry(opened)
		if err != nil {
			return nil, err
		}
		for _, v := range []api.Entry{opened, visible} {
			req := api.Decode[struct{ Question api.Question }](v.Data).Question
			if req.ID != ans.Request || req.Session != s.ID || req.Kind == "secret" || len(req.Allowed) > 0 && !slices.Contains(req.Allowed, q.Actor.ID) {
				return nil, nil
			}
		}
		item.RequestID, item.Reason = ans.Request, reason
	case "tool.result":
		cp := api.InterfaceHandoffs(s)[e.Call]
		h := api.Decode[api.InterfaceHandoff](cp.Data)
		if cp.Kind != api.InterfaceHandoffKind || h.Actor != q.Actor.ID || h.Route != q.client {
			return nil, nil
		}
		start, err := a.entry(a.entries[h.Started])
		if err != nil {
			return nil, err
		}
		if start.Kind != "tool.started" || start.Call != e.Call {
			return nil, nil
		}
		raw := api.Decode[api.ToolResult](e.Data)
		r := api.Decode[api.ToolResult](closed.Data)
		if r.Call != e.Call || r.Status != raw.Status || r.Status == "" {
			return nil, nil
		}
		g, err := q.gate(api.Event{Kind: "tool.end", Turn: e.Turn, Step: e.Step, Call: e.Call, Data: api.JSON(r)})
		if err != nil {
			return nil, err
		}
		if api.Decode[api.ToolResult](g.Data).Status != r.Status {
			return nil, nil
		}
		item.ToolCallID, item.Reason, item.Status = e.Call, "settled", portable.StatusOut(r.Status)
	default:
		return nil, nil
	}
	item.Cursor = q.waitCursor(s, i+1)
	b := api.JSON(item)
	g, err := q.gate(api.Event{Kind: "modular-agent.waitClosed", Data: b})
	if err != nil {
		return nil, err
	}
	if g.OutputChanged || !agSameBytes(g.Data, b) {
		return nil, nil
	}
	return b, nil
}

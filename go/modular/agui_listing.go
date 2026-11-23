package modular

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
)

type threadInfo struct {
	ThreadID  string         `json:"threadId"`
	UpdatedAt time.Time      `json:"updatedAt"`
	Waiting   WaitingSummary `json:"waiting"`
	epoch     int
}

type agThreadPage struct {
	Threads []threadInfo `json:"threads"`
	Next    string       `json:"next,omitempty"`
}

// The cursor stores no session IDs. Authenticate its offset and expiry for
// this client and listener. Restarting the listener expires every cursor.
func (q *agRequest) pageMAC(data []byte) []byte {
	mac := hmac.New(sha256.New, q.pageKey[:])
	mac.Write([]byte(q.client))
	mac.Write(data)
	return mac.Sum(nil)
}

func (q *agRequest) nextPage(offset int) string {
	b := binary.BigEndian.AppendUint64(nil, uint64(offset))
	b = binary.BigEndian.AppendUint64(b, uint64(time.Now().Add(15*time.Minute).Unix()))
	return base64.RawURLEncoding.EncodeToString(append(b, q.pageMAC(b)...))
}

func (q *agRequest) listParams(raw string) (offset, limit int, err error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return 0, 0, invalid
	}
	limit = 100
	for key, v := range values {
		if len(v) != 1 {
			return 0, 0, invalid
		}
		switch key {
		case "limit":
			n, err := strconv.ParseUint(v[0], 10, 10)
			if err != nil || n < 1 || n > 500 {
				return 0, 0, invalid
			}
			limit = int(n)
		case "after":
			b, err := base64.RawURLEncoding.Strict().DecodeString(v[0])
			if err != nil || len(b) != 16+sha256.Size || !hmac.Equal(q.pageMAC(b[:16]), b[16:]) || time.Now().Unix() >= int64(binary.BigEndian.Uint64(b[8:16])) {
				return 0, 0, invalid
			}
			offset = int(binary.BigEndian.Uint64(b))
		default:
			return 0, 0, invalid
		}
	}
	return offset, limit, nil
}

func (q *agRequest) inTurnOffer(id, request string) bool {
	q.mu.Lock()
	s := q.states[[2]string{id, q.client}]
	q.mu.Unlock()
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.delivered[request].presence
	return p != nil && p == s.presence && p.ctx.Err() == nil
}

func (q *agRequest) listThreads(raw string) error {
	offset, limit, err := q.listParams(raw)
	if err != nil {
		return err
	}
	viewer := SessionViewer{Actor: q.Actor, Tenant: q.opt.Tenant, RouteID: q.client, Scope: q.scope,
		JoinOnOpen: *q.opt.JoinOnOpen, InTurn: q.inTurnOffer}
	threads := []threadInfo{}
	if q.a.persistent && slices.Contains(viewer.Actor.Rights, "watch") && q.scope(q.a.project, viewer.Tenant) {
		rows, err := q.a.a.List(q.a.project)
		if err != nil {
			return err
		}
		for _, row := range rows {
			summary, err := q.a.summary(q.ctx, row, viewer)
			if err != nil {
				return err
			}
			if summary != nil {
				epoch, err := q.host().ErasureEpoch(row.ID)
				if err != nil {
					return err
				}
				threads = append(threads, threadInfo{row.ID, summary.UpdatedAt, summary.Waiting, epoch})
			}
		}
	}
	slices.SortFunc(threads, func(a, b threadInfo) int {
		if c := b.UpdatedAt.Compare(a.UpdatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ThreadID, b.ThreadID)
	})
	start := min(offset, len(threads))
	end := start + min(limit, len(threads)-start)
	page := agThreadPage{Threads: threads[start:end]}
	if end < len(threads) {
		page.Next = q.nextPage(end)
	}
	b, err := q.encode("agui.threads", page)
	if err != nil {
		return err
	}
	// The output gate can block while a session changes. Recheck the
	// listed identities, counts and erasure cutoffs without attaching.
	if len(page.Threads) > 0 {
		current, err := q.a.a.List(q.a.project)
		if err != nil {
			return err
		}
		records := make(map[string]api.Session, len(current))
		for _, row := range current {
			records[row.ID] = row
		}
		for _, info := range page.Threads {
			row, ok := records[info.ThreadID]
			if !ok {
				return stale
			}
			current, err := q.a.summary(q.ctx, row, viewer)
			if err != nil {
				return err
			}
			epoch, err := q.host().ErasureEpoch(info.ThreadID)
			if err != nil {
				return err
			}
			if current == nil || epoch != info.epoch || current.Waiting.Questions != info.Waiting.Questions || current.Waiting.ToolCalls != info.Waiting.ToolCalls {
				return stale
			}
		}
	}
	q.w.Header().Set("Content-Type", "application/json")
	_, _ = q.w.Write(b)
	return nil
}

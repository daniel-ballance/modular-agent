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

type agThreadInfo struct {
	ID        string             `json:"threadId"`
	UpdatedAt time.Time          `json:"updatedAt"`
	Waiting   api.WaitingSummary `json:"waiting"`
}
type agThreadPage struct {
	Threads []agThreadInfo `json:"threads"`
	Next    string         `json:"next,omitempty"`
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

func (q *agRequest) listed(row api.Session) bool {
	return row.Tenant == q.opt.Tenant && slices.Contains(q.rights, "watch") && q.member(row)
}

func (q *agRequest) listThreads(raw string) error {
	offset, limit, err := q.listParams(raw)
	if err != nil {
		return err
	}
	page := agThreadPage{Threads: []agThreadInfo{}}
	if !q.a.persistent {
		return q.jsonReply(200, "agui.threads", page)
	}
	rows, err := q.a.a.List(q.a.project)
	if err != nil {
		return err
	}
	records := make(map[string]api.Session)
	var ordered []agThreadInfo
	for _, row := range rows {
		if !q.listed(row) {
			continue
		}
		var updated time.Time
		for _, e := range row.Entries {
			if e.Time.After(updated) {
				updated = e.Time
			}
		}
		ordered = append(ordered, agThreadInfo{ID: row.ID, UpdatedAt: updated.UTC()})
		records[row.ID] = row
	}
	slices.SortFunc(ordered, func(a, b agThreadInfo) int {
		if c := b.UpdatedAt.Compare(a.UpdatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	end := min(offset+limit, len(ordered))
	epochs := make(map[string]int)
	for _, info := range ordered[min(offset, end):end] {
		if epochs[info.ID], err = q.host().ErasureEpoch(info.ID); err != nil {
			return err
		}
		info.Waiting, err = q.a.a.WaitingForHost(q.ctx, records[info.ID], q.Actor, q.client)
		if err != nil {
			return err
		}
		page.Threads = append(page.Threads, info)
	}
	if end < len(ordered) {
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
		clear(records)
		for _, row := range current {
			records[row.ID] = row
		}
		for _, info := range page.Threads {
			row, ok := records[info.ID]
			if !ok || !q.listed(row) {
				return stale
			}
			w, err := q.a.a.WaitingForHost(q.ctx, row, q.Actor, q.client)
			if err != nil {
				return err
			}
			epoch, err := q.host().ErasureEpoch(info.ID)
			if err != nil {
				return err
			}
			if epoch != epochs[info.ID] || w.Questions != info.Waiting.Questions || w.ToolCalls != info.Waiting.ToolCalls {
				return stale
			}
		}
	}
	q.w.Header().Set("Content-Type", "application/json")
	_, _ = q.w.Write(b)
	return nil
}

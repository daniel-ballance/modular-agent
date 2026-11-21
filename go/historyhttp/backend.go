package historyhttp

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
)

const defaultPageLimit = 500

type Metadata struct {
	Project         string      `json:"project"`
	Created         float64     `json:"created"`
	ParentSessionID string      `json:"parentSessionId,omitempty"`
	ForkedFrom      *ForkOrigin `json:"forkedFrom,omitempty"`
}

type ReadPage struct {
	Session Session           `json:"session"`
	Entries []json.RawMessage `json:"entries"`
	Next    string            `json:"next,omitempty"`
}

type ListPage struct {
	Sessions []Session `json:"sessions"`
	Next     string    `json:"next,omitempty"`
}

type Grant struct {
	Lease string  `json:"lease"`
	TTLMS float64 `json:"ttlMs"`
	// WriterLost is optional for local stores that learn of revocation before
	// the next renewal. Close it to fence this generation immediately.
	WriterLost <-chan struct{} `json:"-"`
}

// Backend is the local counterpart of the history binding. Operations must
// observe its atomicity, paging, equality, durability and fencing rules.
// An empty after starts a page; an empty project omits the project filter.
// Entries are opaque binding JSON objects in append order.
type Backend interface {
	LeaseTTL() time.Duration
	operations
}

type operations interface {
	Create(ctx context.Context, sessionID string, metadata Metadata) error
	Acquire(ctx context.Context, sessionID, owner string) (Grant, error)
	Renew(ctx context.Context, sessionID, lease string) (ttlMS float64, err error)
	Release(ctx context.Context, sessionID, lease string) error
	Append(ctx context.Context, sessionID, lease string, entries []json.RawMessage) (kept int, err error)
	Read(ctx context.Context, sessionID, after string, limit int) (ReadPage, error)
	List(ctx context.Context, project, after string, limit int) (ListPage, error)
	Erase(ctx context.Context, sessionID, lease string, entryIDs []string) (erased []string, err error)
}

type httpBackend struct{ wire *servicehttp.Client }

func (b httpBackend) info(ctx context.Context) (info struct {
	Binding string  `json:"binding"`
	TTLMS   float64 `json:"ttlMs"`
}, err error) {
	err = b.call(ctx, "GET", "/v1", nil, &info)
	return
}

func (b httpBackend) call(ctx context.Context, method, path string, in, out any) error {
	return b.wire.CallMethod(ctx, method, path, api.ID(), in, out)
}

func (b httpBackend) Create(ctx context.Context, id string, metadata Metadata) error {
	var out struct{}
	return b.call(ctx, "PUT", path(id), metadata, &out)
}

func (b httpBackend) Acquire(ctx context.Context, id, owner string) (out Grant, err error) {
	err = b.wire.CallMethod(ctx, "POST", path(id)+"/lease", "", map[string]string{"owner": owner}, &out)
	return
}

func (b httpBackend) Renew(ctx context.Context, id, token string) (float64, error) {
	var out Grant
	err := b.wire.CallMethod(ctx, "POST", path(id)+"/lease/"+escape(token)+"/renew", "", nil, &out)
	return out.TTLMS, err
}

func (b httpBackend) Release(ctx context.Context, id, token string) error {
	var out struct{}
	return b.call(ctx, "DELETE", path(id)+"/lease/"+escape(token), nil, &out)
}

func (b httpBackend) Append(ctx context.Context, id, token string, entries []json.RawMessage) (int, error) {
	var out struct{ Kept int }
	err := b.call(ctx, "POST", path(id)+"/entries", appendBody(token, entries), &out)
	return out.Kept, err
}

func pageQuery(query url.Values, after string, limit int) string {
	if after != "" {
		query.Set("after", after)
	}
	// The existing HTTP client relies on the binding's default limit.
	if limit != defaultPageLimit {
		query.Set("limit", strconv.Itoa(limit))
	}
	if len(query) == 0 {
		return ""
	}
	return "?" + strings.ReplaceAll(query.Encode(), "+", "%20")
}

func (b httpBackend) Read(ctx context.Context, id, after string, limit int) (out ReadPage, err error) {
	err = b.call(ctx, "GET", path(id)+pageQuery(url.Values{}, after, limit), nil, &out)
	return
}

func (b httpBackend) List(ctx context.Context, project, after string, limit int) (out ListPage, err error) {
	query := url.Values{}
	if project != "" {
		query.Set("project", project)
	}
	err = b.call(ctx, "GET", "/v1/sessions"+pageQuery(query, after, limit), nil, &out)
	return
}

func (b httpBackend) Erase(ctx context.Context, id, token string, ids []string) ([]string, error) {
	var out struct{ Erased []string }
	err := b.call(ctx, "POST", path(id)+"/erase", map[string]any{"entryIds": ids, "lease": token}, &out)
	return out.Erased, err
}

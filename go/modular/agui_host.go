package modular

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
)

// AGUIHost reads a single authenticated AG-UI service. Origin is the service's
// HTTP(S) origin. Client supplies authentication (for example in its Transport).
type AGUIHost struct {
	Origin string
	Client *http.Client
}

func (h AGUIHost) get(ctx context.Context, thread, route, query, value, media string) (io.ReadCloser, error) {
	if h.Client == nil || thread == "" || strings.ContainsAny(thread, "/%") {
		return nil, &Error{Code: InvalidParams, Message: "expected a client and thread ID"}
	}
	u, err := url.Parse(h.Origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" || u.Scheme != "https" && (u.Scheme != "http" || !wswire.Loopback(u.Hostname())) {
		return nil, &Error{Code: InvalidParams, Message: "invalid AG-UI origin"}
	}
	u.Path = "/agui/v1/threads/" + thread + "/" + route
	u.RawQuery = url.Values{query: {value}}.Encode()
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", media)
	client := *h.Client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		defer res.Body.Close()
		var problem struct{ Code string }
		_ = json.NewDecoder(io.LimitReader(res.Body, 1024)).Decode(&problem)
		return nil, &Error{Code: Code(problem.Code), Message: fmt.Sprintf("AG-UI read returned HTTP %d", res.StatusCode)}
	}
	kind, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if kind != media {
		res.Body.Close()
		return nil, fmt.Errorf("unexpected AG-UI response type")
	}
	return res.Body, nil
}

func decodeWaitClosure(data []byte) (WaitClosure, bool) {
	m, err := agDecodeObject(data)
	if err != nil || len(data) > wswire.MaxFrame {
		return WaitClosure{}, false
	}
	item := WaitClosure{Cursor: agString(m, "cursor"), Reason: agString(m, "reason"), RequestID: agString(m, "requestId"), ToolCallID: agString(m, "toolCallId"), Status: agString(m, "status")}
	return item, item.valid()
}

// WaitClosures reads from a snapshot's waitCursor or the last applied notice.
// It does not reconnect, open presence or deliver an answerable view.
func (h AGUIHost) WaitClosures(ctx context.Context, thread, after string) iter.Seq2[WaitClosure, error] {
	return func(yield func(WaitClosure, error) bool) {
		body, err := h.get(ctx, thread, "wait-closures", "after", after, "text/event-stream")
		if err != nil {
			yield(WaitClosure{}, err)
			return
		}
		defer body.Close()
		sc := bufio.NewScanner(body)
		sc.Buffer(make([]byte, 4096), wswire.MaxFrame+8)
		var item WaitClosure
		ready := false
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				if ready && !yield(item, nil) {
					return
				}
				ready = false
				continue
			}
			if line[0] == ':' {
				continue
			}
			data, ok := bytes.CutPrefix(line, []byte("data: "))
			var valid bool
			item, valid = decodeWaitClosure(data)
			if !ok || ready || !valid {
				yield(WaitClosure{}, fmt.Errorf("invalid wait closure"))
				return
			}
			ready = true
		}
		err = sc.Err()
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		yield(WaitClosure{}, err)
	}
}

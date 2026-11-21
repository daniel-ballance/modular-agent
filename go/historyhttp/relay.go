package historyhttp

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"io"
	"net/http"
	"strings"
)

// Relay exposes the same history binding through a configured history client.
// The upstream service, not the relay, owns the leases and original JSON.
func (c *Client) Relay(token string) http.Handler {
	expected := sha256.Sum256([]byte("Bearer " + token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var actual [32]byte
		if v := r.Header.Values("Authorization"); len(v) == 1 {
			actual = sha256.Sum256([]byte(v[0]))
		}
		if token == "" || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			failure(w, 401, "unauthorized", "authentication required")
			return
		}
		if r.URL.Path != "/v1" && !strings.HasPrefix(r.URL.Path, "/v1/") {
			failure(w, 404, "not_found", "unknown operation")
			return
		}
		var body io.Reader
		if r.Body != nil {
			payload, err := io.ReadAll(io.LimitReader(r.Body, appendLimit+1))
			if err != nil {
				invalid(w)
				return
			}
			if len(payload) > appendLimit {
				failure(w, 413, "request_too_large", "history request too large")
				return
			}
			if len(payload) != 0 {
				body = bytes.NewReader(payload)
			}
		}
		req, err := http.NewRequestWithContext(r.Context(), r.Method, c.wire.URL+r.URL.RequestURI(), body)
		if err != nil {
			invalid(w)
			return
		}
		req.Header.Set("Authorization", "Bearer "+c.wire.Token)
		for _, name := range []string{"Content-Type", "Content-Encoding", "Cache-Control", revisionHeader} {
			for _, value := range r.Header.Values(name) {
				req.Header.Add(name, value)
			}
		}
		res, err := c.wire.HTTP.Do(req)
		if err != nil {
			unavailable(w)
			return
		}
		defer res.Body.Close()
		for _, name := range []string{"Content-Type", "Cache-Control", "Allow"} {
			for _, value := range res.Header.Values(name) {
				w.Header().Add(name, value)
			}
		}
		w.WriteHeader(res.StatusCode)
		_, _ = io.Copy(w, io.LimitReader(res.Body, pageLimit+1))
	})
}

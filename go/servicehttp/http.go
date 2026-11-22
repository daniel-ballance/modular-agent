// Package servicehttp contains the version 1 HTTP binding's authentication and framing.
package servicehttp

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/internal/telemetry"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const Limit = 32 << 20

type Failure struct {
	Error        string
	Kind         string
	Code         string  `json:"code,omitempty"`
	RetryAfterMS float64 `json:"retryAfterMs,omitempty"`
}

// ResponseError preserves the status and JSON fields of a definitive refusal.
type ResponseError struct {
	Status int
	Failure
}

func (e *ResponseError) Error() string {
	return fmt.Sprintf("service refused (%d): %s", e.Status, e.Failure.Error)
}

func Fail(w http.ResponseWriter, err error) {
	code, kind := http.StatusConflict, "refused"
	if errors.Is(err, os.ErrNotExist) {
		code, kind = http.StatusNotFound, "not_found"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(Failure{Error: err.Error(), Kind: kind})
}
func JSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, Limit)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(v); err != nil {
		http.Error(w, "invalid JSON body", 400)
		return false
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		http.Error(w, "trailing JSON body", 400)
		return false
	}
	return true
}
func Auth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "authentication required", 401)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func TokenFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("service token file unavailable")
	}
	token := strings.TrimSpace(string(b))
	if len(token) < 16 {
		return "", errors.New("service token must have at least 16 characters")
	}
	return token, nil
}

type Client struct {
	URL, Token string
	HTTP       *http.Client
}

func NewClient(base, token string) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 5 * time.Second
	transport.DisableCompression = true
	return &Client{strings.TrimRight(base, "/"), token, &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("service redirects refused") }}}
}

type traceRequestKey struct{}

// TraceRequest allows this configured service to receive the request trace.
func TraceRequest(ctx context.Context) context.Context {
	return context.WithValue(ctx, traceRequestKey{}, true)
}

func (c *Client) Open(ctx context.Context, path, key string, in any) (*http.Response, error) {
	return c.OpenMethod(ctx, "POST", path, key, in)
}

func (c *Client) OpenMethod(ctx context.Context, method, path, key string, in any) (*http.Response, error) {
	return c.OpenMethodHeaders(ctx, method, path, key, in, nil)
}

// OpenMethodHeaders adds binding-specific request headers.
func (c *Client) OpenMethodHeaders(ctx context.Context, method, path, key string, in any, headers http.Header) (*http.Response, error) {
	u, err := url.Parse(c.URL)
	if err != nil {
		return nil, err
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || host == "" ||
		(u.Scheme != "https" && !(u.Scheme == "http" && ip != nil && ip.IsLoopback())) {
		return nil, errors.New("services require HTTPS or loopback HTTP")
	}
	var body io.Reader
	if in != nil {
		if raw, ok := in.(json.RawMessage); ok {
			body = bytes.NewReader(raw)
		} else {
			body = bytes.NewReader(api.JSON(in))
		}
	}
	r, err := http.NewRequestWithContext(ctx, method, c.URL+path, body)
	if err != nil {
		return nil, err
	}
	for name, values := range headers {
		for _, value := range values {
			r.Header.Add(name, value)
		}
	}
	if ctx.Value(traceRequestKey{}) != nil {
		if w := telemetry.Inject(ctx); w != nil {
			r.Header.Set("traceparent", w.Parent)
		}
	}
	r.Header.Set("Authorization", "Bearer "+c.Token)
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	res, err := c.HTTP.Do(r)
	if err != nil {
		return nil, err
	}
	if len(res.Header.Values("Content-Encoding")) != 0 || res.Uncompressed {
		res.Body.Close()
		return nil, errors.New("encoded service response refused")
	}
	if res.StatusCode != 200 {
		defer res.Body.Close()
		var f Failure
		_ = json.NewDecoder(io.LimitReader(res.Body, Limit)).Decode(&f)
		if f.Kind == "not_found" || f.Code == "unknown_session" || f.Code == "unknown_entry" {
			return nil, os.ErrNotExist
		}
		return nil, &ResponseError{Status: res.StatusCode, Failure: f}
	}
	return res, nil
}

// Call retries transport failures only when the caller supplies a stable key
// for an operation whose API declares retry safety.
func (c *Client) Call(ctx context.Context, path, key string, in, out any) error {
	return c.CallMethod(ctx, "POST", path, key, in, out)
}

// CallMethod supports bindings with resource paths and safe HTTP verbs.
func (c *Client) CallMethod(ctx context.Context, method, path, key string, in, out any) error {
	var err error
	attempts := 1
	if key != "" {
		attempts = 3
	}
	for range attempts {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		attempt, cancel := context.WithTimeout(ctx, 5*time.Second)
		var res *http.Response
		res, err = c.OpenMethod(attempt, method, path, key, in)
		if err == nil {
			err = json.NewDecoder(io.LimitReader(res.Body, Limit)).Decode(out)
			res.Body.Close()
		}
		cancel()
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return err
		}
		// An HTTP refusal is definitive. Never turn it into a retry.
		var refusal *ResponseError
		if errors.As(err, &refusal) {
			return err
		}
	}
	return err
}

// Frame flushes each NDJSON item. The write deadline bounds slow/dead receivers.
func Frame(w http.ResponseWriter, v any) error {
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := json.NewEncoder(w).Encode(v); err != nil {
		return err
	}
	return http.NewResponseController(w).Flush()
}

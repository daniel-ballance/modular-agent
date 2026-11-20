// Package wswire carries JSON-RPC messages without changing their binding.
package wswire

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	Plugin           = "modular-agent-plugin-1"
	ACP              = "modular-agent-acp-1"
	MaxFrame         = 64 << 20
	handshakeTimeout = 5 * time.Second
)

type TLSOptions struct{ CertFile, KeyFile string }

// ReadToken does not include a token or file contents in diagnostics. Length is
// only a sanity check; the operator must generate at least 128 bits of entropy.
func ReadToken(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return "", errors.New("token file must be regular and accessible only by its owner")
	}
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	if len(b) > 4096 || len(token) < 16 || strings.IndexFunc(token, func(r rune) bool { return r <= ' ' || r >= 127 }) >= 0 {
		return "", errors.New("invalid bearer token file")
	}
	return token, nil
}

type credential[T any] struct {
	digest [sha256.Size]byte
	value  T
}

type Server struct {
	URL         string
	http        *http.Server
	mu          sync.Mutex
	closing     bool
	connections map[*Conn]struct{}
	workers     sync.WaitGroup
	once        sync.Once
	done        chan struct{}
	err         error
}

func (s *Server) Done() <-chan struct{} { return s.done }
func (s *Server) Close() error {
	s.once.Do(func() {
		s.mu.Lock()
		s.closing = true
		for c := range s.connections {
			go c.CloseNormal()
		}
		s.mu.Unlock()
		_ = s.http.Close()
		s.workers.Wait()
		close(s.done)
	})
	return s.err
}

// Listen authenticates every request before upgrading. Each token is scanned
// with the same fixed-length comparisons, regardless of its position or match.
func Listen[T any](ctx context.Context, addr string, secure *TLSOptions, protocol string, tokens map[string]T, serve func(context.Context, *Conn, T)) (*Server, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(tokens) == 0 {
		return nil, errors.New("at least one bearer token is required")
	}
	keys := make([]credential[T], 0, len(tokens))
	for token, value := range tokens {
		keys = append(keys, credential[T]{sha256.Sum256([]byte(token)), value})
	}
	scheme := "ws"
	var tlsConfig *tls.Config
	if secure != nil {
		cert, err := tls.LoadX509KeyPair(secure.CertFile, secure.KeyFile)
		if err != nil {
			return nil, err
		}
		tlsConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		scheme = "wss"
	}
	endpoint := &url.URL{Scheme: scheme, Host: addr, Path: "/"}
	if strings.Contains(addr, "://") {
		u, err := url.Parse(addr)
		if err != nil || u.Scheme != scheme || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
			return nil, errors.New("invalid WebSocket listen URL or TLS options")
		}
		endpoint = u
		if endpoint.Path == "" {
			endpoint.Path = "/"
		}
	}
	host, port, err := net.SplitHostPort(endpoint.Host)
	if err != nil || port == "" {
		return nil, errors.New("WebSocket listen address requires HOST:PORT")
	}
	if secure == nil {
		host = loopbackIP(host)
		if host == "" {
			return nil, errors.New("plain WebSocket requires a loopback listen address")
		}
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		ln = tls.NewListener(ln, tlsConfig)
	}
	endpoint.Host = ln.Addr().String()
	// Preserve a DNS name used by the certificate, with the actual bound port.
	if secure != nil && host != "" && net.ParseIP(host) == nil {
		_, boundPort, _ := net.SplitHostPort(endpoint.Host)
		endpoint.Host = net.JoinHostPort(host, boundPort)
	}
	s := &Server{URL: endpoint.String(), connections: map[*Conn]struct{}{}, done: make(chan struct{})}
	u := websocket.Upgrader{Subprotocols: []string{protocol}, HandshakeTimeout: handshakeTimeout}
	s.http = &http.Server{ReadHeaderTimeout: handshakeTimeout, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var given string
		if auth := r.Header.Values("Authorization"); len(auth) == 1 {
			scheme, token, ok := strings.Cut(auth[0], " ")
			if ok && strings.EqualFold(scheme, "Bearer") {
				given = token
			}
		}
		digest := sha256.Sum256([]byte(given))
		match := 0
		for i, key := range keys {
			match = subtle.ConstantTimeSelect(subtle.ConstantTimeCompare(digest[:], key.digest[:]), i+1, match)
		}
		if match == 0 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path != endpoint.Path {
			http.NotFound(w, r)
			return
		}
		offered := false
		for _, p := range websocket.Subprotocols(r) {
			offered = offered || p == protocol
		}
		if !offered {
			http.Error(w, "WebSocket subprotocol required", http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			http.Error(w, "Service stopping", http.StatusServiceUnavailable)
			return
		}
		wire, err := u.Upgrade(w, r, nil)
		if err != nil {
			s.mu.Unlock()
			return
		}
		c := wrap(wire)
		s.connections[c] = struct{}{}
		s.workers.Add(1)
		s.mu.Unlock()
		defer s.workers.Done()
		defer func() { _ = c.Close(); s.mu.Lock(); delete(s.connections, c); s.mu.Unlock() }()
		// Close sends a WebSocket close frame before interrupting the binding.
		serve(context.WithoutCancel(ctx), c, keys[match-1].value)
	})}
	go func() {
		err := s.http.Serve(ln)
		if !errors.Is(err, http.ErrServerClosed) {
			_ = s.closeWithError(err)
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
			_ = s.Close()
		case <-s.done:
		}
	}()
	return s, nil
}

func (s *Server) closeWithError(err error) error {
	// Serve errors are only observed through Done/Close. Serialize initialization
	// of err with Close by using the same once.
	s.mu.Lock()
	if !s.closing {
		s.err = err
	}
	s.mu.Unlock()
	return s.Close()
}

func loopbackIP(s string) string {
	if strings.EqualFold(s, "localhost") {
		return "127.0.0.1"
	}
	if ip := net.ParseIP(s); ip != nil && ip.IsLoopback() {
		return ip.String()
	}
	return ""
}

func Dial(ctx context.Context, address, tokenFile, protocol string) (*Conn, error) {
	u, err := url.Parse(address)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "ws" && u.Scheme != "wss") {
		return nil, errors.New("service URL must be ws: or wss: without userinfo or fragment")
	}
	d := websocket.Dialer{HandshakeTimeout: handshakeTimeout, Subprotocols: []string{protocol}}
	if u.Scheme == "ws" {
		ip := loopbackIP(u.Hostname())
		if ip == "" {
			return nil, errors.New("plain WebSocket requires a loopback destination")
		}
		d.NetDialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip, port))
		}
	}
	if !filepath.IsAbs(tokenFile) {
		return nil, errors.New("service tokenFile must be an absolute path")
	}
	token, err := ReadToken(tokenFile)
	if err != nil {
		return nil, err
	}
	c, resp, err := d.DialContext(ctx, address, http.Header{"Authorization": {"Bearer " + token}})
	if err != nil {
		if resp != nil {
			_ = resp.Body.Close()
			return nil, fmt.Errorf("WebSocket upgrade refused (HTTP %d)", resp.StatusCode)
		}
		return nil, err
	}
	if c.Subprotocol() != protocol {
		_ = c.Close()
		return nil, errors.New("WebSocket subprotocol not selected")
	}
	return wrap(c), nil
}

type Conn struct {
	wire    *websocket.Conn
	write   sync.Mutex
	pending []byte // newline adapter, consumed only by the binding reader
}

func wrap(c *websocket.Conn) *Conn { c.SetReadLimit(MaxFrame); return &Conn{wire: c} }
func (c *Conn) Close() error       { return c.wire.Close() }
func (c *Conn) CloseNormal()       { c.closeCode(websocket.CloseNormalClosure) }
func (c *Conn) closeCode(code int) {
	_ = c.wire.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""), time.Now().Add(time.Second))
	_ = c.Close()
}
func (c *Conn) ReadMessage() ([]byte, error) {
	kind, reader, err := c.wire.NextReader()
	if err != nil {
		return nil, err
	}
	if kind != websocket.TextMessage {
		c.closeCode(websocket.CloseUnsupportedData)
		return nil, errors.New("binary WebSocket message")
	}
	b, err := io.ReadAll(reader) // Gorilla bounds the accumulated fragment lengths before reading their payloads.
	if err == nil && !utf8.Valid(b) {
		c.closeCode(websocket.CloseInvalidFramePayloadData)
		return nil, errors.New("WebSocket text is not UTF-8")
	}
	return b, err
}
func (c *Conn) WriteMessage(b []byte) error {
	if len(b) > MaxFrame {
		return errors.New("WebSocket message exceeds 64 MiB")
	}
	c.write.Lock()
	defer c.write.Unlock()
	_ = c.wire.SetWriteDeadline(time.Now().Add(handshakeTimeout))
	return c.wire.WriteMessage(websocket.TextMessage, b)
}

// Read and Write adapt the maintained ACP SDK's one-line-per-write API. Only
// this adapter compacts whitespace: the plugin Peer reads messages natively.
func (c *Conn) Read(p []byte) (int, error) {
	if len(c.pending) == 0 {
		b, err := c.ReadMessage()
		if err != nil {
			return 0, err
		}
		frame := bytes.TrimSpace(b)
		if len(frame) == 0 || frame[0] != '{' || !json.Valid(b) {
			// In particular, do not let the community SDK dispatch a JSON-RPC batch.
			b = []byte("{}")
		} else if bytes.ContainsAny(b, "\r\n") {
			var compact bytes.Buffer
			_ = json.Compact(&compact, b)
			b = compact.Bytes()
		}
		c.pending = append(b, '\n')
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}
func (c *Conn) Write(p []byte) (int, error) {
	b := bytes.TrimSuffix(p, []byte{'\n'})
	if len(b) > MaxFrame {
		// ACP uses the same bounded failure for either a result or an error.
		// An update or question that cannot be sent is withheld instead.
		var header struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(b, &header) != nil {
			return 0, errors.New("invalid outgoing ACP message")
		}
		if header.Method != "" && len(header.ID) == 0 {
			return len(p), nil // withhold oversized updates without ending the session
		}
		if header.Method != "" || len(header.ID) == 0 {
			return 0, errors.New("ACP message withheld: exceeds 64 MiB")
		}
		b = fmt.Appendf(nil, `{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"Result exceeds 64 MiB","data":{"code":"result_too_large"}}}`, header.ID)
	}
	if err := c.WriteMessage(b); err != nil {
		return 0, err
	}
	return len(p), nil
}

package wswire

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testToken = "test-only-7ec88b6cbef734ac29e7eb14374c"

func TestWebSocketTLSAndAuthentication(t *testing.T) {
	dir := t.TempDir()
	cert, key, roots := selfSigned(t, dir)
	s, err := Listen(t.Context(), "127.0.0.1:0", &TLSOptions{cert, key}, Plugin, map[string]int{testToken: 23}, func(_ context.Context, c *Conn, principal int) {
		b, err := c.ReadMessage()
		if err == nil {
			_ = c.WriteMessage(fmt.Appendf(nil, `{"principal":%d,"echo":%s}`, principal, b))
		}
		_, _ = c.ReadMessage()
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	d := websocket.Dialer{Subprotocols: []string{Plugin}, TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	auth := http.Header{"Authorization": {"Bearer " + testToken}}
	for _, tc := range []struct {
		h      http.Header
		proto  string
		status int
	}{
		{nil, Plugin, 401}, {http.Header{"Authorization": {"Bearer wrong"}}, Plugin, 401}, {auth, ACP, 400},
	} {
		d.Subprotocols = []string{tc.proto}
		c, r, err := d.DialContext(t.Context(), s.URL, tc.h)
		if c != nil {
			_ = c.Close()
		}
		if r != nil {
			defer r.Body.Close()
		}
		if err == nil || r == nil || r.StatusCode != tc.status {
			t.Fatalf("upgrade = %v, %v; want HTTP %d", r, err, tc.status)
		}
	}
	d.Subprotocols = []string{Plugin}
	c, _, err := d.DialContext(t.Context(), s.URL, auth)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Subprotocol() != Plugin {
		t.Fatal("subprotocol not selected")
	}
	if err := c.WriteMessage(websocket.TextMessage, []byte("{\n\"some\":true\n}")); err != nil {
		t.Fatal(err)
	}
	kind, got, err := c.ReadMessage()
	if kind != websocket.TextMessage || string(got) != "{\"principal\":23,\"echo\":{\n\"some\":true\n}}" || err != nil {
		t.Fatalf("echo = %d %s %v", kind, got, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	_, _, err = c.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
		t.Fatalf("shutdown read = %v", err)
	}

	token := filepath.Join(dir, "token")
	if err := os.WriteFile(token, []byte(testToken), 0600); err != nil {
		t.Fatal(err)
	}
	s2, err := Listen(t.Context(), "127.0.0.1:0", &TLSOptions{cert, key}, Plugin, map[string]int{testToken: 23}, func(context.Context, *Conn, int) { t.Error("unauthenticated TLS connection was served") })
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if c, err := Dial(t.Context(), s2.URL, token, Plugin); err == nil {
		_ = c.Close()
		t.Fatal("SDK dial trusted an unknown self-signed certificate")
	}
}

func TestFrameCloseCodesAndLoopback(t *testing.T) {
	serve := func(_ context.Context, c *Conn, _ int) { _, _ = c.ReadMessage() }
	keys := map[string]int{testToken: 1}
	if s, err := Listen(t.Context(), "0.0.0.0:0", nil, Plugin, keys, serve); err == nil {
		_ = s.Close()
		t.Fatal("plain wildcard listener accepted")
	}
	s, err := Listen(t.Context(), "ws://127.0.0.1:0/socket", nil, Plugin, keys, serve)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, tc := range []struct {
		kind int
		b    []byte
		code int
	}{
		{websocket.BinaryMessage, []byte{1}, websocket.CloseUnsupportedData},
		{websocket.TextMessage, make([]byte, MaxFrame+1), websocket.CloseMessageTooBig},
	} {
		d := websocket.Dialer{Subprotocols: []string{Plugin}}
		c, _, err := d.DialContext(t.Context(), s.URL, http.Header{"Authorization": {"Bearer " + testToken}})
		if err != nil {
			t.Fatal(err)
		}
		_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		_ = c.WriteMessage(tc.kind, tc.b)
		_, _, err = c.ReadMessage()
		_ = c.Close()
		if !websocket.IsCloseError(err, tc.code) {
			t.Fatalf("got %v, want close %d", err, tc.code)
		}
	}
}

func selfSigned(t *testing.T, dir string) (string, string, *x509.CertPool) {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	pk, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cp, kp := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	b := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(cp, b, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(kp, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pk}), 0600); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(b)
	return cp, kp, roots
}

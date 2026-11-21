// Package pluginrpc implements modular-agent-plugin/1 over bidirectional stdio.
package pluginrpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"encoding/json/jsontext"
)

const Binding = "modular-agent-plugin/1"
const DataBinding = "modular-agent-data/1"
const MaxFrame = 64 * 1024 * 1024

type RPCError struct {
	Number  int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Code  string `json:"code"`
		Limit string `json:"limit,omitempty"`
	} `json:"data"`
}

func (e *RPCError) Error() string     { return e.Data.Code + ": " + e.Message }
func (e *RPCError) TurnLimit() string { return e.Data.Limit }

// Is gives local readers the same missing-file identity as a local environment,
// without depending on the remote error message or numerical JSON-RPC code.
func (e *RPCError) Is(target error) bool {
	return target == fs.ErrNotExist && e.Data.Code == "not_found" || target == context.Canceled && e.Data.Code == "cancelled"
}

func fault(code, message string) *RPCError {
	e := &RPCError{Number: -32000, Message: message}
	e.Data.Code = code
	switch code {
	case "invalid_request":
		e.Number = -32602
	case "parse_error":
		e.Number = -32700
	case "method_not_found":
		e.Number = -32601
	}
	return e
}
func Code(err error) string {
	var e *RPCError
	if errors.As(err, &e) && e != nil {
		return e.Data.Code
	}
	return ""
}

type envelope struct {
	Version string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
	after   <-chan struct{} // completion of this request's earlier stream notifications
}
type pending struct {
	ctx    context.Context
	method string
	result chan envelope
}
type requestIDKey struct{}
type incomingParentKey struct{}

// incomingParent is captured on receipt, before a later answer on the wire
// can invalidate the parent. The callback's worker may start after that answer.
type incomingParent struct {
	ctx    context.Context
	key    string
	method string
	ok     bool
}

func (p *Peer) requestParent(ctx context.Context, id json.RawMessage) (context.Context, bool) {
	if x, ok := ctx.Value(incomingParentKey{}).(incomingParent); ok {
		return x.ctx, x.ok
	}
	return p.Parent(id)
}

func RequestID(ctx context.Context) json.RawMessage {
	id, _ := ctx.Value(requestIDKey{}).(json.RawMessage)
	return id
}

type Handler func(context.Context, string, json.RawMessage) (any, error)
type Notification func(string, json.RawMessage)
type notificationHandler func(context.Context, string, json.RawMessage)

// inbox runs notifications in arrival order. Only work that depends on a
// particular notification waits for its barrier, never the connection reader.
type inbox struct {
	ready  *sync.Cond
	queue  []func()
	tail   map[string]chan struct{}
	bytes  int
	closed bool
	done   chan struct{}
}

func newInbox() *inbox {
	q := &inbox{ready: sync.NewCond(&sync.Mutex{}), tail: make(map[string]chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(q.done)
		q.ready.L.Lock()
		for {
			for len(q.queue) == 0 && !q.closed {
				q.ready.Wait()
			}
			if len(q.queue) == 0 {
				q.ready.L.Unlock()
				return
			}
			f := q.queue[0]
			q.queue[0] = nil
			q.queue = q.queue[1:]
			q.ready.L.Unlock()
			f()
			q.ready.L.Lock()
		}
	}()
	return q
}
func (q *inbox) push(key string, size int, f func()) bool {
	q.ready.L.Lock()
	defer q.ready.L.Unlock()
	// Reserve capacity for replies and cancels: the reader must not wait for
	// the notification worker, even if it is waiting on a nested RPC.
	if len(q.queue) >= 1024 || q.bytes+size > 2*MaxFrame {
		return false
	}
	q.bytes += size
	done := make(chan struct{})
	if key != "" {
		q.tail[key] = done
	}
	q.queue = append(q.queue, func() {
		f()
		q.ready.L.Lock()
		defer q.ready.L.Unlock()
		q.bytes -= size
		if q.tail[key] == done {
			delete(q.tail, key)
		}
		close(done)
	})
	q.ready.Signal()
	return true
}

func (q *inbox) barrier(key string) <-chan struct{} {
	if key == "" {
		return nil
	}
	q.ready.L.Lock()
	defer q.ready.L.Unlock()
	return q.tail[key]
}
func (q *inbox) finish(drain bool) {
	q.ready.L.Lock()
	q.closed = true
	if !drain {
		q.queue = nil
	}
	q.ready.Signal()
	q.ready.L.Unlock()
	if drain {
		<-q.done
	}
}

type messageConn interface {
	io.Closer
	ReadMessage() ([]byte, error)
	WriteMessage([]byte) error
	CloseNormal()
}

type Peer struct {
	in            io.ReadCloser
	out           io.Writer
	wire          messageConn
	wait          sync.WaitGroup
	afterResponse func(string)
	activity      func()
	lastActivity  time.Time // protected by mu; used only by network clients
	writeMu       sync.Mutex
	mu            sync.Mutex
	pending       map[string]pending
	active        map[string]context.CancelFunc
	next          atomic.Uint64
	ctx           context.Context
	cancel        context.CancelFunc
	done          chan struct{}
	Handle        Handler
	Notify        Notification
	notify        notificationHandler
	// Host-specific admission policies run on the reader. They must not
	// invoke handlers or wait for RPCs.
	admitNotification func(context.Context, envelope) (string, bool)
	requestBarrier    func(context.Context, envelope) string
	OnClose           func()
}

func NewPeer(in io.ReadCloser, out io.Writer) *Peer {
	ctx, cancel := context.WithCancel(context.Background())
	return &Peer{in: in, out: out, ctx: ctx, cancel: cancel, done: make(chan struct{}), pending: map[string]pending{}, active: map[string]context.CancelFunc{}}
}
func newMessagePeer(wire messageConn) *Peer {
	p := NewPeer(nil, nil)
	p.wire = wire
	return p
}

func (p *Peer) Parent(id json.RawMessage) (context.Context, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	x, ok := p.pending[string(id)]
	return x.ctx, ok
}
func (p *Peer) Send(method string, params any) error {
	return p.send(envelope{Method: method, Params: mustJSON(params)})
}
func mustJSON(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func (p *Peer) send(m envelope) error {
	m.Version = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > MaxFrame {
		if m.Method != "" || len(m.ID) == 0 {
			return fault("result_too_large", "message exceeds 64 MiB")
		}
		m.Result = nil
		if m.Error == nil {
			m.Error = fault("result_too_large", "result exceeds 64 MiB")
		} else {
			m.Error = fault(m.Error.Data.Code, "error exceeds 64 MiB")
		}
		b, _ = json.Marshal(m)
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if p.wire != nil {
		return p.wire.WriteMessage(b)
	}
	_, err = p.out.Write(append(b, '\n'))
	return err
}
func (p *Peer) Call(ctx context.Context, method string, params any, out any) error {
	return p.call(ctx, method, params, out, false)
}

// A cancelled Runtime request returns its recorded TurnOutcome, not just an
// acknowledgement. Keep its parent binding alive through cleanup.
func (p *Peer) call(ctx context.Context, method string, params any, out any, acceptCancelledResult bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.ctx.Err() != nil {
		return fault("lost", "plugin connection ended before "+method)
	}
	id := mustJSON(p.next.Add(1))
	key := string(id)
	ch := make(chan envelope, 1)
	p.mu.Lock()
	if p.activity != nil && len(p.pending) == 0 {
		p.heardLocked()
	}
	p.pending[key] = pending{ctx: ctx, method: method, result: ch}
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pending, key)
		if p.activity != nil {
			p.activity()
		}
		p.mu.Unlock()
	}()
	if err := p.send(envelope{ID: id, Method: method, Params: mustJSON(params)}); err != nil {
		if Code(err) != "" {
			return err
		}
		p.Close()
		return fault("lost", "plugin write failed during "+method+": "+err.Error())
	}
	var m envelope
	select {
	case m = <-ch:
	case <-p.done:
		// EOF can follow a final answer immediately.
		select {
		case m = <-ch:
		default:
			return fault("lost", "plugin connection ended during "+method)
		}
	case <-ctx.Done():
		if p.wire != nil && (method == "$/ping" || method == "plugin/initialize" || method == "plugin/shutdown") {
			p.Close()
			return fault("lost", "plugin control deadline reached during "+method)
		}
		_ = p.Send("$/cancel", map[string]any{"id": id})
		// Wait for the receiver to acknowledge cleanup, but never wait indefinitely
		// for a misbehaving peer. The process owner tears it down on lost.
		timer := time.NewTimer(4 * time.Second)
		defer timer.Stop()
		select {
		case m = <-ch:
			if !acceptCancelledResult {
				return ctx.Err()
			}
		case <-p.done:
			return fault("lost", "plugin connection ended during "+method)
		case <-timer.C:
			p.Close()
			return fault("lost", "plugin ignored cancellation")
		}
	}
	select {
	case <-m.after:
	default:
		if m.after != nil {
			select {
			case <-m.after:
			case <-ctx.Done():
				if !acceptCancelledResult {
					return ctx.Err()
				}
			case <-p.done:
				return fault("lost", "plugin connection ended during "+method)
			}
		}
	}
	if m.Error != nil {
		return m.Error
	}
	if out != nil {
		decoder := json.NewDecoder(bytes.NewReader(m.Result))
		decoder.UseNumber()
		if err := decoder.Decode(out); err != nil {
			return fault("internal", "invalid result: "+err.Error())
		}
	}
	return nil
}
func (p *Peer) Close() {
	p.cancel()
	if p.wire != nil {
		_ = p.wire.Close()
	} else {
		_ = p.in.Close()
	}
}
func (p *Peer) Done() <-chan struct{} { return p.done }
func (p *Peer) Run() error            { return p.run(true) }
func (p *Peer) run(drain bool) error {
	q := newInbox()
	defer func() {
		p.cancel()
		p.mu.Lock()
		for _, cancel := range p.active {
			cancel()
		}
		p.mu.Unlock()
		close(p.done)
		if p.OnClose != nil {
			go p.OnClose()
		}
		q.finish(drain)
	}()
	var read func() ([]byte, error)
	if p.wire != nil {
		read = p.wire.ReadMessage
	} else {
		scanner := bufio.NewScanner(p.in)
		scanner.Buffer(make([]byte, 64*1024), MaxFrame+1)
		read = func() ([]byte, error) {
			if scanner.Scan() {
				return scanner.Bytes(), nil
			}
			if err := scanner.Err(); err != nil {
				return nil, err
			}
			return nil, io.EOF
		}
	}
	seen := map[string]struct{}{}
	for {
		b, err := read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if p.activity != nil {
			p.mu.Lock()
			p.heardLocked()
			p.mu.Unlock()
		}
		if len(b) > MaxFrame {
			return fault("invalid_request", "frame exceeds 64 MiB")
		}
		if !jsontext.Value(b).IsValid() {
			if err := p.send(envelope{ID: json.RawMessage("null"), Error: fault("parse_error", "invalid JSON-RPC frame")}); err != nil {
				return err
			}
			continue
		}
		var fields map[string]json.RawMessage
		var m envelope
		fieldsErr := json.Unmarshal(b, &fields)
		decodeErr := json.Unmarshal(b, &m)
		key, idOK := rpcID(fields["id"])
		_, hasID := fields["id"]
		_, hasMethod := fields["method"]
		_, hasResult := fields["result"]
		_, hasError := fields["error"]
		if hasResult || hasError {
			if decodeErr != nil || m.Version != "2.0" || !idOK || hasMethod || hasResult == hasError || hasError && (m.Error == nil || m.Error.Data.Code == "") {
				return fault("lost", "invalid JSON-RPC response")
			}
			p.mu.Lock()
			x, ok := p.pending[key]
			delete(p.pending, key)
			p.mu.Unlock()
			if !ok {
				return fault("lost", "unexpected JSON-RPC response")
			}
			m.after = q.barrier(key)
			x.result <- m
			continue
		}
		if fieldsErr != nil || fields == nil || decodeErr != nil || m.Version != "2.0" || m.Method == "" || hasID && !idOK {
			id := m.ID
			if !idOK {
				id = json.RawMessage("null")
			}
			bad := fault("invalid_request", "invalid JSON-RPC envelope")
			bad.Number = -32600
			if err := p.send(envelope{ID: id, Error: bad}); err != nil {
				return err
			}
			continue
		}
		if hasID {
			if _, reused := seen[key]; reused || len(seen) >= 1_000_000 {
				return fault("lost", "request ID reused or budget exhausted")
			}
			seen[key] = struct{}{}
		}
		if len(m.ID) == 0 {
			if m.Method == "$/cancel" {
				var v struct {
					ID json.RawMessage `json:"id"`
				}
				_ = json.Unmarshal(m.Params, &v)
				p.mu.Lock()
				key, _ := rpcID(v.ID)
				cancel := p.active[key]
				p.mu.Unlock()
				if cancel != nil {
					cancel()
				}
			} else if p.notify != nil || p.Notify != nil {
				ctx := p.captureParent(p.ctx, m.Params)
				key := capturedParent(ctx).key
				if p.admitNotification != nil {
					var admit bool
					key, admit = p.admitNotification(ctx, m)
					if !admit {
						continue
					}
				}
				if !q.push(key, len(b), func() {
					if p.notify != nil {
						p.notify(ctx, m.Method, m.Params)
					} else {
						p.Notify(m.Method, m.Params)
					}
				}) && m.Method == "tools/changed" {
					return fault("lost", "notification queue full during catalog invalidation")
				}
			}
			continue
		}
		ctx, cancel := context.WithCancel(p.ctx)
		ctx = context.WithValue(ctx, requestIDKey{}, m.ID)
		if strings.HasPrefix(m.Method, "host/") {
			ctx = p.captureParent(ctx, m.Params)
		}
		var after <-chan struct{}
		if p.requestBarrier != nil {
			after = q.barrier(p.requestBarrier(ctx, m))
		}
		p.mu.Lock()
		p.active[key] = cancel
		p.mu.Unlock()
		p.wait.Go(func() {
			if after != nil {
				select {
				case <-after:
				case <-ctx.Done():
				}
			}
			p.answer(ctx, m, cancel)
		})
	}
}

func (p *Peer) heardLocked() {
	p.lastActivity = time.Now()
	p.activity()
}

func (p *Peer) captureParent(ctx context.Context, raw json.RawMessage) context.Context {
	var params struct {
		Parent json.RawMessage `json:"parentRequestId"`
	}
	_ = json.Unmarshal(raw, &params)
	key, _ := rpcID(params.Parent)
	p.mu.Lock()
	parent, ok := p.pending[key]
	p.mu.Unlock()
	var captured incomingParent
	if ok {
		captured = incomingParent{ctx: parent.ctx, key: key, method: parent.method, ok: true}
	}
	return context.WithValue(ctx, incomingParentKey{}, captured)
}

func capturedParent(ctx context.Context) incomingParent {
	x, _ := ctx.Value(incomingParentKey{}).(incomingParent)
	return x
}

func (p *Peer) answer(ctx context.Context, m envelope, cancel context.CancelFunc) {
	defer cancel()
	result, err := p.handle(ctx, m)
	response := envelope{ID: m.ID}
	if err == nil {
		response.Result, err = json.Marshal(result)
	}
	if err != nil {
		var e *RPCError
		if errors.As(err, &e) {
			response.Error = e
		} else if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			response.Error = fault("cancelled", err.Error())
		} else {
			response.Error = fault("internal", err.Error())
		}
	}
	p.mu.Lock()
	key, _ := rpcID(m.ID)
	delete(p.active, key)
	p.mu.Unlock()
	if p.ctx.Err() == nil {
		if err := p.send(response); err != nil {
			p.Close()
		} else if response.Error == nil && p.afterResponse != nil {
			p.afterResponse(m.Method)
		}
	}
}

func (p *Peer) handle(ctx context.Context, m envelope) (result any, err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fault("internal", fmt.Sprintf("handler panic: %v", v))
		}
	}()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if m.Method == "$/ping" {
		return map[string]any{}, nil
	}
	if p.Handle != nil {
		return p.Handle(ctx, m.Method, m.Params)
	}
	return nil, unknownMethod(m.Method)
}
func unknownMethod(_ string) *RPCError {
	return fault("method_not_found", "method not found")
}

func rpcID(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	if raw[0] == '"' {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			return string(mustJSON(value)), true
		}
		return "", false
	}
	// An ID must be an integer, not a boolean, null or compound value.
	var number *int64
	if json.Unmarshal(raw, &number) != nil || number == nil || *number < -9007199254740991 || *number > 9007199254740991 {
		return "", false
	}
	return string(mustJSON(*number)), true
}

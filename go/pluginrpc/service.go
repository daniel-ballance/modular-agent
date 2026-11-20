package pluginrpc

import (
	"context"
	"time"

	"github.com/daniel-ballance/modular-agent/go/internal/wswire"
)

const defaultPingInterval = 30 * time.Second
const defaultControlDeadline = 5 * time.Second

func (r *remote) startService(ctx context.Context, spec Spec) error {
	c, err := wswire.Dial(ctx, spec.URL, spec.TokenFile, wswire.Plugin)
	if err != nil {
		return err
	}
	r.stdin = c
	r.peer = newMessagePeer(c)
	r.deadline = spec.ControlDeadline
	if r.deadline == 0 {
		r.deadline = defaultControlDeadline
	}
	interval := spec.PingInterval
	if interval == 0 {
		interval = defaultPingInterval
	}
	r.peer.startLiveness(interval, r.deadline)
	return nil
}

// Only pending work requires a ping. Record both the first pending call and
// inbound messages, so idle connections can be kept for arbitrary periods.
func (p *Peer) startLiveness(interval, deadline time.Duration) {
	wake := make(chan struct{}, 1)
	p.activity = func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	go func() {
		for {
			p.mu.Lock()
			count, last := len(p.pending), p.lastActivity
			p.mu.Unlock()
			if count == 0 {
				select {
				case <-wake:
					continue
				case <-p.ctx.Done():
					return
				}
			}
			delay := time.Until(last.Add(interval))
			if delay > 0 {
				timer := time.NewTimer(delay)
				select {
				case <-wake:
					timer.Stop()
					continue
				case <-p.ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
					continue
				}
			}
			// The ping requires its own matching response; unrelated notifications
			// cannot keep a wedged control path alive.
			ctx, cancel := context.WithTimeout(p.ctx, deadline)
			err := p.Call(ctx, "$/ping", object{}, nil)
			cancel()
			if err != nil {
				p.Close()
				return
			}
		}
	}()
}

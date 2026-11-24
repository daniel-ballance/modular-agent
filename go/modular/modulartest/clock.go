package modulartest

import (
	"github.com/daniel-ballance/modular-agent/go/internal/worktime"
	"sync"
	"testing"
	"time"
)

// ManualClock controls committed work deadlines. Install it before starting an
// agent. Use in a single test process, not in parallel tests.
type ManualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers map[*clockTimer]bool
}
type clockTimer struct {
	clock *ManualClock
	at    time.Time
	f     func()
}

func (t *clockTimer) Stop() bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	active := c.timers[t]
	delete(c.timers, t)
	return active
}

func UseClock(t testing.TB, start time.Time) *ManualClock {
	t.Helper()
	c, restore := InstallClock(start)
	t.Cleanup(restore)
	return c
}

// InstallClock controls deadlines in a standalone fixture process.
func InstallClock(start time.Time) (*ManualClock, func()) {
	c := &ManualClock{now: start, timers: map[*clockTimer]bool{}}
	return c, worktime.Install(c)
}
func (c *ManualClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *ManualClock) At(at time.Time, f func()) worktime.Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &clockTimer{c, at, f}
	if at.After(c.now) {
		c.timers[t] = true
	} else {
		go f()
	}
	return t
}

// Advance fires all due callbacks before returning.
func (c *ManualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var fire []func()
	for t := range c.timers {
		if !t.at.After(c.now) {
			delete(c.timers, t)
			fire = append(fire, t.f)
		}
	}
	c.mu.Unlock()
	for _, f := range fire {
		f()
	}
}

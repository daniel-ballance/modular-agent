// Package worktime supplies the Harness clock for committed work deadlines.
package worktime

import (
	"sync/atomic"
	"time"
)

type Timer interface{ Stop() bool }
type Clock interface {
	Now() time.Time
	At(time.Time, func()) Timer
}
type source struct{ Clock }

var clock atomic.Pointer[source]

// Install replaces only the work clock, not test hang guards or network clocks.
func Install(c Clock) func() { old := clock.Swap(&source{c}); return func() { clock.Store(old) } }

var Now = func() time.Time {
	if c := clock.Load(); c != nil {
		return c.Now()
	}
	return time.Now()
}
var At = func(deadline time.Time, f func()) Timer {
	if c := clock.Load(); c != nil {
		return c.At(deadline, f)
	}
	return time.AfterFunc(time.Until(deadline), f)
}

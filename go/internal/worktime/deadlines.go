// Package worktime supplies the clock for committed work deadlines. The process
// fixture installs its manual clock before constructing the agent.
package worktime

import "time"

type Timer interface{ Stop() bool }

var Now = time.Now
var At = func(deadline time.Time, f func()) Timer { return time.AfterFunc(time.Until(deadline), f) }

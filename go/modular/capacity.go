package modular

import "github.com/daniel-ballance/modular-agent/go/harness"

// CapacityBounds sets the work ceilings for one session, tenant or agent.
// Zero is a ceiling of zero. Sessions without a tenant share one bucket.
type CapacityBounds = harness.CapacityBounds

type CapacityLimits = harness.CapacityLimits

func DefaultCapacityLimits() CapacityLimits { return harness.DefaultCapacityLimits() }

// WithCapacityLimits replaces the default work ceilings before opening sessions.
func WithCapacityLimits(limits CapacityLimits) Option {
	return func(o *options) error {
		for _, b := range []CapacityBounds{limits.Session, limits.Tenant, limits.Agent} {
			if b.ControlBytes > b.StorageBytes {
				return &Error{Code: InvalidComposition, Message: "controlBytes cannot exceed storageBytes"}
			}
			for _, n := range []int64{b.Inputs, b.Calls, b.Jobs, b.BufferedBytes, b.StorageBytes, b.ControlBytes} {
				if n < 0 || n > 9007199254740991 {
					return &Error{Code: InvalidComposition, Message: "invalid capacity ceiling"}
				}
			}
		}
		o.capacity = &limits
		return nil
	}
}

// CapacityLimits returns the operator's ceilings, not live use.
func (a *Agent) CapacityLimits() CapacityLimits { return a.h.CapacityLimits() }

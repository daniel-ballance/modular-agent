package modular

import "context"

// RestartForTest interrupts sessions without writing graceful turn outcomes,
// releases the simulated process's resources, and rebuilds the composition.
// Use a real killed process to test external plugins or process cleanup.
func (a *Agent) RestartForTest(ctx context.Context) (*Agent, error) {
	if a.restart == nil {
		return nil, &Error{Code: NotSupported, Message: "simulated restart requires in-process plugins"}
	}
	if a.closed.Load() {
		return nil, &Error{Code: NotOpen, Message: "agent is closed"}
	}
	if err := ctx.Err(); err != nil {
		return nil, appError(err, CancelledCode)
	}
	a.restarting.Store(true)
	if err := a.Close(ctx); err != nil {
		return nil, err
	}
	return a.restart(ctx)
}

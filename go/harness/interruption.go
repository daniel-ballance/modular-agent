package harness

import (
	"context"
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
)

func (c *client) newSessionState(id, project string) *session {
	return &session{id: id, project: project, h: c.h, interrupted: make(chan struct{}),
		interruptEmitted: make(chan struct{}), writerWatchDone: make(chan struct{})}
}

// SessionInterruption gives waiters an independent signal: the output gate may
// withhold the event, but cannot turn unsettled work into a successful reply.
func (c *client) SessionInterruption(id string) (lost, emitted <-chan struct{}, err error) {
	s, err := c.find(id)
	if err != nil {
		return nil, nil, err
	}
	return s.interrupted, s.interruptEmitted, nil
}

func (s *session) watchWriter() {
	writer, ok := s.lease.(interface{ WriterLost() <-chan struct{} })
	if !ok {
		return
	}
	go func() {
		select {
		case <-s.writerWatchDone:
		case <-s.interrupted:
		case <-writer.WriterLost():
			s.mu.Lock()
			defer s.mu.Unlock()
			select {
			case <-s.writerWatchDone:
			default:
				s.stopWriterLocked(api.ErrWriterLost)
			}
		}
	}()
}

func (s *session) stopWriterLocked(cause error) error {
	if s.writerFailure != nil {
		return s.writerFailure
	}
	reason := "commitFailed"
	if errors.Is(cause, api.ErrWriterLost) {
		reason = "writerLost"
	}
	s.writerFailure = errors.Join(api.ErrSessionLost, cause)
	for id := range s.jobSpans {
		s.endJobSpan(id, "interrupted")
	}
	if s.cancel != nil {
		s.cancel(api.ErrProcessStopped)
	}
	for token := range s.commandCancels {
		token.cancel(api.ErrProcessStopped)
	}
	close(s.interrupted)
	// Gates and followers may read the session. Never invoke them under its lock.
	go func() {
		defer close(s.interruptEmitted)
		s.h.API().Emit(context.Background(), api.Event{Kind: api.SessionInterrupted, Session: s.id,
			Data: api.JSON(map[string]string{"reason": reason})})
	}()
	return s.writerFailure
}

func (s *session) checkWriterLocked() error {
	if s.writerFailure != nil {
		return s.writerFailure
	}
	if writer, ok := s.lease.(interface{ WriterLost() <-chan struct{} }); ok {
		select {
		case <-writer.WriterLost():
			return s.stopWriterLocked(api.ErrWriterLost)
		default:
		}
	}
	if writer, ok := s.lease.(interface{ CheckWriter() error }); ok {
		if err := writer.CheckWriter(); err != nil {
			return s.stopWriterLocked(errors.Join(api.ErrWriterLost, err))
		}
	}
	return nil
}

type commandCancellation struct{ cancel context.CancelCauseFunc }

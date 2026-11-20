package credentials

import (
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// Stages is the persistent staging state. Callers mutate it and Answers under
// the same cross-process lock and commit both in one durable replacement.
type Stages struct {
	Requests    map[string]map[string]stage `json:"secretStages,omitempty"`
	Generations map[string]uint64           `json:"secretGenerations,omitempty"`
}

type stage struct {
	Receipt    api.SecretReceipt  `json:"receipt"`
	Value      string             `json:"value,omitempty"`
	Generation uint64             `json:"generation,omitempty"`
	Decision   api.SecretDecision `json:"decision,omitempty"`
	Baseline   *string            `json:"baseline,omitempty"`
}

var errStage = errors.New("secret stage unavailable")

func (s *Stages) set(session, request string, v stage) {
	if s.Requests == nil {
		s.Requests = make(map[string]map[string]stage)
	}
	if s.Requests[session] == nil {
		s.Requests[session] = make(map[string]stage)
	}
	s.Requests[session][request] = v
}

func (s *Stages) Stage(answers map[string]string, session, request, name, actor, value string) (api.SecretReceipt, error) {
	if _, ok := s.Requests[session][request]; ok || session == "" || request == "" || name == "" || actor == "" {
		return api.SecretReceipt{}, errStage
	}
	receipt := api.SecretReceipt{Session: session, Request: request, Name: name, Actor: actor, ID: api.ID()}
	v := stage{Receipt: receipt, Value: value, Generation: s.Generations[name]}
	if old, ok := answers[name]; ok {
		v.Baseline = &old
	}
	s.set(session, request, v)
	return receipt, nil
}

func (s *Stages) Lookup(session, request string) (api.SecretReceipt, bool) {
	v := s.Requests[session][request]
	return v.Receipt, v.Receipt.ID != ""
}

func (s *Stages) Activate(answers map[string]string, receipt api.SecretReceipt) (api.SecretDecision, error) {
	v := s.Requests[receipt.Session][receipt.Request]
	if receipt.ID == "" || v.Receipt != receipt {
		return "", errStage
	}
	if v.Decision != "" {
		return v.Decision, nil
	}
	name := receipt.Name
	current, present := answers[name]
	if s.Generations[name] != v.Generation || present != (v.Baseline != nil) || (present && current != *v.Baseline) {
		v.Decision = api.SecretSuperseded
	} else {
		s.advance(name)
		answers[name] = v.Value
		v.Decision = api.SecretActivated
	}
	v.Value, v.Baseline = "", nil
	s.set(receipt.Session, receipt.Request, v)
	return v.Decision, nil
}

func (s *Stages) advance(name string) {
	if s.Generations == nil {
		s.Generations = make(map[string]uint64)
	}
	s.Generations[name]++
}

func (s *Stages) Discard(session, request string) {
	v := s.Requests[session][request]
	if v.Decision == api.SecretActivated || v.Decision == api.SecretSuperseded {
		return
	}
	s.set(session, request, stage{Decision: api.SecretDiscarded})
}

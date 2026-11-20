package questions

import (
	"context"
	"errors"

	"github.com/daniel-ballance/modular-agent/go/api"
)

func (m *Manager) secretStore() api.StagedCredentials {
	v, _ := m.a.Get("credentials")
	store, _ := v.(api.StagedCredentials)
	return store
}

var errDeadline = errors.New("question deadline passed")

func (m *Manager) selectSecret(ctx context.Context, store api.StagedCredentials, q api.Question, a api.Answer) error {
	receipt, err := store.Stage(ctx, q.Session, q.ID, q.Credential, a.Actor, a.Value)
	if err != nil {
		return errors.New("secret staging failed")
	}
	if expired(q) {
		return errDeadline
	}
	if receipt.ID == "" || receipt.Session != q.Session || receipt.Request != q.ID || receipt.Name != q.Credential || receipt.Actor != a.Actor || !m.valid(q, a) {
		return api.ErrAnswerAuthority
	}
	_, err = m.a.Record(ctx, q.Session, api.Entry{Kind: "question.secret", Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: a.Actor, Copies: []string{q.ID}, Data: api.JSON(q.ID)})
	return err
}

func (m *Manager) activateSecret(ctx context.Context, store api.StagedCredentials, q api.Question, actor string) (api.SecretDecision, error) {
	receipt, ok, err := store.LookupStaged(ctx, q.Session, q.ID)
	if err != nil || !ok || receipt.ID == "" || receipt.Session != q.Session || receipt.Request != q.ID || receipt.Name != q.Credential || receipt.Actor != actor {
		return "", errors.New("secret receipt unavailable")
	}
	decision, err := store.Activate(ctx, receipt)
	if err != nil || (decision != api.SecretActivated && decision != api.SecretSuperseded) {
		return "", errors.New("secret activation unconfirmed")
	}
	return decision, nil
}

// Recover selected work before recovery dispatch, and ensure no unselected
// credential value survives as a usable stage.
func (m *Manager) recoverSecrets(ctx context.Context, s api.Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	store := m.secretStore()
	for _, st := range states(s) {
		q := st.q.Question
		if q.Kind != "secret" {
			continue
		}
		if st.selected != "" && st.answer == nil {
			if store == nil {
				return errors.New("selected secret requires its credential store")
			}
			d, err := m.activateSecret(ctx, store, q, st.selected)
			if err != nil {
				return err
			}
			a := api.Answer{Request: q.ID, Actor: st.selected, Value: q.Credential, Stored: q.Credential}
			if d == api.SecretSuperseded {
				a.Value, a.Stored, a.Declined, a.Reason = "", "", true, "superseded"
			}
			if _, err = m.a.Record(ctx, q.Session, api.Entry{Kind: "question.answer", Turn: q.Turn, Step: q.Step, Call: q.Call, Actor: a.Actor, Copies: []string{q.ID}, Data: api.JSON(a)}); err != nil {
				return err
			}
			continue
		}
		if store == nil || st.selected != "" || st.answer != nil && !st.answer.Declined {
			continue
		}
		if st.answer == nil {
			// With neither an accepted receipt nor a terminal answer, a pre-crash
			// submission has no authority. The original question cannot restage.
			_, exists, err := store.LookupStaged(ctx, q.Session, q.ID)
			if err != nil {
				return errors.New("secret staging lookup failed")
			}
			if !exists {
				continue
			}
			a := api.Answer{Request: q.ID, Declined: true, Reason: "noLongerAnswerable"}
			if _, err = m.a.Record(ctx, q.Session, api.Entry{Kind: "question.answer", Turn: q.Turn, Step: q.Step, Call: q.Call, Copies: []string{q.ID}, Data: api.JSON(a)}); err != nil {
				return err
			}
		}
		if err := store.Discard(ctx, q.Session, q.ID); err != nil {
			return errors.New("secret discard unconfirmed")
		}
	}
	return nil
}

package terminal

import (
	"context"
	"errors"
	"modular/api"
	"os"
	"strings"
)

// Answers bypass input hooks and command logging. Secret bytes reach only the
// question service's credential-write boundary, never Submit or the Runtime.
func (t *Terminal) answer(ctx context.Context, id, line string) (err error) {
	defer func() {
		if err != nil {
			t.a.Emit(ctx, api.Event{Kind: "interface.error", Session: id, Data: api.JSON(err.Error())})
		}
	}()
	fields := strings.SplitN(strings.TrimSpace(line), " ", 3)
	if len(fields) != 3 || fields[1] == "" {
		return errors.New("usage: /answer request-id value, or /secret request-id file")
	}
	v, e := t.a.Get("questions")
	if e != nil {
		return e
	}
	q := v.(api.Questions)
	list, e := q.List(id)
	if e != nil {
		return e
	}
	var question *api.Question
	for i := range list {
		if list[i].ID == fields[1] {
			question = &list[i]
		}
	}
	if question == nil {
		return errors.New("unknown request")
	}
	value := fields[2]
	if question.Kind == "secret" {
		if fields[0] != "/secret" {
			return errors.New("secret answers require /secret request-id file")
		}
		b, e := os.ReadFile(value)
		if e != nil {
			return errors.New("secret file unavailable")
		}
		value = string(b)
	} else if fields[0] == "/secret" {
		return errors.New("request does not accept a secret")
	}
	if err = q.Answer(ctx, id, api.Answer{Request: question.ID, Value: value}); err != nil {
		return err
	}
	t.a.Emit(ctx, api.Event{Kind: "interface.message", Session: id, Data: api.JSON("Answer accepted.")})
	return nil
}

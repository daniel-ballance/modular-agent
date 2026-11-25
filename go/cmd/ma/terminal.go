package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type display struct {
	out, err                 io.Writer
	json, verbose, line, mid bool
	calls                    map[string]modular.ToolCall
}

func (d *display) event(e modular.Event) error {
	if d.json {
		return writeJSON(d.out, e, false)
	}
	switch e := e.(type) {
	case modular.TextEvent:
		if d.line {
			fmt.Fprint(d.out, e.Delta)
			if e.Delta != "" {
				d.mid = !strings.HasSuffix(e.Delta, "\n")
			}
		}
	case modular.EndEvent:
		if d.line && d.mid {
			fmt.Fprintln(d.out)
			d.mid = false
		}
		if d.line && e.Outcome.Error != "" {
			fmt.Fprintln(d.err, e.Outcome.Error)
		}
	case interface{ Raw() modular.DataEvent }:
		raw := e.Raw()
		id := raw.CallID
		switch raw.Type {
		case "toolCall":
			var v struct{ Call modular.ToolCall }
			if json.Unmarshal(raw.Data, &v) == nil {
				d.calls[v.Call.ID] = v.Call
			}
		case "toolStarted":
			c := d.calls[id]
			if c.Name == "" {
				return nil
			}
			nested := c.ParentCallID != "" || c.StartedBy == "tool"
			if nested && !d.verbose {
				return nil
			}
			if c.Name == "codemode" {
				var v struct{ Code string }
				_ = json.Unmarshal(c.Input, &v)
				fmt.Fprintln(d.err, "codemode")
				for _, line := range strings.Split(v.Code, "\n") {
					fmt.Fprintf(d.err, "  | %s\n", line)
				}
			} else {
				prefix := ""
				if nested {
					prefix = "  -> "
				}
				args := []rune(string(c.Input))
				fmt.Fprintf(d.err, "%s%s(%s)\n", prefix, c.Name, string(args[:min(200, len(args))]))
			}
		case "toolOutput":
			if d.verbose {
				var v struct{ Chunk string }
				if json.Unmarshal(raw.Data, &v) == nil {
					fmt.Fprint(d.err, v.Chunk)
				}
			}
		case "toolResult":
			c := d.calls[id]
			delete(d.calls, id)
			if (c.ParentCallID != "" || c.StartedBy == "tool") && !d.verbose {
				return nil
			}
			var v struct {
				Status  string
				Content modular.Content
			}
			if json.Unmarshal(raw.Data, &v) == nil && v.Status != "completed" {
				line, _, _ := strings.Cut(strings.TrimSpace(v.Content.Text()), "\n")
				fmt.Fprintf(d.err, "  %s: %s\n", v.Status, line)
			}
		case "inputHandedBack":
			fmt.Fprintln(d.err, "Returned input:", string(raw.Data))
		}
	}
	return nil
}
func slashCommand(line string) bool {
	return strings.HasPrefix(line, "/") && !strings.HasPrefix(line, "/skill:")
}
func printTurn(ctx context.Context, s *modular.Session, o options, out, stderr io.Writer, interrupts <-chan os.Signal) (errOut error) {
	if line := strings.TrimSpace(*o.prompt); slashCommand(line) {
		v, err := s.RunCommand(ctx, line)
		if err != nil {
			return err
		}
		if v != "" {
			fmt.Fprintln(out, v)
		}
		return nil
	}
	if o.approval != "" && o.policy.ApprovalWaitMaxMs > 0 && o.session != "" {
		settings, err := s.Settings(ctx)
		if err != nil {
			return err
		}
		if settings["approvalWait"] == "untilDeadline" {
			// Do not switch an earlier parked call to live: that would refuse it.
			qs, err := s.Questions(ctx)
			if err != nil {
				return err
			}
			for _, q := range qs {
				if q.ApprovalWait == "untilDeadline" {
					return errors.New("this session has a waiting approval; answer it before using print mode")
				}
			}
			if err := s.SetSetting(ctx, "approvalWait", "live"); err != nil {
				return err
			}
			defer func() {
				if err := s.WaitIdle(ctx); err != nil {
					errOut = errors.Join(errOut, err)
					return
				}
				errOut = errors.Join(errOut, s.SetSetting(ctx, "approvalWait", "untilDeadline"))
			}()
		}
	}
	work, done := context.WithCancel(ctx)
	defer done()
	go func() {
		select {
		case <-interrupts:
			_, _ = s.Cancel(work)
		case <-work.Done():
		}
	}()
	d := display{out: out, err: stderr, json: o.json, verbose: o.verbose, calls: map[string]modular.ToolCall{}}
	var ended *modular.EndEvent
	for e, err := range s.PromptStream(ctx, *o.prompt) {
		if err != nil {
			return err
		}
		if err = d.event(e); err != nil {
			return err
		}
		if end, ok := e.(modular.EndEvent); ok {
			ended = &end
		}
	}
	if ended == nil {
		return errors.New("the input did not complete a turn")
	}
	if ended.Outcome.Kind != "completed" {
		if ended.Outcome.Error != "" {
			return errors.New(ended.Outcome.Error)
		}
		return fmt.Errorf("turn %s", ended.Outcome.Kind)
	}
	if !o.json {
		fmt.Fprintln(out, ended.Result.Text)
	}
	return nil
}

type ask struct {
	q     modular.Question
	reply chan modular.Answer
	done  <-chan struct{}
}

func lineMode(ctx context.Context, s *modular.Session, o options, in io.Reader, out, stderr io.Writer, interrupts <-chan os.Signal) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	lines := make(chan string)
	readErr := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
		readErr <- scanner.Err()
		close(lines)
	}()
	queries := make(chan ask)
	if err := s.OnQuestion(ctx, func(ctx context.Context, q modular.Question) (modular.Answer, error) {
		a := ask{q, make(chan modular.Answer, 1), ctx.Done()}
		select {
		case queries <- a:
		case <-ctx.Done():
			return modular.Answer{}, ctx.Err()
		}
		select {
		case ans := <-a.reply:
			return ans, nil
		case <-ctx.Done():
			return modular.Answer{}, ctx.Err()
		}
	}); err != nil {
		return err
	}
	history, err := s.History(ctx)
	if err != nil {
		return err
	}
	var cursor []string
	if len(history) > 0 {
		if id, ok := history[len(history)-1]["id"].(string); ok {
			cursor = []string{id}
		}
	}
	events := make(chan modular.Event)
	streamError := make(chan error, 1)
	go func() {
		for event, err := range s.Events(ctx, cursor...) {
			if err != nil {
				streamError <- err
				return
			}
			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	d := display{out: out, err: stderr, json: o.json, verbose: o.verbose, line: true, calls: map[string]modular.ToolCall{}}
	fmt.Fprintln(stderr, "Session "+s.ID())
	var question *ask
	var questionDone <-chan struct{}
	var waiting chan error
	hidden := hiddenInput(in)
	// restore is set while a secret is read with echo off.
	var restore func()
	var secretFor string
	defer func() {
		if restore != nil {
			restore()
		}
	}()
	endSecret := func() string {
		id := secretFor
		restore()
		restore, secretFor = nil, ""
		fmt.Fprintln(stderr)
		return id
	}
	reply := func(id string, a modular.Answer) bool {
		if question == nil || question.q.ID != id {
			return false
		}
		question.reply <- a
		question, questionDone = nil, nil
		return true
	}
	answerLine := func(args string) {
		id, value, given := strings.Cut(args, " ")
		if question == nil || question.q.ID != id {
			fmt.Fprintln(stderr, "no question named "+id)
			return
		}
		secret := question.q.Kind == "secret"
		switch {
		case given && value == "decline":
			reply(id, modular.Decline("declined"))
		case secret && given:
			fmt.Fprintln(stderr, "Do not put the secret on the command line; use /answer REQUEST_ID")
		case secret:
			off, err := hidden.echoOff()
			if err != nil {
				reply(id, modular.Decline("no secret was read"))
				fmt.Fprintln(stderr, err)
				return
			}
			restore, secretFor = off, id
			fmt.Fprint(stderr, "Secret: ")
		case !given:
			fmt.Fprintln(stderr, "use /answer REQUEST_ID VALUE")
		default:
			reply(id, modular.Answer{Value: value})
		}
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-streamError:
			return err
		case event := <-events:
			if err := d.event(event); err != nil {
				return err
			}
		case <-questionDone:
			question, questionDone = nil, nil
		case q := <-queries:
			if lines == nil {
				q.reply <- modular.Decline("end of input")
				continue
			}
			if q.q.Kind == "secret" && hidden == nil {
				q.reply <- modular.Decline("a secret needs a terminal to hide it")
				continue
			}
			if question != nil {
				q.reply <- modular.Decline("another question is open")
				continue
			}
			question = &q
			questionDone = q.done
			if q.q.Kind == "approval" {
				fmt.Fprintln(stderr, q.q.Question)
				fmt.Fprintln(stderr, "Allow? (y/n)")
			} else {
				options, usage := "", "VALUE"
				if len(q.q.Options) > 0 {
					raw, _ := json.Marshal(q.q.Options)
					options = " " + string(raw)
				}
				if q.q.Kind == "secret" {
					usage = "(hidden input)"
				}
				fmt.Fprintf(stderr, "Question %s: %s%s\nUse /answer REQUEST_ID %s\n", q.q.ID, q.q.Question, options, usage)
			}
		case <-interrupts:
			if restore != nil {
				reply(endSecret(), modular.Decline("no secret was read"))
			}
			busy, e := s.Busy()
			if e != nil {
				return e
			}
			if !busy {
				return nil
			}
			_, _ = s.Cancel(ctx)
		case err := <-waiting:
			// Pump the last events already queued before the stream is closed.
			for {
				select {
				case e := <-events:
					if e != nil {
						_ = d.event(e)
					}
				default:
					if d.mid && !o.json {
						fmt.Fprintln(out)
					}
					return err
				}
			}
		case text, ok := <-lines:
			if !ok {
				lines = nil
				if restore != nil {
					endSecret()
				}
				if e := <-readErr; e != nil {
					return e
				}
				if question != nil {
					question.reply <- modular.Decline("end of input")
					question, questionDone = nil, nil
				}
				waiting = make(chan error, 1)
				go func() { waiting <- s.WaitIdle(ctx) }()
				continue
			}
			if restore != nil {
				if !reply(endSecret(), modular.Secret(text)) {
					fmt.Fprintln(stderr, "question is no longer answerable")
				}
				continue
			}
			text = strings.TrimSpace(text)
			if text == "" {
				continue
			}
			if text == "/cancel" {
				_, err = s.Cancel(ctx)
				if err != nil {
					fmt.Fprintln(stderr, err)
				}
				continue
			}
			if question != nil && question.q.Kind == "approval" {
				switch text {
				case "y":
					reply(question.q.ID, modular.Allow())
				case "n":
					reply(question.q.ID, modular.Decline("declined"))
				default:
					fmt.Fprintln(stderr, "Answer y or n.")
				}
				continue
			}
			if args, ok := strings.CutPrefix(text, "/answer "); ok {
				answerLine(args)
				continue
			}
			if body, after := strings.CutPrefix(text, "/after "); after {
				_, err = s.Send(ctx, body, modular.After)
			} else if slashCommand(text) {
				var result string
				result, err = s.RunCommand(ctx, text)
				if result != "" {
					fmt.Fprintln(out, result)
				}
			} else {
				timing := modular.Now
				if busy, e := s.Busy(); e == nil && busy {
					timing = modular.Steer
				}
				_, err = s.Send(ctx, text, timing)
			}
			if err != nil {
				fmt.Fprintln(stderr, err)
			}
		}
	}
}

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
	case modular.DataEvent:
		id := e.CallID
		switch e.Type {
		case "toolCall":
			var v struct{ Call modular.ToolCall }
			if json.Unmarshal(e.Data, &v) == nil {
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
				if json.Unmarshal(e.Data, &v) == nil {
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
			if json.Unmarshal(e.Data, &v) == nil && v.Status != "completed" {
				line, _, _ := strings.Cut(strings.TrimSpace(v.Content.Text()), "\n")
				fmt.Fprintf(d.err, "  %s: %s\n", v.Status, line)
			}
		case "inputHandedBack":
			fmt.Fprintln(d.err, "Returned input:", string(e.Data))
		}
	}
	return nil
}
func slashCommand(line string) bool {
	return strings.HasPrefix(line, "/") && !strings.HasPrefix(line, "/skill:")
}
func printTurn(ctx context.Context, s *modular.Session, o options, out, stderr io.Writer, interrupts <-chan os.Signal) error {
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
			if question != nil {
				q.reply <- modular.Decline("another question is open")
				continue
			}
			question = &q
			questionDone = q.done
			fmt.Fprintln(stderr, q.q.Question)
			if len(q.q.Options) > 0 {
				fmt.Fprintln(stderr, strings.Join(q.q.Options, " / "))
			}
		case <-interrupts:
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
			if question != nil {
				answer := modular.Answer{Value: text}
				if text == "/decline" {
					answer = modular.Decline("declined")
				}
				question.reply <- answer
				question, questionDone = nil, nil
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

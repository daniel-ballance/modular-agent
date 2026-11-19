// Package tools offers file and shell tools using only the working environment capability.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"modular/api"
	"strings"
	"time"
)

type Source struct {
	environment func() (api.WorkingEnvironment, error)
}

func New(environment func() (api.WorkingEnvironment, error)) *Source {
	return &Source{environment: environment}
}

func Plugin() api.Plugin {
	return api.Plugin{Name: "tools", Setup: func(a api.API) error {
		return a.Provide("tools.builtin", New(func() (api.WorkingEnvironment, error) {
			v, err := a.Get("working-environment")
			if err != nil {
				return nil, err
			}
			return v.(api.WorkingEnvironment), nil
		}))
	}}
}
func schema(properties map[string]any, required ...string) json.RawMessage {
	return api.JSON(map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false})
}
func (s *Source) Tools(api.Session) []api.Tool {
	str := map[string]string{"type": "string"}
	return []api.Tool{
		{Name: "read", Description: "Read a UTF-8 file. Relative paths use the session's project.", Input: schema(map[string]any{"path": str}, "path"), ReadOnly: true, SafeRepeat: true, Parallel: true},
		{Name: "write", Description: "Write a file, creating parent folders.", Input: schema(map[string]any{"path": str, "content": str}, "path", "content"), SafeRepeat: true},
		{Name: "edit", Description: "Replace exactly one occurrence of old text in a file.", Input: schema(map[string]any{"path": str, "old": str, "new": str}, "path", "old", "new")},
		{Name: "bash", Description: "Run a bash command in the project, with live output. Background commands return when the shell exits.", Input: schema(map[string]any{"command": str, "timeout_seconds": map[string]any{"type": "integer", "minimum": 1, "maximum": 600}}, "command")},
	}
}
func (s *Source) Run(ctx context.Context, session api.Session, call api.Call, progress func(string)) api.ToolResult {
	result := api.ToolResult{Call: call.ID, Status: "failed"}
	env, err := s.environment()
	if err != nil {
		result.Content = api.Text(err.Error())
		return result
	}
	var args struct {
		Path    *string `json:"path"`
		Content *string `json:"content"`
		Old     *string `json:"old"`
		New     *string `json:"new"`
		Command *string `json:"command"`
		Timeout int     `json:"timeout_seconds"`
	}
	dec := json.NewDecoder(bytes.NewReader(call.Input))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&args); err != nil {
		result.Content = api.Text("invalid input: " + err.Error())
		return result
	}
	// Check fields per tool as well as the shared decoding shape.
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(call.Input, &fields)
	allowed := map[string]bool{}
	for _, tool := range s.Tools(session) {
		if tool.Name == call.Name {
			shape := api.Decode[struct {
				Properties map[string]any `json:"properties"`
			}](tool.Input)
			for name := range shape.Properties {
				allowed[name] = true
			}
		}
	}
	for name := range fields {
		if !allowed[name] {
			result.Content = api.Text("invalid field for " + call.Name + ": " + name)
			return result
		}
	}
	text := ""
	requirePath := func() error {
		if args.Path == nil || *args.Path == "" {
			return errors.New("path is required")
		}
		return nil
	}
	switch call.Name {
	case "read":
		err = requirePath()
		if err == nil {
			var b []byte
			b, err = env.Read(ctx, session.Project, *args.Path)
			text = string(b)
		}
	case "write":
		err = requirePath()
		if err == nil && args.Content == nil {
			err = errors.New("content is required")
		}
		if err == nil {
			err = env.Write(ctx, session.Project, *args.Path, []byte(*args.Content))
			text = "wrote " + *args.Path
		}
	case "edit":
		err = requirePath()
		if err == nil && (args.Old == nil || args.New == nil || *args.Old == "") {
			err = errors.New("nonempty old and new are required")
		}
		if err == nil {
			var b []byte
			b, err = env.Read(ctx, session.Project, *args.Path)
			if err == nil {
				if strings.Count(string(b), *args.Old) != 1 {
					err = errors.New("old text must match exactly once")
				} else {
					err = env.Write(ctx, session.Project, *args.Path, []byte(strings.Replace(string(b), *args.Old, *args.New, 1)))
					text = "edited " + *args.Path
				}
			}
		}
	case "bash":
		if args.Command == nil || *args.Command == "" {
			err = errors.New("command is required")
			break
		}
		if args.Timeout == 0 {
			args.Timeout = 30
		}
		if args.Timeout < 1 || args.Timeout > 600 {
			err = errors.New("timeout_seconds must be 1..600")
			break
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(args.Timeout)*time.Second)
		defer cancel()
		text, err = env.Bash(ctx, session.Project, *args.Command, progress)
	default:
		err = fmt.Errorf("unknown tool %s", call.Name)
	}
	if err != nil {
		if errors.Is(err, api.ErrUnknownOutcome) {
			result.Status = "unknown"
		}
		if ctx.Err() != nil {
			result.Status = "cancelled"
		}
		result.Content = api.Text(text + "\n" + err.Error())
		return result
	}
	result.Status = "completed"
	result.Content = api.Text(text)
	return result
}

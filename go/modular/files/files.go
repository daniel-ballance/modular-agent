// Package files provides the six standard file and command tools.
package files

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/daniel-ballance/modular-agent/go/modular"
)

type input struct {
	Path    string        `json:"path"`
	Content string        `json:"content"`
	Pattern string        `json:"pattern"`
	Command string        `json:"command"`
	Offset  *float64      `json:"offset"`
	Limit   *float64      `json:"limit"`
	Timeout *float64      `json:"timeout"`
	Edits   []replacement `json:"edits"`
}

// Plugin registers tools that use the scoped working environment. spill is the
// local directory where exec saves full output when its result is cut.
func Plugin(spill string) modular.Plugin {
	return modular.Plugin{Name: "tools.files", Setup: func(r *modular.Registrar) error {
		for _, t := range Tools(spill) {
			if err := r.Tool(t); err != nil {
				return err
			}
		}
		return nil
	}}
}

func cleanPath(p string) string {
	p = strings.TrimPrefix(p, "@")
	if (p == "~" || strings.HasPrefix(p, "~/")) && os.Getenv("HOME") != "" {
		p = os.Getenv("HOME") + p[1:]
	}
	return p
}
func number(n *float64, key string, fallback int) (int, error) {
	if n == nil {
		return fallback, nil
	}
	if *n < 0 {
		return 0, fmt.Errorf("%s must be a number, zero or more", key)
	}
	if *n >= float64(math.MaxInt) {
		return math.MaxInt, nil
	}
	return int(*n), nil
}
func image(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF8")):
		return "image/gif"
	case len(b) > 26 && bytes.HasPrefix(b, []byte("BM")):
		return "image/bmp"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}
func toolsError(err error, p string) error {
	var e *modular.Error
	if errors.As(err, &e) && e.Code == modular.NotFound {
		return fmt.Errorf("File not found: %s", p)
	}
	return err
}
func under(p string) string {
	if p == "" {
		return "."
	}
	return cleanPath(p)
}
func str(v string) json.RawMessage { b, _ := json.Marshal(v); return b }

func readFile(ctx context.Context, in input, tc *modular.ToolContext) (modular.Content, error) {
	p := cleanPath(in.Path)
	offset, err := number(in.Offset, "offset", 1)
	if err != nil {
		return nil, err
	}
	var limit *int
	if in.Limit != nil {
		n, err := number(in.Limit, "limit", 0)
		if err != nil {
			return nil, err
		}
		limit = &n
	}
	data, err := tc.Environment.Read(ctx, p)
	if err != nil {
		return nil, toolsError(err, in.Path)
	}
	if mime := image(data); mime != "" {
		if len(data) > maxImage {
			return modular.Text(fmt.Sprintf("Read image file [%s], %s. It is over the %s limit for images, so it was not attached.", mime, size(len(data)), size(maxImage))), nil
		}
		return append(modular.Text("Read image file ["+mime+"]"), modular.Part{Type: "image", Fields: map[string]json.RawMessage{"mimeType": str(mime), "data": str(base64.StdEncoding.EncodeToString(data))}}), nil
	}
	text, err := readWindow(strings.ToValidUTF8(string(data), "\ufffd"), p, offset, limit)
	return modular.Text(text), err
}
func writeFile(ctx context.Context, in input, tc *modular.ToolContext) (string, error) {
	p := cleanPath(in.Path)
	if err := tc.Environment.Write(ctx, p, []byte(in.Content)); err != nil {
		return "", toolsError(err, in.Path)
	}
	return fmt.Sprintf("Successfully wrote %d bytes to %s", len(in.Content), p), nil
}
func editFile(ctx context.Context, in input, tc *modular.ToolContext) (string, error) {
	p := cleanPath(in.Path)
	b, err := tc.Environment.Read(ctx, p)
	if err != nil {
		return "", toolsError(err, in.Path)
	}
	if !utf8.Valid(b) {
		return "", fmt.Errorf("%s is not UTF-8 text", p)
	}
	changed, err := applyEdits(string(b), p, in.Edits)
	if err != nil {
		return "", err
	}
	if err = tc.Environment.Write(ctx, p, []byte(changed)); err != nil {
		return "", toolsError(err, in.Path)
	}
	return fmt.Sprintf("Successfully replaced %d block(s) in %s.", len(in.Edits), p), nil
}
func listDir(ctx context.Context, in input, tc *modular.ToolContext) (string, error) {
	p := under(in.Path)
	limit, err := number(in.Limit, "limit", 500)
	if err != nil {
		return "", err
	}
	limit = max(1, limit)
	entries, err := tc.Environment.List(ctx, p)
	var names []string
	var unsupported *modular.Error
	if errors.As(err, &unsupported) && unsupported.Code == modular.NotSupported {
		out, e := runListing(ctx, tc, "ls -1Ap -- "+quote(p))
		if e != nil {
			return "", e
		}
		names = lines(out)
	} else if err != nil {
		return "", toolsError(err, p)
	} else {
		for _, e := range entries {
			n := e.Name
			if e.Kind == "directory" {
				n += "/"
			}
			names = append(names, n)
		}
	}
	sort.SliceStable(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	if len(names) == 0 {
		return "(empty directory)", nil
	}
	note := ""
	if len(names) > limit {
		names = names[:limit]
		note = fmt.Sprintf("%d entries limit reached. Use limit=%d for more", limit, limit*2)
	}
	return listing(names, note), nil
}
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
func runListing(ctx context.Context, tc *modular.ToolContext, command string) (string, error) {
	r, e := tc.Environment.Exec(ctx, command, 0, nil)
	if e != nil {
		return "", e
	}
	if r.ExitCode == nil || *r.ExitCode != 0 {
		return "", errors.New(strings.TrimSpace(r.Output))
	}
	return r.Output, nil
}
func findFiles(ctx context.Context, in input, tc *modular.ToolContext) (string, error) {
	p := under(in.Path)
	limit, err := number(in.Limit, "limit", 1000)
	if err != nil {
		return "", err
	}
	limit = max(1, limit)
	pat := strings.TrimPrefix(in.Pattern, "./")
	if !doublestar.ValidatePattern(pat) {
		return "", errors.New("invalid glob pattern")
	}
	// git honors the worktree's ignore rules; find also works outside a repository.
	out, err := runListing(ctx, tc, "cd -- "+quote(p)+` && (git ls-files -z -co --exclude-standard 2>/dev/null || find . -type f -not -path './.git/*' -printf '%P\0')`)
	if err != nil {
		return "", err
	}
	matches := []string{}
	seen := map[string]bool{}
	for _, file := range strings.Split(out, "\x00") {
		if file == "" || seen[file] {
			continue
		}
		seen[file] = true
		candidate := file
		if !strings.Contains(in.Pattern, "/") {
			candidate = path.Base(file)
		}
		if doublestar.MatchUnvalidated(pat, candidate) {
			matches = append(matches, file)
		}
	}
	if len(matches) == 0 {
		return "No files found matching pattern", nil
	}
	sort.Strings(matches)
	note := ""
	if len(matches) > limit {
		matches = matches[:limit]
		note = fmt.Sprintf("%d results limit reached. Use limit=%d for more, or refine pattern", limit, limit*2)
	}
	return listing(matches, note), nil
}
func runCommand(spill string) func(context.Context, input, *modular.ToolContext) (modular.ToolOutput, error) {
	return func(ctx context.Context, in input, tc *modular.ToolContext) (modular.ToolOutput, error) {
		var timeout time.Duration
		if in.Timeout != nil {
			if *in.Timeout < 0 || *in.Timeout >= float64(math.MaxInt64)/float64(time.Second) {
				return modular.ToolOutput{}, errors.New("timeout must be a number, zero or more")
			}
			if *in.Timeout > 0 {
				timeout = max(time.Nanosecond, time.Duration(*in.Timeout*float64(time.Second)))
			}
		}
		start := time.Now()
		out, err := tc.Environment.Exec(ctx, in.Command, timeout, func(s string) { _ = tc.Progress(modular.Text(s)) })
		status := modular.Completed
		if err != nil {
			var e *modular.Error
			if !errors.As(err, &e) || e.Code != modular.Lost {
				return modular.ToolOutput{}, err
			}
			status = modular.OutcomeUnknown
		}
		result := truncate(strings.ToValidUTF8(out.Output, "\ufffd"), MaxLines, MaxBytes, true)
		text := result.text
		value := map[string]any{"output": text, "truncated": result.truncated, "exit_code": out.ExitCode, "wall_time_seconds": float64(time.Since(start).Round(time.Millisecond)) / float64(time.Second)}
		if result.truncated {
			text += fmt.Sprintf("\n\n[Showing lines %d-%d of %d", result.total-result.count+1, result.total, result.total)
			if result.byBytes {
				text += " (" + size(MaxBytes) + " limit)"
			}
			if file := saveOutput(spill, out.Output); file != "" {
				value["full_output_path"] = file
				text += ". Full output: " + file
			}
			text += "]"
		}
		if text == "" {
			text = "(no output)"
		}
		switch {
		case status == modular.OutcomeUnknown:
			text += "\n\n" + err.Error()
		case out.TimedOut:
			status = modular.Failed
			value["timed_out"] = true
			text += fmt.Sprintf("\n\nCommand timed out after %g seconds", timeout.Seconds())
		case out.ExitCode == nil:
			status = modular.Failed
			text += "\n\nCommand was ended by a signal"
		case *out.ExitCode != 0:
			status = modular.Failed
			text += fmt.Sprintf("\n\nCommand exited with code %d", *out.ExitCode)
		}
		return modular.ToolOutput{Status: status, Content: modular.Text(text), Value: value}, nil
	}
}
func saveOutput(folder, data string) string {
	if folder == "" || os.MkdirAll(folder, 0700) != nil {
		return ""
	}
	f, err := os.CreateTemp(folder, "exec-*.log")
	if err != nil {
		return ""
	}
	_, err = f.WriteString(data)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(f.Name())
		return ""
	}
	path, _ := filepath.Abs(f.Name())
	return path
}

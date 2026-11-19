package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/OWNER/modular-agent/go/cmd/ma/internal/subscription"
	"github.com/OWNER/modular-agent/go/modular"
)

const help = `ma, the standard Modular Agent

Usage:
  ma [options]                 talk to the agent in this folder
  ma [options] -p PROMPT       answer one prompt and exit
  ma login PROVIDER [--device] sign in: openai-codex, xai or claude
  ma logout PROVIDER
  ma auth                      show what is signed in
  ma models                    list the models on offer
  ma skills                    list the skills found for this folder
  ma mcp                       list the configured MCP servers
  ma sessions [--all]          list saved sessions

Options:
  --model PROVIDER/ID   for example openai-codex/gpt-6.1-sol, xai/grok-4.7, claude/claude-sonnet-5-5
  --thinking LEVEL      off, minimal, low, medium, high or xhigh, as the model allows
  --session ID          reopen a session
  -c, --continue        reopen this folder's most recent session
  --project DIR         work in DIR instead of the current folder
  --trust-project       let this project's own .modular-agent.json and .mcp.json start programs
  --runtime KIND        durable (default: a turn cut off by a crash carries on) or transient
  -v, --verbose         also show each call the code makes and what commands print
  --json                print every event as a JSON line
  --history             print the session's history
  --declaration         print what this agent declares it supports
  --acp                 serve the Agent Client Protocol on stdio, for an editor or host
  -h, --help            print help
  -V, --version         print the version

While the agent works, a line you type steers it; /after TEXT queues a new
turn; /cancel or Ctrl-C stops the turn. /commands lists the rest, including
/model, /thinking, /compact, /skills and /skill:NAME.

Files: settings.json, mcp.json, models.json, AGENTS.md and skills/ in
~/.config/modular-agent. Sessions are kept in ~/.local/state/modular-agent/go.`

type options struct {
	command, provider, project, session, model, thinking                            string
	prompt                                                                          *string
	device, resume, all, trust, transient, verbose, json, history, declaration, acp bool
}

func parse(args []string) (o options, err error) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name, value, has := strings.Cut(arg, "=")
		if !has {
			name = arg
		}
		take := func() (string, error) {
			if has {
				return value, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", name)
			}
			i++
			return args[i], nil
		}
		switch name {
		case "-h", "--help":
			o.command = "help"
			return o, nil
		case "-V", "--version":
			o.command = "version"
			return o, nil
		case "login", "logout", "auth", "models", "skills", "mcp", "sessions":
			if o.command != "" {
				return o, fmt.Errorf("unexpected command %s", name)
			}
			o.command = name
			if name == "login" || name == "logout" {
				if i+1 >= len(args) {
					return o, errors.New("which provider? openai-codex, xai or claude")
				}
				i++
				o.provider = args[i]
			}
		case "--model":
			o.model, err = take()
		case "--thinking":
			o.thinking, err = take()
			if err == nil && !slices.Contains([]string{"off", "minimal", "low", "medium", "high", "xhigh"}, o.thinking) {
				err = errors.New("thinking must be off, minimal, low, medium, high or xhigh")
			}
		case "--session":
			o.session, err = take()
		case "--project":
			o.project, err = take()
		case "-p", "--print":
			v, e := take()
			o.prompt, err = &v, e
		case "--runtime":
			v, e := take()
			err = e
			if e == nil {
				switch v {
				case "transient":
					o.transient = true
				case "durable":
					o.transient = false
				default:
					err = errors.New("runtime must be transient or durable")
				}
			}
		case "-c", "--continue":
			o.resume = true
		case "--trust-project":
			o.trust = true
		case "-v", "--verbose":
			o.verbose = true
		case "--json":
			o.json = true
		case "--history":
			o.history = true
		case "--declaration":
			o.declaration = true
		case "--acp":
			o.acp = true
		case "--all":
			o.all = true
		case "--device":
			o.device = true
		default:
			err = fmt.Errorf("unknown argument %s; use --help", arg)
		}
		if err != nil {
			return o, err
		}
	}
	if o.device && o.command != "login" {
		return o, errors.New("--device is for ma login")
	}
	if o.all && o.command != "sessions" {
		return o, errors.New("--all is for ma sessions")
	}
	if o.acp && (o.prompt != nil || o.session != "" || o.resume || o.trust || o.command != "") {
		return o, errors.New("with --acp the client creates sessions and grants trust")
	}
	return o, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr, interrupts); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string, in io.ReadCloser, out, stderr io.Writer, interrupts <-chan os.Signal) error {
	o, err := parse(args)
	if err != nil {
		return err
	}
	switch o.command {
	case "help":
		fmt.Fprintln(out, help)
		return nil
	case "version":
		fmt.Fprintln(out, "ma 0.1.0 (go)")
		return nil
	}
	d, err := directories()
	if err != nil {
		return err
	}
	if o.command == "auth" {
		return d.authStatus(ctx, out)
	}
	if o.command == "login" || o.command == "logout" {
		work, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() {
			select {
			case <-interrupts:
				cancel()
			case <-work.Done():
			}
		}()
		return d.signIn(work, o, in, out, stderr)
	}
	project := o.project
	if project == "" {
		project = "."
	}
	project, err = canonical(project)
	if err != nil {
		return err
	}
	o.project = project
	config := o.acp && os.Getenv("MODULAR_AGENT_CONFORMANCE") == "1"
	store, err := d.history(config)
	if err != nil {
		return err
	}
	if o.command == "sessions" {
		filter := o.project
		if o.all {
			filter = ""
		}
		ss, err := listSessions(ctx, store, filter)
		if err != nil {
			return err
		}
		for _, s := range ss {
			fmt.Fprintf(out, "%s  %s\n", s.ID, s.Project)
		}
		return nil
	}
	var saved *modular.SessionInfo
	if o.session != "" || o.resume {
		filter := ""
		if o.session == "" {
			filter = o.project
		}
		ss, err := listSessions(ctx, store, filter)
		if err != nil {
			return err
		}
		for _, s := range ss {
			if o.session == "" || s.ID == o.session {
				saved = &s
				break
			}
		}
		if saved == nil {
			if o.session == "" {
				return errors.New("this folder has no saved session to continue")
			}
			return errors.New("session not found")
		}
		o.session = saved.ID
		if o.trust && o.project != saved.Project {
			return errors.New("--trust-project requires --project matching the saved session")
		}
		o.project = saved.Project
	}
	if o.trust {
		if err := d.trust(o.project); err != nil {
			return err
		}
	}
	switch o.command {
	case "skills":
		skills, problems := discover(skillFolders(d.config, d.home, o.project))
		showSkills(out, stderr, skills, problems)
		return nil
	case "mcp":
		for _, s := range d.mcp(o.project, stderr) {
			if s.URL != "" {
				fmt.Fprintf(out, "%-20s http   %s\n", s.Name, s.URL)
			} else {
				fmt.Fprintf(out, "%-20s stdio  %s %s\n", s.Name, s.Command, strings.Join(s.Args, " "))
			}
		}
		return nil
	}
	settings, err := d.settings(o.project)
	if err != nil {
		return err
	}
	if saved != nil && saved.Model != "" {
		settings["model"] = saved.Model
	}
	if o.model != "" {
		settings["model"] = o.model
	}
	if o.thinking != "" {
		settings["reasoning"] = o.thinking
	}
	if os.Getenv("MODULAR_AGENT_SCRIPT") == "" && !config && chosenModel(settings) == "" && o.command != "models" && !o.history && !o.declaration {
		name, err := d.defaultModel(ctx)
		if err != nil {
			return err
		}
		if name != "" {
			settings["model"] = name
		} else if !o.acp {
			return errors.New("no model is available. Sign in with `ma login openai-codex`, `ma login xai` or `ma login claude`, or pass --model. See `ma models`.")
		}
	}
	a, err := d.compose(ctx, o, settings, store, stderr)
	if err != nil {
		return err
	}
	defer a.Close(context.Background())
	if o.acp {
		return a.ServeACPStreams(ctx, in, out)
	}
	if o.declaration {
		return writeJSON(out, a.Declaration(), true)
	}
	if o.command == "models" {
		for _, m := range a.Models() {
			fmt.Fprintf(out, "%-34s context %7d  thinking %s\n", m.ModelRef.String(), m.ContextWindow, strings.Join(m.Thinking, ","))
		}
		return nil
	}
	var s *modular.Session
	if o.session == "" {
		s, err = a.Session(ctx)
	} else {
		s, err = a.OpenSession(ctx, o.session)
	}
	if err != nil {
		return err
	}
	if saved != nil {
		if o.model != "" && os.Getenv("MODULAR_AGENT_SCRIPT") == "" {
			if err = s.SetSetting(ctx, "model", o.model); err != nil {
				return err
			}
		}
		if o.thinking != "" {
			if err = s.SetSetting(ctx, "reasoning", o.thinking); err != nil {
				return err
			}
		}
	}
	if o.history {
		entries, err := s.History(ctx)
		if err != nil {
			return err
		}
		return writeJSON(out, entries, true)
	}
	if o.prompt != nil {
		return printTurn(ctx, s, o, out, stderr, interrupts)
	}
	return lineMode(ctx, s, o, in, out, stderr, interrupts)
}
func showSkills(out, stderr io.Writer, skills []skill, problems []string) {
	for _, s := range skills {
		fmt.Fprintf(out, "%-28s %s\n%-28s %s\n", s.Name, s.Description, "", s.File)
	}
	for _, p := range problems {
		fmt.Fprintln(stderr, "skipped "+p)
	}
}
func claudeStatus(ctx context.Context) (string, bool) {
	cmd := exec.CommandContext(ctx, "claude", "auth", "status")
	if err := cmd.Run(); err == nil {
		return "signed in through Claude Code", true
	} else if errors.Is(err, exec.ErrNotFound) {
		return "Claude Code is not installed", false
	}
	return "not signed in (run `ma login claude`)", false
}
func (d layout) claudeSidecar() string {
	paths := []string{os.Getenv("MODULAR_AGENT_CLAUDE_SIDECAR")}
	if exe, err := os.Executable(); err == nil {
		for p, i := filepath.Dir(exe), 0; i < 4; i, p = i+1, filepath.Dir(p) {
			paths = append(paths, filepath.Join(p, "typescript/sidecars/claude/dist/main.js"))
		}
	}
	paths = append(paths, filepath.Join(d.home, ".local/share/modular-agent/sidecars/claude/dist/main.js"))
	for _, p := range paths {
		if s, e := os.Stat(p); e == nil && s.Mode().IsRegular() {
			return p
		}
	}
	return ""
}
func (d layout) defaultModel(ctx context.Context) (string, error) {
	for _, v := range []struct {
		v     subscription.Vendor
		model string
	}{{subscription.Codex, "openai-codex/gpt-6.1-sol"}, {subscription.Xai, "xai/grok-4.7"}} {
		l, err := d.auth().Login(string(v.v))
		if err != nil {
			return "", err
		}
		if l != nil {
			return v.model, nil
		}
	}
	if d.claudeSidecar() != "" {
		if _, ok := claudeStatus(ctx); ok {
			return "claude/claude-sonnet-5-5", nil
		}
	}
	return "", nil
}
func (d layout) authStatus(ctx context.Context, out io.Writer) error {
	for _, v := range []subscription.Vendor{subscription.Codex, subscription.Xai} {
		l, err := d.auth().Login(string(v))
		if err != nil {
			return err
		}
		state := "not signed in"
		if l != nil {
			state = "signed in"
			if l.Expired() {
				state = "signed in (token will refresh on next use)"
			}
		}
		fmt.Fprintf(out, "%-13s %-22s %s\n", v, v.Label(), state)
	}
	state, _ := claudeStatus(ctx)
	fmt.Fprintf(out, "%-13s %-22s %s\n", "claude", "Claude subscription", state)
	if d.claudeSidecar() == "" {
		fmt.Fprintln(out, "              the Claude sidecar is not installed (build typescript/sidecars/claude)")
	}
	return nil
}
func (d layout) signIn(ctx context.Context, o options, in io.Reader, out, stderr io.Writer) error {
	if o.provider == "claude" {
		if o.command == "logout" {
			return errors.New("Claude Code holds that sign-in; run `claude auth logout`")
		}
		fmt.Fprintln(stderr, "Claude signs in through Claude Code. Running `claude auth login`.")
		c := exec.CommandContext(ctx, "claude", "auth", "login")
		c.Stdin, c.Stdout, c.Stderr = in, out, stderr
		if err := c.Run(); err != nil {
			if errors.Is(err, exec.ErrNotFound) {
				return fmt.Errorf("could not run claude: %w. Install Claude Code, then run `claude auth login`", err)
			}
			return errors.New("claude auth login did not complete")
		}
		return nil
	}
	v := subscription.Vendor(o.provider)
	if v != subscription.Codex && v != subscription.Xai {
		return fmt.Errorf("unknown provider %s; use openai-codex, xai or claude", v)
	}
	if o.command == "logout" {
		if err := d.auth().Set(ctx, string(v), nil); err != nil {
			return err
		}
		fmt.Fprintf(stderr, "Signed out of %s.\n", v.Label())
		return nil
	}
	l, err := subscription.SignIn(ctx, v, o.device, func(s subscription.Step) {
		if s.Note != "" {
			fmt.Fprintln(stderr, s.Note)
			return
		}
		if s.Code != "" {
			fmt.Fprintf(stderr, "Open this address in a browser:\n\n  %s\n\nand enter the code: %s\n\n", s.Address, s.Code)
		} else {
			fmt.Fprintf(stderr, "Open this address in a browser to sign in:\n\n  %s\n\n", s.Address)
		}
		if _, disabled := os.LookupEnv("MA_NO_BROWSER"); !disabled && strings.HasPrefix(s.Address, "https://") {
			c := exec.Command("xdg-open", s.Address)
			if c.Start() == nil {
				go func() { _ = c.Wait() }()
			}
		}
		fmt.Fprintln(stderr, "Waiting for the sign-in to finish...")
	})
	if err != nil {
		return err
	}
	if err := d.auth().Set(ctx, string(v), &l); err != nil {
		return err
	}
	fmt.Fprintf(stderr, "Signed in to %s (%s).\n", v.Label(), v)
	return nil
}

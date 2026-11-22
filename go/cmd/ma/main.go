package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"

	"github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/subscription"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"golang.org/x/sys/unix"
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
  --acp                 serve the Agent Client Protocol for an editor or host
  --listen ADDR [--token-file FILE]
  --policy FILE        read operator policy from FILE
                        with --acp, listen on a loopback WebSocket instead of stdio
  -h, --help            print help
  -V, --version         print the version

While the agent works, a line you type steers it; /after TEXT queues a new
turn; /cancel or Ctrl-C stops the turn. /commands lists the rest, including
/model, /thinking, /compact, /skills and /skill:NAME.

Files: settings.json, mcp.json, models.json, AGENTS.md and skills/ in
~/.config/modular-agent. Sessions are kept in ~/.local/state/modular-agent/go.`

type options struct {
	command, provider, project, session, model, thinking                            string
	listen, tokenFile, policyPath                                                   string
	policy                                                                          operatorPolicy
	subscriptions                                                                   subscription.Options
	prompt                                                                          *string
	loadClaude                                                                      bool
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
		case "--listen":
			o.listen, err = take()
			if err == nil && o.listen == "" {
				err = errors.New("--listen needs a nonempty address")
			}
		case "--policy":
			o.policyPath, err = take()
			if err == nil && o.policyPath == "" {
				err = errors.New("--policy needs a nonempty path")
			}
		case "--token-file":
			o.tokenFile, err = take()
			if err == nil && o.tokenFile == "" {
				err = errors.New("--token-file needs a nonempty path")
			}
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
	if o.listen != "" && !o.acp || o.tokenFile != "" && o.listen == "" {
		return o, errors.New("--listen requires --acp; --token-file requires --listen")
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
	var identity subscription.ClientIdentity
	if value, set := os.LookupEnv("MA_CLIENT_IDENTITY"); set {
		var err error
		identity, err = subscription.ParseClientIdentity(value)
		if err != nil {
			return fmt.Errorf("MA_CLIENT_IDENTITY: %w", err)
		}
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		return errors.New("ma supports only Linux and macOS")
	}
	o, err := parse(args)
	if err != nil {
		return err
	}
	o.subscriptions = subscription.Options{ClientIdentity: identity}
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
	policyPath := o.policyPath
	if policyPath == "" {
		policyPath = filepath.Join(d.config, "policy.json")
	}
	o.policy, err = readPolicy(policyPath, o.policyPath == "")
	if err != nil {
		return err
	}
	if o.listen != "" {
		if o.tokenFile != "" && o.policy.Actors != nil {
			return fmt.Errorf("policy %s: cannot combine actors with --token-file", policyPath)
		}
		if o.tokenFile == "" && len(o.policy.Actors) == 0 {
			return fmt.Errorf("policy %s: --listen needs actors or --token-file", policyPath)
		}
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
	store, err := d.history()
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
	bootstrap := o
	if o.acp {
		// The listener has no client project yet. The authorized factory reads
		// client project settings after checking its scope.
		if err := os.MkdirAll(d.state, 0700); err != nil {
			return err
		}
		bootstrap.project = d.state
	}
	settings, err := d.settings(bootstrap.project)
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
	if os.Getenv("MODULAR_AGENT_SCRIPT") == "" && !config && !o.acp && chosenModel(settings) == "" && o.command != "models" && !o.history && !o.declaration {
		name, err := d.defaultModel(ctx)
		if err != nil {
			return err
		}
		if name != "" {
			settings["model"] = name
		} else {
			return errors.New("no model is available. Sign in with `ma login openai-codex`, `ma login xai` or `ma login claude`, or pass --model. See `ma models`.")
		}
	}
	a, err := d.compose(ctx, bootstrap, settings, store, stderr)
	if err != nil {
		return err
	}
	defer a.Close(context.Background())
	if o.acp {
		acpOptions := modular.ServeACPOptions{
			Compose: func(ctx context.Context, project string) (*modular.Agent, error) {
				projectOptions := o
				projectOptions.project = project
				projectSettings, err := d.settings(project)
				if err != nil {
					return nil, err
				}
				if o.model != "" {
					projectSettings["model"] = o.model
				}
				if o.thinking != "" {
					projectSettings["reasoning"] = o.thinking
				}
				if id := modular.ACPReopeningSession(ctx); id != "" && !config {
					row, err := store.SessionInfo(ctx, id)
					if err != nil {
						return nil, err
					}
					if row.Project == project && strings.HasPrefix(row.Model, "claude/") {
						projectOptions.loadClaude = true
					}
				}
				if chosenModel(projectSettings) == "" && !config && os.Getenv("MODULAR_AGENT_SCRIPT") == "" {
					model, err := d.defaultModel(ctx)
					if err != nil {
						return nil, err
					}
					if model != "" {
						projectSettings["model"] = model
					}
				}
				return d.compose(ctx, projectOptions, projectSettings, store, stderr)
			},
			ProjectMCP: func(project string) ([]modular.MCPServer, error) {
				if config {
					return nil, nil
				}
				return d.mcp(project, stderr), nil
			},
			WarnMCP: func(err error) { fmt.Fprintln(stderr, err) },
		}
		if o.listen == "" {
			acpOptions.Represents = []string{}
			if scope := o.policy.Stdio; scope != nil {
				acpOptions.StdioActor = &scope.Actor
				acpOptions.Projects, acpOptions.Tenants = scope.Projects, scope.Tenants
			}
			acpOptions.Input, acpOptions.Output = in, out
			return a.ServeACP(ctx, acpOptions)
		}
		acpOptions.Listen = o.listen
		acpOptions.Actors = o.policy.Actors
		if o.tokenFile != "" {
			acpOptions.Actors = []modular.ACPActor{{TokenFile: o.tokenFile, Actor: modular.LocalACPActor()}}
		}
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() {
			select {
			case <-interrupts:
				cancel()
			case <-ctx.Done():
			}
		}()
		return a.ServeACP(ctx, acpOptions)
	}
	if o.declaration {
		decl := a.Declaration()
		decl["limits"] = a.CapacityLimits()
		return writeJSON(out, decl, true)
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

// terminalLines is only used by the sign-in command. A blocked read can
// outlive sign-in until the process exits; sends stop when sign-in ends.
func terminalLines(ctx context.Context, in io.Reader) <-chan string {
	file, ok := in.(*os.File)
	if !ok {
		return nil
	}
	if _, err := unix.IoctlGetWinsize(int(file.Fd()), unix.TIOCGWINSZ); err != nil {
		return nil
	}
	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	return lines
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
	var pasted <-chan string
	if v == subscription.Codex && !o.device {
		lineCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		pasted = terminalLines(lineCtx, in)
	}
	l, err := subscription.SignIn(ctx, v, o.device, pasted, func(s subscription.Step) {
		if s.Note != "" {
			fmt.Fprintln(stderr, s.Note)
			return
		}
		if s.OpenAndPaste {
			fmt.Fprintf(stderr, "Open this address in a browser, on this machine or any other:\n\n  %s\n\n", s.Address)
		} else if s.Code != "" {
			fmt.Fprintf(stderr, "Open this address in a browser:\n\n  %s\n\nand enter the code: %s\n\n", s.Address, s.Code)
		} else {
			fmt.Fprintf(stderr, "Open this address in a browser to sign in:\n\n  %s\n\n", s.Address)
		}
		_, disabled := os.LookupEnv("MA_NO_BROWSER")
		_, ssh := os.LookupEnv("SSH_CONNECTION")
		_, sshTTY := os.LookupEnv("SSH_TTY")
		_, display := os.LookupEnv("DISPLAY")
		_, wayland := os.LookupEnv("WAYLAND_DISPLAY")
		if !disabled && !ssh && !sshTTY && (display || wayland) && strings.HasPrefix(s.Address, "https://") {
			c := exec.Command("xdg-open", s.Address)
			if c.Start() == nil {
				go func() { _ = c.Wait() }()
			}
		}
		if s.OpenAndPaste {
			fmt.Fprint(stderr, "After you sign in, the browser goes to a localhost address. If the browser is on this\n"+
				"machine, that finishes the sign-in. Otherwise the page will not load: copy the whole\n"+
				"address from the browser's address bar and paste it here.\n\n")
			fmt.Fprint(stderr, "Paste the address (or the code): ")
		} else {
			fmt.Fprintln(stderr, "Waiting for the sign-in to finish...")
		}
	}, o.subscriptions)
	if err != nil {
		return err
	}
	if err := d.auth().Set(ctx, string(v), &l); err != nil {
		return err
	}
	fmt.Fprintf(stderr, "Signed in to %s (%s).\n", v.Label(), v)
	return nil
}

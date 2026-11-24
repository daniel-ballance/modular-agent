package scenarios

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type fixtureGroups []*exec.Cmd

func (g *fixtureGroups) start(ctx context.Context, r run, sc scenario) ([]modular.ServicePlugin, error) {
	if !r.placement.Service {
		return nil, nil
	}
	if len(sc.Agent.Plugins) == 0 {
		return []modular.ServicePlugin{}, nil
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	file := filepath.Join(r.dir, "service.token")
	if err := os.WriteFile(file, []byte(hex.EncodeToString(token)), 0600); err != nil {
		return nil, err
	}
	config := make([]modular.ServicePlugin, 0, len(sc.Agent.Plugins))
	for _, name := range sc.Agent.Plugins {
		args := append(slices.Clone(r.placement.Command), name, "--listen", "127.0.0.1:0", "--token-file", file)
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "TMPDIR=" + os.Getenv("TMPDIR")}
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		output, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			_ = output.Close()
			return nil, err
		}
		*g = append(*g, cmd)
		ready := make(chan string, 1)
		go func() { line, _ := bufio.NewReader(output).ReadString('\n'); ready <- strings.TrimSpace(line) }()
		var address string
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case address = <-ready:
		}
		u, err := url.Parse(address)
		if err != nil || u.Scheme != "ws" || u.Host == "" {
			return nil, fmt.Errorf("%s fixture %s supplied no WebSocket URL: %q", r.placement.name(), name, address)
		}
		settings := map[string]any{"path": r.countPath()}
		if sc.Requires["approvalsOutlastTurns"] {
			settings["waitingCounter"] = true
		}
		config = append(config, modular.ServicePlugin{URL: address, TokenFile: file, Config: settings})
	}
	return config, nil
}

func (g *fixtureGroups) stop() error {
	groups := *g
	*g = nil
	var err error
	for _, cmd := range groups {
		if e := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); e != nil && !errors.Is(e, syscall.ESRCH) {
			err = errors.Join(err, e)
		}
	}
	for _, cmd := range groups {
		_ = cmd.Wait()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for _, cmd := range groups {
		for groupAlive(cmd.Process.Pid) {
			select {
			case <-ctx.Done():
				return errors.Join(err, fmt.Errorf("process group %d did not exit: %w", cmd.Process.Pid, ctx.Err()))
			case <-tick.C:
			}
		}
	}
	return err
}

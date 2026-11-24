package modular_test

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

// Kill after the transport flush, both before and after the private marker is
// synced. The same completed turn must not fill in the missing terminal class.
func TestReceiptReleaseSurvivesOnlyAfterRecord(t *testing.T) {
	agent := func(dir string) *modular.Agent {
		return modulartest.Agent(t, modular.WithProject(dir), modular.WithDataDir(dir), modular.WithDurability(modular.Kept), modulartest.Script(`[{"text":"done"}]`))
	}
	if dir := os.Getenv("MA_GO_RECEIPT_TEST_DIR"); dir != "" {
		a := agent(dir)
		opt := modular.ServeAGUIOptions{Listen: "127.0.0.1:0", Actors: []modular.ACPActor{agActor(t)}}
		modular.AGUIFixtureProbe(&opt, func(name, id, run string) {
			if name == os.Getenv("MA_GO_RECEIPT_PAUSE") {
				fmt.Println("boundary")
				select {}
			}
		})
		s, err := a.ServeAGUI(t.Context(), opt)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Println(s.URL)
		<-s.Done()
		return
	}
	for _, tc := range []struct{ pause, terminal string }{{"terminalReleased", "unknown"}, {"terminalRecorded", "success"}} {
		t.Run(tc.pause, func(t *testing.T) {
			dir := t.TempDir()
			cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestReceiptReleaseSurvivesOnlyAfterRecord$")
			cmd.Env = append(os.Environ(), "MA_GO_RECEIPT_TEST_DIR="+dir, "MA_GO_RECEIPT_PAUSE="+tc.pause)
			out, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = os.Stderr
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
			sc := bufio.NewScanner(out)
			if !sc.Scan() {
				t.Fatal("child did not listen")
			}
			base := sc.Text() + "/agui/v1"
			id := agThread(t, base)
			req, err := http.NewRequestWithContext(t.Context(), "POST", base+"/run", strings.NewReader(fmt.Sprintf(`{"threadId":%q,"runId":"kill","protocolVersion":"1.0","messages":[{"role":"user","id":"a","content":"run"}]}`, id)))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+testAGToken)
			req.Header.Set("Content-Type", "application/json")
			r, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Body.Close()
			if !sc.Scan() || sc.Text() != "boundary" {
				t.Fatal("child missed boundary")
			}
			if err = cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			_ = cmd.Wait()
			b, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(b), `"type":"RUN_FINISHED"`) {
				t.Fatal("terminal was not flushed")
			}
			reopened := agent(dir)
			v, err := readHost(agURL(t, reopened, modular.ServeAGUIOptions{Actors: []modular.ACPActor{agActor(t)}})).RunReceipt(t.Context(), id, "kill")
			if err != nil || v.Terminal != tc.terminal || v.Work != "completed" {
				t.Fatal(v, err)
			}
		})
	}
}

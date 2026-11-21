package codemode

import (
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"google.golang.org/protobuf/proto"
)

func TestWorkerProtocolFailure(t *testing.T) {
	for _, tc := range []struct{ mode, want string }{
		{"protocol", "did not accept protocol 8"},
		{"malformed", "malformed worker event"},
		{"oversized", "invalid frame length"},
		{"root", "invalid worker root index"},
		{"child", "invalid child index"},
		{"type", "invalid worker value type"},
		{"expanded", "worker value exceeds expanded size"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := command(t.Context(), exe, "-test.run=^TestProtocolFixture$")
			cmd.Env = append(cmd.Env, "MA_TEST_PROTOCOL_FIXTURE="+tc.mode)
			out, err := runWorker(t.Context(), cmd, "42", nil, nil, StandardLimits())
			if err != nil || out.Status != modular.Failed || !strings.Contains(out.Content.Text(), tc.want) || cmd.ProcessState == nil {
				t.Fatalf("wanted %q and a reaped worker, got %+v, %v, %v", tc.want, out, err, cmd.ProcessState)
			}
		})
	}
	assertNextRunWorks(t)
}

// A child acting as an untrusted wire peer. It waits for each request before
// responding, so process exit cannot race delivery of the injected event.
func TestProtocolFixture(t *testing.T) {
	mode := os.Getenv("MA_TEST_PROTOCOL_FIXTURE")
	if mode == "" {
		return
	}
	readRequest := func() *pb.ClientRequest {
		var prefix [4]byte
		if _, err := io.ReadFull(os.Stdin, prefix[:]); err != nil {
			os.Exit(2)
		}
		n := binary.LittleEndian.Uint32(prefix[:])
		if n > 4096 {
			os.Exit(2)
		}
		body := make([]byte, n)
		req := new(pb.ClientRequest)
		if _, err := io.ReadFull(os.Stdin, body); err != nil || proto.Unmarshal(body, req) != nil {
			os.Exit(2)
		}
		return req
	}
	if readRequest().GetConfigure().GetProtocolVersion() != 8 {
		os.Exit(2)
	}
	if mode == "protocol" {
		_ = writeFrame(os.Stdout, &pb.WorkerEvent{Kind: &pb.WorkerEvent_FatalError{FatalError: &pb.FatalError{Message: "supports protocol 7"}}})
		os.Exit(0)
	}
	ack := &pb.WorkerEvent{Kind: &pb.WorkerEvent_Ok{Ok: &pb.Ok{}}, ExecutionClock: pb.ExecutionClock_WALL.Enum()}
	if writeFrame(os.Stdout, ack) != nil || readRequest().GetFeed() == nil {
		os.Exit(2)
	}
	var header [4]byte
	if mode == "oversized" {
		binary.LittleEndian.PutUint32(header[:], maxFrame+1)
		_, _ = os.Stdout.Write(header[:])
	} else if mode == "malformed" {
		_, _ = os.Stdout.Write([]byte{1, 0, 0, 0, 0xff})
	} else {
		a := &pb.Arena{Nodes: []*pb.MontyNode{stringNode("leaf")}}
		complete := &pb.Complete{Values: a}
		list := func(ids ...uint32) *pb.MontyNode {
			return &pb.MontyNode{Kind: &pb.MontyNode_List{List: &pb.Indexes{Items: ids}}}
		}
		switch mode {
		case "root":
			complete.Value = 1
		case "child":
			a.Nodes[0] = list(0)
		case "type":
			a.Nodes[0] = &pb.MontyNode{}
		case "expanded":
			for i := uint32(0); i < 20; i++ {
				a.Nodes = append(a.Nodes, list(i, i))
			}
			complete.Value = 20
		}
		_ = writeFrame(os.Stdout, &pb.WorkerEvent{Kind: &pb.WorkerEvent_Complete{Complete: complete}})
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

func TestWorkerMissingOrWrongVersion(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing")
	wrong := filepath.Join(dir, "wrong")
	if err := os.WriteFile(wrong, []byte("#!/bin/sh\nprintf 'monty-runtime 1.5.0\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{missing: "cannot run Monty 1.6.0 worker", wrong: "wrong Monty worker"} {
		out, err := runAt(t.Context(), path, "42", nil, nil, StandardLimits())
		if err != nil || out.Status != modular.Failed || !strings.Contains(out.Content.Text(), want) {
			t.Errorf("%s: %+v, %v", path, out, err)
		}
	}
}

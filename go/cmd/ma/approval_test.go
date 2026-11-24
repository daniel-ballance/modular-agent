package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMAApprovalRejectsInvalidValues(t *testing.T) {
	d, p, _ := isolated(t)
	args := []string{"--project", p, "--declaration"}
	check := func(file, key string, args []string) {
		t.Helper()
		err := run(t.Context(), args, os.Stdin, io.Discard, io.Discard, nil)
		if err == nil || !strings.Contains(err.Error(), file) || !strings.Contains(err.Error(), key) {
			t.Fatalf("want error naming %s and %s; got %v", file, key, err)
		}
	}
	check("--approval", "approval", append(args, "--approval", "sometimes"))
	for _, v := range []string{"0", "-1", "1.5", "9007199254740992", "null", `"100"`} {
		file := filepath.Join(d.config, "policy.json")
		put(t, file, `{"approvalWaitMaxMs":`+v+`}`)
		check(file, "approvalWaitMaxMs", args)
	}
	put(t, filepath.Join(d.config, "policy.json"), "{}")
	for _, key := range []string{"approval", "approval_wait"} {
		file := filepath.Join(d.config, "settings.json")
		put(t, file, `{"`+key+`":false}`)
		check(file, key, args)
	}
}

func TestMAApprovalDefaultsAndPrint(t *testing.T) {
	d, project, _ := isolated(t)
	put(t, filepath.Join(project, ".modular-agent.json"), `{"approval":"never","approval_wait":"untilDeadline"}`)
	put(t, filepath.Join(d.config, "policy.json"), `{"approvalWaitMaxMs":30000}`)
	execute := func(args ...string) string {
		t.Helper()
		var out, stderr bytes.Buffer
		if err := run(t.Context(), append([]string{"--project", project}, args...), io.NopCloser(strings.NewReader("")), &out, &stderr, nil); err != nil {
			t.Fatal(err, stderr.String())
		}
		return out.String()
	}
	if decl := execute("--declaration"); strings.Contains(decl, "approvalCoversNested") || strings.Contains(decl, "approvalsOutlastTurns") {
		t.Fatal("project enabled approval")
	}
	put(t, filepath.Join(d.config, "settings.json"), `{"approval":"off","approval_wait":"untilDeadline"}`)
	var decl map[string]any
	if err := json.Unmarshal([]byte(execute("--declaration")), &decl); err != nil || decl["approvalCoversNested"] != true || decl["approvalsOutlastTurns"] != true {
		t.Fatal(decl, err)
	}
	put(t, os.Getenv("MODULAR_AGENT_SCRIPT"), `[{"toolCalls":[{"name":"codemode","input":{"code":"tools.write(path='marker', content='no')"}}]},{"text":"Done."}]`)
	if got := execute("--approval", "ask", "-p", "Write."); got != "Done.\n" {
		t.Fatal(got)
	}
	ledger := execute("--continue", "--history")
	if !strings.Contains(ledger, `"coversNested": true`) || !strings.Contains(ledger, `"status": "refused"`) || strings.Contains(ledger, `"kind": "toolStarted"`) || strings.Contains(ledger, `"kind": "toolPending"`) {
		t.Fatal("print did not refuse the approval")
	}
	if _, err := os.Stat(filepath.Join(project, "marker")); !os.IsNotExist(err) {
		t.Fatal("print ran the call", err)
	}
	put(t, filepath.Join(d.config, "policy.json"), `{}`)
	decl = nil
	if err := json.Unmarshal([]byte(execute("--declaration")), &decl); err != nil || decl["approvalCoversNested"] != true || decl["approvalsOutlastTurns"] != nil {
		t.Fatal(decl, err)
	}
}

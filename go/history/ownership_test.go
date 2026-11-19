package history_test

import (
	"bufio"
	"fmt"
	"modular/history"
	"os"
	"os/exec"
	"testing"
)

func TestDeadWriterReleasesItsLease(t *testing.T) {
	if os.Getenv("MODULAR_LEASE_OWNER") == "1" {
		store, err := history.New(os.Getenv("MODULAR_LEASE_DIR"))
		if err != nil {
			os.Exit(2)
		}
		lease, err := store.Acquire("held")
		if err != nil {
			os.Exit(3)
		}
		defer lease.Close()
		fmt.Println("held")
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		return
	}
	dir := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestDeadWriterReleasesItsLease$")
	child.Env = append(os.Environ(), "MODULAR_LEASE_OWNER=1", "MODULAR_LEASE_DIR="+dir)
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "held\n" {
		t.Fatal(line, err)
	}
	store, _ := history.New(dir)
	if lease, err := store.Acquire("held"); err == nil {
		_ = lease.Close()
		t.Fatal("second writer acquired held session")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	lease, err := store.Acquire("held")
	if err != nil {
		t.Fatal("dead writer still held lease", err)
	}
	if err = lease.Close(); err != nil {
		t.Fatal(err)
	}
}

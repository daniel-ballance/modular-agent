package local

import (
	"bytes"
	"os"
	"testing"
	"time"
)

func TestDrainCommandOutputAfterForegroundExit(t *testing.T) {
	output, sender, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	defer sender.Close() // A descendant still holds the write end.
	if _, err := sender.WriteString("foreground output"); err != nil {
		t.Fatal(err)
	}
	// The foreground exit can wake the reader before it has run at all.
	if err := output.SetReadDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	if err := drainCommandOutput(output, &got); err != nil {
		t.Fatal(err)
	}
	if got.String() != "foreground output" {
		t.Fatalf("lost buffered output: %q", got.String())
	}
}

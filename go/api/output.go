package api

import "errors"

// ErrOutputWithheld means the gate did not release an Interface response.
// It does not mean the operation that produced the response was undone.
var ErrOutputWithheld = errors.New("output gate withheld the response")

var ErrResultTooLarge = errors.New("result exceeds size limit")

// OutputBatch is the final group presented to stream-oriented output gates.
type OutputBatch struct {
	Session, Recipient string
	Events             []Event
}

package codemode

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// The worker accepts up to 256 MiB. ma has a smaller wire budget and a
// separate decoder budget: a short frame can encode many empty messages.
const maxFrame = 32 << 20
const maxDecode = 128 << 20

func readEvent(r io.Reader) (*pb.WorkerEvent, error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(head[:])
	if n == 0 || n > maxFrame {
		return nil, fmt.Errorf("invalid frame length: %d bytes", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	event := new(pb.WorkerEvent)
	budget := maxDecode
	if err := checkWire(body, event.ProtoReflect().Descriptor(), &budget, 0); err != nil {
		return nil, err
	}
	if err := (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(body, event); err != nil {
		return nil, fmt.Errorf("malformed worker event: %w", err)
	}
	return event, nil
}

func writeFrame(w io.Writer, msg proto.Message) error {
	n := proto.Size(msg)
	if n == 0 || n > maxFrame {
		return fmt.Errorf("invalid frame length: %d bytes", n)
	}
	body, err := proto.MarshalOptions{Deterministic: true}.MarshalAppend(make([]byte, 4, 4+n), msg)
	if err != nil {
		return err
	}
	binary.LittleEndian.PutUint32(body, uint32(n))
	written, err := w.Write(body)
	if err == nil && written != len(body) {
		return io.ErrShortWrite
	}
	return err
}

// Check the pinned schema before invoking the allocating decoder. Charge for
// objects, their fields, repeated slots (including packed scalars), backing
// storage and slice growth. Reject duplicate singular fields and oneof arms:
// the worker never emits them and accepting them would hide unchecked data.
func checkWire(data []byte, desc protoreflect.MessageDescriptor, budget *int, depth int) error {
	malformed := errors.New("malformed worker event")
	if depth >= 32 {
		return malformed
	}
	*budget -= 256
	var singular, oneofs uint64 // the pinned schema has no field or oneof >= 64
	for len(data) != 0 {
		*budget -= 64
		if *budget < 0 {
			return errors.New("worker event exceeds decode budget")
		}
		num, wire, n := protowire.ConsumeTag(data)
		if n < 0 {
			return malformed
		}
		field := desc.Fields().ByNumber(num)
		if field == nil || num >= 64 {
			return fmt.Errorf("unknown worker event field %d in %s", num, desc.Name())
		}
		data = data[n:]
		if !field.IsList() {
			bit := uint64(1) << num
			if singular&bit != 0 {
				return malformed
			}
			singular |= bit
			if group := field.ContainingOneof(); group != nil {
				bit := uint64(1) << group.Index()
				if oneofs&bit != 0 {
					return malformed
				}
				oneofs |= bit
			}
		}
		switch field.Kind() {
		case protoreflect.MessageKind, protoreflect.StringKind, protoreflect.BytesKind:
			if wire != protowire.BytesType {
				return malformed
			}
			var payload []byte
			payload, n = protowire.ConsumeBytes(data)
			if n < 0 {
				return malformed
			}
			if field.Kind() == protoreflect.MessageKind {
				if err := checkWire(payload, field.Message(), budget, depth+1); err != nil {
					return err
				}
			} else {
				*budget -= len(payload)
			}
		case protoreflect.DoubleKind:
			if wire != protowire.Fixed64Type {
				return malformed
			}
			_, n = protowire.ConsumeFixed64(data)
		case protoreflect.Uint32Kind, protoreflect.Uint64Kind, protoreflect.Int32Kind, protoreflect.Sint64Kind, protoreflect.BoolKind, protoreflect.EnumKind:
			if field.IsPacked() && field.Kind() == protoreflect.Uint32Kind && wire == protowire.BytesType {
				var payload []byte
				payload, n = protowire.ConsumeBytes(data)
				if n < 0 {
					return malformed
				}
				// Charging by encoded length also bounds time spent scanning.
				*budget -= len(payload) * 16
				if *budget < 0 {
					return errors.New("worker event exceeds decode budget")
				}
				for len(payload) > 0 {
					v, m := protowire.ConsumeVarint(payload)
					if m < 0 || v > math.MaxUint32 {
						return malformed
					}
					payload = payload[m:]
				}
			} else {
				if wire != protowire.VarintType {
					return malformed
				}
				var v uint64
				v, n = protowire.ConsumeVarint(data)
				if field.Kind() == protoreflect.Uint32Kind && v > math.MaxUint32 || field.Kind() == protoreflect.BoolKind && v > 1 {
					return malformed
				}
			}
		default:
			return malformed
		}
		if n < 0 {
			return malformed
		}
		data = data[n:]
	}
	if *budget < 0 {
		return errors.New("worker event exceeds decode budget")
	}
	return nil
}

package codemode

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"slices"
	"strconv"
	"strings"
	"time"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
	"google.golang.org/protobuf/proto"
)

const maxValueDepth = 256
const maxExpanded = 64 << 20

var errExpanded = errors.New("worker value exceeds expanded size or depth limit")

type valueSize struct{ bytes, depth int }
type arena struct {
	nodes []*pb.MontyNode
	sizes []valueSize
}

// Check every node, even unreachable ones. Count shared children once per
// reference to bound JSON conversion and repr, not just the on-wire DAG.
func validateArena(wire *pb.Arena) (arena, error) {
	a := arena{nodes: wire.GetNodes()}
	a.sizes = make([]valueSize, len(a.nodes)) // node_count is only a hint
	for i, node := range a.nodes {
		// Allow for container allocations and pretty-printed JSON indentation
		// at maxValueDepth, as well as escaped strings and byte reprs.
		size := valueSize{bytes: 1024 + 6*proto.Size(node), depth: 1}
		child := func(id uint32) error {
			if id >= uint32(i) {
				return fmt.Errorf("invalid child index %d in worker node %d", id, i)
			}
			s := a.sizes[id]
			size.bytes += s.bytes
			size.depth = max(size.depth, 1+s.depth)
			return size.check()
		}
		pairs := func(ps *pb.NodePairs, attrs bool) error {
			for _, p := range ps.GetPairs() {
				if err := child(p.Key); err != nil {
					return err
				}
				if attrs {
					if _, ok := a.nodes[p.Key].Kind.(*pb.MontyNode_Str); !ok {
						return errors.New("worker attribute name is not a string")
					}
				}
				if err := child(p.Value); err != nil {
					return err
				}
			}
			return nil
		}
		var err error
		switch v := node.Kind.(type) {
		case *pb.MontyNode_List, *pb.MontyNode_Tuple, *pb.MontyNode_Set, *pb.MontyNode_FrozenSet, *pb.MontyNode_NamedTuple:
			if nt := node.GetNamedTuple(); nt != nil && (nt.TypeName == "" || len(nt.FieldNames) != len(nt.Values)) {
				return arena{}, errors.New("invalid worker named tuple")
			}
			for _, id := range items(node) {
				if err := child(id); err != nil {
					return arena{}, err
				}
			}
		case *pb.MontyNode_Dict:
			err = pairs(v.Dict, false)
		case *pb.MontyNode_Module:
			if len(v.Module.Id.GetData()) != 16 || v.Module.Name == "" {
				return arena{}, errors.New("invalid worker module")
			}
			err = pairs(v.Module.Attrs, true)
		case *pb.MontyNode_Type:
			if v.Type.Name == "" || (v.Type.Origin != pb.TypeOrigin_TYPE_ORIGIN_BUILTIN || v.Type.Id != nil) &&
				((v.Type.Origin != pb.TypeOrigin_TYPE_ORIGIN_SANDBOX && v.Type.Origin != pb.TypeOrigin_TYPE_ORIGIN_HOST) || len(v.Type.Id.GetData()) != 16) {
				return arena{}, errors.New("invalid worker type")
			}
			err = pairs(v.Type.Attrs, true)
		case *pb.MontyNode_ClassInstance:
			ci := v.ClassInstance
			if err := child(ci.ClassType); err != nil {
				return arena{}, err
			}
			class := a.nodes[ci.ClassType].GetType()
			if len(ci.InstanceId.GetData()) != 16 || class == nil || class.Origin == pb.TypeOrigin_TYPE_ORIGIN_BUILTIN {
				return arena{}, errors.New("invalid worker class instance")
			}
			err = pairs(ci.Attrs, true)
		case *pb.MontyNode_Complex:
			if v.Complex.Real == nil || v.Complex.Imag == nil {
				return arena{}, errors.New("invalid worker complex number")
			}
		case *pb.MontyNode_Bigint:
			if len(v.Bigint.Magnitude) > 4096 {
				return arena{}, errors.New("worker integer exceeds magnitude limit")
			}
			// Budget decimal rendering too, including repeated references.
			size.bytes += 8 * len(v.Bigint.Magnitude)
		case *pb.MontyNode_Date:
			if !validDate(v.Date.Year, v.Date.Month, v.Date.Day) {
				return arena{}, errors.New("invalid worker date")
			}
		case *pb.MontyNode_Datetime:
			d := v.Datetime
			if !validDate(d.Year, d.Month, d.Day) || !validTime(d.Hour, d.Minute, d.Second, d.Microsecond, d.OffsetSeconds, d.TimezoneName) {
				return arena{}, errors.New("invalid worker datetime")
			}
		case *pb.MontyNode_Time:
			t := v.Time
			if t.Fold > 1 || !validTime(t.Hour, t.Minute, t.Second, t.Microsecond, t.OffsetSeconds, t.TimezoneName) {
				return arena{}, errors.New("invalid worker time")
			}
		case *pb.MontyNode_Timedelta:
			t := v.Timedelta
			if t.Days < -999999999 || t.Days > 999999999 || t.Seconds < 0 || t.Seconds >= 86400 || t.Microseconds < 0 || t.Microseconds >= 1000000 {
				return arena{}, errors.New("invalid worker timedelta")
			}
		case *pb.MontyNode_Timezone:
			if !validOffset(v.Timezone.OffsetSeconds) {
				return arena{}, errors.New("invalid worker timezone")
			}
		case *pb.MontyNode_Exception:
			if !exceptionName(v.Exception.ExcType) {
				return arena{}, errors.New("invalid worker exception value")
			}
		case *pb.MontyNode_Cycle:
			if v.Cycle != "[...]" && v.Cycle != "(...)" && v.Cycle != "{...}" && v.Cycle != "..." {
				return arena{}, errors.New("invalid worker cycle")
			}
		case *pb.MontyNode_None, *pb.MontyNode_Ellipsis, *pb.MontyNode_NotImplemented, *pb.MontyNode_Boolean,
			*pb.MontyNode_Int, *pb.MontyNode_Float, *pb.MontyNode_Str, *pb.MontyNode_Bytes,
			*pb.MontyNode_Function, *pb.MontyNode_BuiltinFunction, *pb.MontyNode_Path, *pb.MontyNode_Repr, *pb.MontyNode_Decimal:
		case *pb.MontyNode_FileHandle:
			// This client never authorizes opening a file.
			return arena{}, errors.New("unexpected worker file handle")
		default:
			return arena{}, errors.New("invalid worker value type")
		}
		if err != nil {
			return arena{}, err
		}
		if err := size.check(); err != nil {
			return arena{}, err
		}
		a.sizes[i] = size
	}
	return a, nil
}

func (s valueSize) check() error {
	if s.bytes > maxExpanded || s.depth > maxValueDepth {
		return errExpanded
	}
	return nil
}

func (a arena) roots(groups ...[]uint32) error {
	left := maxExpanded
	for _, group := range groups {
		for _, id := range group {
			if id >= uint32(len(a.nodes)) {
				return fmt.Errorf("invalid worker root index %d", id)
			}
			left -= a.sizes[id].bytes
			if left < 0 {
				return errExpanded
			}
		}
	}
	return nil
}

func validDate(year int32, month, day uint32) bool {
	return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
		time.Date(int(year), time.Month(month), int(day), 0, 0, 0, 0, time.UTC).Month() == time.Month(month)
}

func validOffset(s int32) bool { return s > -86400 && s < 86400 }

func validTime(h, m, s, us uint32, offset *int32, name *string) bool {
	return h < 24 && m < 60 && s < 60 && us < 1000000 && (offset != nil && validOffset(*offset) || offset == nil && name == nil)
}

func items(n *pb.MontyNode) []uint32 {
	switch v := n.Kind.(type) {
	case *pb.MontyNode_List:
		return v.List.Items
	case *pb.MontyNode_Tuple:
		return v.Tuple.Items
	case *pb.MontyNode_Set:
		return v.Set.Items
	case *pb.MontyNode_FrozenSet:
		return v.FrozenSet.Items
	case *pb.MontyNode_NamedTuple:
		return v.NamedTuple.Values
	}
	return nil
}

func (a arena) jsonValue(id uint32) any {
	switch v := a.nodes[id].Kind.(type) {
	case *pb.MontyNode_None:
		return nil
	case *pb.MontyNode_Boolean:
		return v.Boolean
	case *pb.MontyNode_Int:
		return v.Int
	case *pb.MontyNode_Float:
		if !math.IsInf(v.Float, 0) && !math.IsNaN(v.Float) {
			return v.Float
		}
	case *pb.MontyNode_Str:
		return v.Str
	case *pb.MontyNode_List, *pb.MontyNode_Tuple, *pb.MontyNode_Set, *pb.MontyNode_FrozenSet:
		ids := items(a.nodes[id])
		out := make([]any, len(ids))
		for i, child := range ids {
			out[i] = a.jsonValue(child)
		}
		return out
	case *pb.MontyNode_Dict:
		out := make(map[string]any, len(v.Dict.Pairs))
		for _, p := range v.Dict.Pairs {
			key, ok := a.nodes[p.Key].Kind.(*pb.MontyNode_Str)
			if ok {
				out[key.Str] = a.jsonValue(p.Value)
			} else {
				out[a.repr(p.Key)] = a.jsonValue(p.Value)
			}
		}
		return out
	}
	return a.repr(id)
}

// Build a post-order arena from the agent's JSON value. Use the Rust adapter's
// number policy: signed 64-bit integers stay integers, other numbers are floats.
func encodeValue(v any) (*pb.Arena, uint32, error) {
	var a pb.Arena
	left := maxFrame
	var encode func(any, int) (uint32, error)
	encode = func(v any, depth int) (uint32, error) {
		left -= 64
		if depth > maxValueDepth || left < 0 {
			return 0, errors.New("tool result exceeds worker value budget")
		}
		n := new(pb.MontyNode)
		switch x := v.(type) {
		case nil:
			n.Kind = &pb.MontyNode_None{None: &pb.Unit{}}
		case bool:
			n.Kind = &pb.MontyNode_Boolean{Boolean: x}
		case json.Number:
			if i, err := x.Int64(); err == nil {
				n.Kind = &pb.MontyNode_Int{Int: i}
			} else if f, err := x.Float64(); err == nil {
				n.Kind = &pb.MontyNode_Float{Float: f}
			} else {
				return 0, err
			}
		case string:
			left -= len(x)
			n.Kind = &pb.MontyNode_Str{Str: x}
		case []any:
			if len(x) > left/64 {
				return 0, errors.New("tool result exceeds worker value budget")
			}
			ids := make([]uint32, 0, len(x))
			for _, item := range x {
				id, err := encode(item, depth+1)
				if err != nil {
					return 0, err
				}
				ids = append(ids, id)
			}
			n.Kind = &pb.MontyNode_List{List: &pb.Indexes{Items: ids}}
		case map[string]any:
			if len(x) > left/128 {
				return 0, errors.New("tool result exceeds worker value budget")
			}
			keys := make([]string, 0, len(x))
			for key := range x {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			pairs := make([]*pb.NodePair, 0, len(x))
			for _, key := range keys {
				k, err := encode(key, depth+1)
				if err != nil {
					return 0, err
				}
				id, err := encode(x[key], depth+1)
				if err != nil {
					return 0, err
				}
				pairs = append(pairs, &pb.NodePair{Key: k, Value: id})
			}
			n.Kind = &pb.MontyNode_Dict{Dict: &pb.NodePairs{Pairs: pairs}}
		default:
			return 0, fmt.Errorf("cannot send %T to sandbox", v)
		}
		if left < 0 {
			return 0, errors.New("tool result exceeds worker value budget")
		}
		return appendNode(&a, n), nil
	}
	id, err := encode(v, 1)
	return &a, id, err
}

func appendNode(a *pb.Arena, node *pb.MontyNode) uint32 {
	id := uint32(len(a.Nodes))
	a.Nodes = append(a.Nodes, node)
	a.NodeCount = id + 1
	return id
}

func floatRepr(f float64) string {
	switch {
	case math.IsNaN(f):
		return "nan"
	case math.IsInf(f, 1):
		return "inf"
	case math.IsInf(f, -1):
		return "-inf"
	}
	// Python uses fixed notation for exponents from -4 through 15.
	m := math.Abs(f)
	if m != 0 && (m < 1e-4 || m >= 1e16) {
		return strconv.FormatFloat(f, 'e', -1, 64)
	}
	s := strconv.FormatFloat(f, 'f', -1, 64)
	if !strings.Contains(s, ".") {
		return s + ".0"
	}
	return s
}

func bigintRepr(v *pb.BigInt) string {
	n := new(big.Int).SetBytes(v.Magnitude)
	if v.Negative {
		n.Neg(n)
	}
	return n.String()
}

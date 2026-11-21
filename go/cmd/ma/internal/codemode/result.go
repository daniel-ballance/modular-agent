package codemode

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
)

type finalValue struct {
	arena
	id uint32
}

func (v finalValue) text() string {
	switch n := v.nodes[v.id].Kind.(type) {
	case *pb.MontyNode_None:
		return ""
	case *pb.MontyNode_Str:
		return n.Str
	}
	var compact strings.Builder
	if v.writeJSON(&compact, v.id) {
		var pretty bytes.Buffer
		if json.Indent(&pretty, []byte(compact.String()), "", "  ") == nil {
			return pretty.String()
		}
	}
	return v.repr(v.id)
}

// Walk the arena before converting to host values. JSON accepts only some
// Python types and dict keys, and must preserve dict order and float spelling.
// If any node cannot be encoded, render the original value's repr instead.
func (a arena) writeJSON(out *strings.Builder, id uint32) bool {
	n := a.nodes[id]
	switch v := n.Kind.(type) {
	case *pb.MontyNode_Str:
		writeJSONString(out, v.Str)
	case *pb.MontyNode_List, *pb.MontyNode_Tuple, *pb.MontyNode_NamedTuple:
		out.WriteByte('[')
		for i, child := range items(n) {
			if i > 0 {
				out.WriteByte(',')
			}
			if !a.writeJSON(out, child) {
				return false
			}
		}
		out.WriteByte(']')
	case *pb.MontyNode_Dict:
		out.WriteByte('{')
		for i, p := range v.Dict.Pairs {
			if i > 0 {
				out.WriteByte(',')
			}
			if key, ok := a.nodes[p.Key].Kind.(*pb.MontyNode_Str); ok {
				writeJSONString(out, key.Str)
			} else if key, ok := jsonScalar(a.nodes[p.Key]); ok {
				writeJSONString(out, key)
			} else {
				return false
			}
			out.WriteByte(':')
			if !a.writeJSON(out, p.Value) {
				return false
			}
		}
		out.WriteByte('}')
	default:
		s, ok := jsonScalar(n)
		if !ok {
			return false
		}
		out.WriteString(s)
	}
	return true
}

func jsonScalar(n *pb.MontyNode) (string, bool) {
	switch v := n.Kind.(type) {
	case *pb.MontyNode_None:
		return "null", true
	case *pb.MontyNode_Boolean:
		return strconv.FormatBool(v.Boolean), true
	case *pb.MontyNode_Int:
		return strconv.FormatInt(v.Int, 10), true
	case *pb.MontyNode_Bigint:
		return bigintRepr(v.Bigint), true
	case *pb.MontyNode_Float:
		if !math.IsInf(v.Float, 0) && !math.IsNaN(v.Float) {
			return floatRepr(v.Float), true
		}
	}
	return "", false
}

// Unlike encoding/json, Python with ensure_ascii=False leaves U+2028 and
// U+2029 unescaped. Only ASCII quotes, backslashes and controls need escaping.
func writeJSONString(out *strings.Builder, s string) {
	const hex = "0123456789abcdef"
	out.WriteByte('"')
	start := 0
	for i := range len(s) {
		b := s[i]
		if b >= ' ' && b != '"' && b != '\\' {
			continue
		}
		out.WriteString(s[start:i])
		start = i + 1
		switch b {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteByte(b)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			out.WriteString(`\u00`)
			out.WriteByte(hex[b>>4])
			out.WriteByte(hex[b&15])
		}
	}
	out.WriteString(s[start:])
	out.WriteByte('"')
}

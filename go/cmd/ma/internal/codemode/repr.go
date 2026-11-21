package codemode

import (
	"fmt"
	"math"
	"strings"
	"unicode"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
)

func (a arena) repr(id uint32) string {
	var out strings.Builder
	var render func(uint32)
	render = func(id uint32) {
		n := a.nodes[id]
		sequence := func(open, close string) {
			out.WriteString(open)
			for i, item := range items(n) {
				if i > 0 {
					out.WriteString(", ")
				}
				render(item)
			}
			out.WriteString(close)
		}
		switch v := n.Kind.(type) {
		case *pb.MontyNode_None:
			out.WriteString("None")
		case *pb.MontyNode_Ellipsis:
			out.WriteString("Ellipsis")
		case *pb.MontyNode_NotImplemented:
			out.WriteString("NotImplemented")
		case *pb.MontyNode_Boolean:
			if v.Boolean {
				out.WriteString("True")
			} else {
				out.WriteString("False")
			}
		case *pb.MontyNode_Int:
			fmt.Fprint(&out, v.Int)
		case *pb.MontyNode_Bigint:
			out.WriteString(bigintRepr(v.Bigint))
		case *pb.MontyNode_Float:
			out.WriteString(floatRepr(v.Float))
		case *pb.MontyNode_Complex:
			r, i := *v.Complex.Real, *v.Complex.Imag
			if r == 0 && !math.Signbit(r) {
				fmt.Fprintf(&out, "%sj", strings.TrimSuffix(floatRepr(i), ".0"))
			} else {
				sign := "+"
				if math.Signbit(i) {
					sign = "-"
				}
				fmt.Fprintf(&out, "(%s%s%sj)", strings.TrimSuffix(floatRepr(r), ".0"), sign, strings.TrimSuffix(floatRepr(math.Abs(i)), ".0"))
			}
		case *pb.MontyNode_Str:
			quote(&out, v.Str, false)
		case *pb.MontyNode_Bytes:
			quote(&out, string(v.Bytes), true)
		case *pb.MontyNode_List:
			sequence("[", "]")
		case *pb.MontyNode_Tuple:
			sequence("(", ")")
		case *pb.MontyNode_Set:
			if len(v.Set.Items) == 0 {
				out.WriteString("set()")
			} else {
				sequence("{", "}")
			}
		case *pb.MontyNode_FrozenSet:
			if len(v.FrozenSet.Items) == 0 {
				out.WriteString("frozenset()")
			} else {
				sequence("frozenset({", "})")
			}
		case *pb.MontyNode_Dict:
			out.WriteByte('{')
			for i, p := range v.Dict.Pairs {
				if i > 0 {
					out.WriteString(", ")
				}
				render(p.Key)
				out.WriteString(": ")
				render(p.Value)
			}
			out.WriteByte('}')
		case *pb.MontyNode_NamedTuple:
			fmt.Fprintf(&out, "%s(", v.NamedTuple.TypeName)
			for i, field := range v.NamedTuple.FieldNames {
				if i > 0 {
					out.WriteString(", ")
				}
				fmt.Fprintf(&out, "%s=", field)
				render(v.NamedTuple.Values[i])
			}
			out.WriteByte(')')
		case *pb.MontyNode_ClassInstance:
			fmt.Fprintf(&out, "%s(", a.nodes[v.ClassInstance.ClassType].GetType().Name)
			for i, p := range v.ClassInstance.Attrs.GetPairs() {
				if i > 0 {
					out.WriteString(", ")
				}
				fmt.Fprintf(&out, "%s=", a.nodes[p.Key].GetStr())
				render(p.Value)
			}
			out.WriteByte(')')
		case *pb.MontyNode_Date:
			fmt.Fprintf(&out, "datetime.date(%d, %d, %d)", v.Date.Year, v.Date.Month, v.Date.Day)
		case *pb.MontyNode_Datetime:
			d := v.Datetime
			fmt.Fprintf(&out, "datetime.datetime(%d, %d, %d, %d, %d", d.Year, d.Month, d.Day, d.Hour, d.Minute)
			timeFields(&out, d.Second, d.Microsecond, d.OffsetSeconds, d.TimezoneName)
			out.WriteByte(')')
		case *pb.MontyNode_Time:
			t := v.Time
			fmt.Fprintf(&out, "datetime.time(%d, %d", t.Hour, t.Minute)
			timeFields(&out, t.Second, t.Microsecond, t.OffsetSeconds, t.TimezoneName)
			if t.Fold != 0 {
				out.WriteString(", fold=1")
			}
			out.WriteByte(')')
		case *pb.MontyNode_Timezone:
			zoneRepr(&out, v.Timezone.OffsetSeconds, v.Timezone.Name)
		case *pb.MontyNode_Timedelta:
			d := v.Timedelta
			deltaRepr(&out, d.Days, d.Seconds, d.Microseconds)
		case *pb.MontyNode_Decimal:
			fmt.Fprintf(&out, "Decimal('%s')", v.Decimal)
		case *pb.MontyNode_Exception:
			fmt.Fprintf(&out, "%s(", v.Exception.ExcType)
			if v.Exception.Arg != nil {
				quote(&out, *v.Exception.Arg, false)
			}
			out.WriteByte(')')
		case *pb.MontyNode_Path:
			fmt.Fprintf(&out, "PosixPath('%s')", v.Path)
		case *pb.MontyNode_Type:
			fmt.Fprintf(&out, "<class '%s'>", v.Type.Name)
		case *pb.MontyNode_Function:
			fmt.Fprintf(&out, "<function '%s' external>", v.Function.Name)
		case *pb.MontyNode_BuiltinFunction:
			fmt.Fprintf(&out, "<built-in function %s>", v.BuiltinFunction)
		case *pb.MontyNode_Module:
			out.WriteString("<module ")
			quote(&out, v.Module.Name, false)
			out.WriteByte('>')
		case *pb.MontyNode_Repr:
			out.WriteString("Repr(")
			quote(&out, v.Repr, false)
			out.WriteByte(')')
		case *pb.MontyNode_Cycle:
			out.WriteString(v.Cycle)
		}
	}
	render(id)
	return out.String()
}

func quote(out *strings.Builder, s string, bytes bool) {
	q := '\''
	if strings.ContainsRune(s, q) && !strings.ContainsRune(s, '"') {
		q = '"'
	}
	if bytes {
		out.WriteByte('b')
	}
	out.WriteRune(q)
	write := func(r rune) {
		switch r {
		case q, '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\t':
			out.WriteString(`\t`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		default:
			if bytes && r >= 0x7f || !unicode.IsPrint(r) {
				switch {
				case r < 0x100:
					fmt.Fprintf(out, `\x%02x`, r)
				case r < 0x10000:
					fmt.Fprintf(out, `\u%04x`, r)
				default:
					fmt.Fprintf(out, `\U%08x`, r)
				}
			} else {
				out.WriteRune(r)
			}
		}
	}
	if bytes {
		for i := 0; i < len(s); i++ {
			write(rune(s[i]))
		}
	} else {
		for _, r := range s {
			write(r)
		}
	}
	out.WriteRune(q)
}

func timeFields(out *strings.Builder, s, us uint32, offset *int32, name *string) {
	if s != 0 || us != 0 {
		fmt.Fprintf(out, ", %d", s)
	}
	if us != 0 {
		fmt.Fprintf(out, ", %d", us)
	}
	if offset != nil {
		out.WriteString(", tzinfo=")
		zoneRepr(out, *offset, name)
	}
}

func zoneRepr(out *strings.Builder, offset int32, name *string) {
	if offset == 0 && name == nil {
		out.WriteString("datetime.timezone.utc")
		return
	}
	out.WriteString("datetime.timezone(")
	var days int32
	if offset < 0 {
		days, offset = -1, offset+86400
	}
	deltaRepr(out, days, offset, 0)
	if name != nil {
		out.WriteString(", ")
		quote(out, *name, false)
	}
	out.WriteByte(')')
}

func deltaRepr(out *strings.Builder, days, seconds, us int32) {
	out.WriteString("datetime.timedelta(")
	var fields []string
	if days != 0 {
		fields = append(fields, fmt.Sprintf("days=%d", days))
	}
	if seconds != 0 {
		fields = append(fields, fmt.Sprintf("seconds=%d", seconds))
	}
	if us != 0 {
		fields = append(fields, fmt.Sprintf("microseconds=%d", us))
	}
	if len(fields) == 0 {
		out.WriteByte('0')
	}
	out.WriteString(strings.Join(fields, ", "))
	out.WriteByte(')')
}

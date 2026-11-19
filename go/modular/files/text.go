package files

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

const MaxLines = 2000
const MaxBytes = 50 * 1024
const maxImage = 4_718_592

func size(n int) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%dB", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1fKB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1fMB", float64(n)/(1024*1024))
	}
}
func lines(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(s, "\n"), "\n")
}

type cut struct {
	text               string
	count, total       int
	truncated, byBytes bool
}

func truncate(text string, maxLines, maxBytes int, tail bool) cut {
	all := lines(text)
	if len(all) <= maxLines && len(text) <= maxBytes {
		return cut{text, len(all), len(all), false, false}
	}
	kept := make([]string, 0, min(maxLines, len(all)))
	used := 0
	byBytes := false
	for i := range min(maxLines, len(all)) {
		at := i
		if tail {
			at = len(all) - 1 - i
		}
		line := all[at]
		n := len(line)
		if i > 0 {
			n++
		}
		if used+n > maxBytes {
			byBytes = true
			if i == 0 && tail {
				start := len(line) - maxBytes
				for start < len(line) && !utf8.RuneStart(line[start]) {
					start++
				}
				kept = append(kept, line[start:])
			}
			break
		}
		used += n
		kept = append(kept, line)
	}
	if tail {
		for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
			kept[i], kept[j] = kept[j], kept[i]
		}
	}
	return cut{strings.Join(kept, "\n"), len(kept), len(all), true, byBytes}
}

func readWindow(s, path string, offset int, limit *int) (string, error) {
	all := lines(s)
	total := len(all)
	start := max(0, offset-1)
	if start >= total && (total != 0 || start != 0) {
		return "", fmt.Errorf("Offset %d is beyond end of file (%d lines total)", offset, total)
	}
	end := total
	if limit != nil {
		end = start + min(total-start, *limit)
	}
	c := truncate(strings.Join(all[start:end], "\n"), MaxLines, MaxBytes, false)
	first := start + 1
	if c.truncated && c.count == 0 && c.byBytes {
		return fmt.Sprintf("[Line %d is %s, exceeds %s limit. Use exec: sed -n '%dp' %s | head -c %d]", first, size(len(all[start])), size(MaxBytes), first, path, MaxBytes), nil
	}
	if c.truncated {
		last := start + c.count
		note := ""
		if c.byBytes {
			note = " (" + size(MaxBytes) + " limit)"
		}
		return fmt.Sprintf("%s\n\n[Showing lines %d-%d of %d%s. Use offset=%d to continue.]", c.text, first, last, total, note, last+1), nil
	}
	if end < total {
		return fmt.Sprintf("%s\n\n[%d more lines in file. Use offset=%d to continue.]", c.text, total-end, end+1), nil
	}
	return c.text, nil
}

func listing(names []string, notice string) string {
	c := truncate(strings.Join(names, "\n"), len(names), MaxBytes, false)
	if c.truncated {
		if notice != "" {
			notice += ". "
		}
		notice += size(MaxBytes) + " limit reached"
	}
	if notice == "" {
		return c.text
	}
	return c.text + "\n\n[" + notice + "]"
}

type replacement struct {
	Old string `json:"oldText"`
	New string `json:"newText"`
}

func applyEdits(original, path string, edits []replacement) (string, error) {
	if len(edits) == 0 {
		return "", fmt.Errorf("edits must contain at least one replacement")
	}
	bom := ""
	body, ok := strings.CutPrefix(original, "\ufeff")
	if ok {
		bom = "\ufeff"
	}
	nl := strings.IndexByte(body, '\n')
	crlf := nl > 0 && body[nl-1] == '\r'
	lf := strings.NewReplacer("\r\n", "\n", "\r", "\n")
	base := lf.Replace(body)
	type span struct {
		start, end, index int
		text              string
	}
	spans := make([]span, 0, len(edits))
	for i, e := range edits {
		old := lf.Replace(e.Old)
		label := "oldText"
		if len(edits) > 1 {
			label = fmt.Sprintf("edits[%d].oldText", i)
		}
		if old == "" {
			return "", fmt.Errorf("%s must not be empty in %s", label, path)
		}
		n := strings.Count(base, old)
		if n == 0 {
			return "", fmt.Errorf("Could not find %s in %s. It must match exactly, including all whitespace and newlines", label, path)
		}
		if n != 1 {
			return "", fmt.Errorf("Found %d occurrences of %s in %s. The text must be unique. Provide more context to make it unique", n, label, path)
		}
		at := strings.Index(base, old)
		spans = append(spans, span{at, at + len(old), i, lf.Replace(e.New)})
	}
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	at := 0
	var changed strings.Builder
	for i, s := range spans {
		if at > s.start {
			return "", fmt.Errorf("edits[%d] and edits[%d] overlap in %s. Merge them into one edit or target disjoint regions", spans[i-1].index, s.index, path)
		}
		changed.WriteString(base[at:s.start])
		changed.WriteString(s.text)
		at = s.end
	}
	changed.WriteString(base[at:])
	v := changed.String()
	if v == base {
		return "", fmt.Errorf("No changes made to %s. The replacement produced identical content", path)
	}
	if crlf {
		v = strings.ReplaceAll(v, "\n", "\r\n")
	}
	return bom + v, nil
}

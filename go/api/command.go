package api

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// CommandLine separates the command name from its argument text. Only the
// first separator belongs to the name; quotes and further spaces are data.
func CommandLine(line string) (string, string) {
	line = strings.TrimPrefix(strings.TrimLeftFunc(line, unicode.IsSpace), "/")
	i := strings.IndexFunc(line, unicode.IsSpace)
	if i < 0 {
		return line, ""
	}
	_, n := utf8.DecodeRuneInString(line[i:])
	return line[:i], line[i+n:]
}

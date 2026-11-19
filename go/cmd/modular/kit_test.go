package main_test

import "regexp"

var summaryPattern = regexp.MustCompile(`(?m)^([1-9][0-9]*)/([1-9][0-9]*) checks passed\s*$`)

func allKitChecksPassed(output []byte) bool {
	m := summaryPattern.FindSubmatch(output)
	return len(m) != 0 && string(m[1]) == string(m[2])
}

func kitSummary(output []byte) string {
	return string(summaryPattern.Find(output))
}

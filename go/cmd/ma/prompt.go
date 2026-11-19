package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const preamble = "You are a coding assistant running inside Modular Agent, a coding agent harness. Help users inspect files, run commands, and modify code."
const rules = "<rules>\n- Do your work through codemode, with the functions on `tools`.\n- Use tools.read to examine files instead of cat or sed, and tools.find and tools.list to look for them. Use tools.exec for everything else, such as rg and git.\n- Use tools.edit for targeted changes. Batch changes to one file in a single call.\n- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.\n- Use tools.write only for new files or complete rewrites.\n- Be concise in your responses\n- Show file paths clearly when working with files\n</rules>"

func systemPrompt(global, project string, skills []skill, functions string, date time.Time) (string, error) {
	sections := []string{preamble, rules}
	var ctx strings.Builder
	appendFile := func(path string, b []byte) {
		if strings.TrimSpace(string(b)) == "" {
			return
		}
		if ctx.Len() == 0 {
			ctx.WriteString("<project_context>\nProject-specific instructions and guidelines:")
		}
		fmt.Fprintf(&ctx, "\n\n<project_instructions path=\"%s\">\n%s\n</project_instructions>", path, strings.TrimRightFunc(string(b), unicode.IsSpace))
	}
	if b, err := os.ReadFile(global); err == nil {
		appendFile(global, b)
	}
	folders := []string{project}
	for {
		p := filepath.Dir(folders[len(folders)-1])
		if p == folders[len(folders)-1] {
			break
		}
		folders = append(folders, p)
	}
	for i := len(folders) - 1; i >= 0; i-- {
		for _, n := range []string{"AGENTS.md", "CLAUDE.md"} {
			p := filepath.Join(folders[i], n)
			b, err := os.ReadFile(p)
			if err == nil {
				appendFile(p, b)
				break
			}
			if !os.IsNotExist(err) && !os.IsPermission(err) {
				return "", err
			}
		}
	}
	if ctx.Len() != 0 {
		ctx.WriteString("\n</project_context>")
		sections = append(sections, ctx.String())
	}
	if s := skillPrompt(skills); s != "" {
		sections = append(sections, s)
	}
	if functions != "" {
		sections = append(sections, strings.TrimRight(functions, "\n"))
	}
	sections = append(sections, fmt.Sprintf("<cwd>\n%s\n</cwd>", project), fmt.Sprintf("<date>\n%s\n</date>", date.Format("2006-01-02")))
	return strings.Join(sections, "\n\n"), nil
}

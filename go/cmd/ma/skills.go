package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

type skill struct {
	Name, Description, File string
	ManualOnly              bool
}

var skillName = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
var xmlEscape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;")

func frontmatter(s string) (map[string]string, string, bool) {
	first, rest, ok := strings.Cut(s, "\n")
	if !ok || strings.TrimRight(first, " \t\r") != "---" {
		return nil, s, false
	}
	lines := strings.Split(rest, "\n")
	end := 0
	for end < len(lines) && strings.TrimSuffix(lines[end], "\r") != "---" {
		end++
	}
	if end == len(lines) {
		return nil, s, false
	}
	fields := map[string]string{}
	for i := 0; i < end; i++ {
		l := lines[i]
		if l == "" || strings.ContainsRune(" \t#", rune(l[0])) {
			continue
		}
		key, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch v {
		case ">", ">-", ">+", "|", "|-", "|+":
			sep := "\n"
			if v[0] == '>' {
				sep = " "
			}
			var block []string
			for i+1 < end {
				n := lines[i+1]
				if strings.TrimSpace(n) != "" && !strings.HasPrefix(n, " ") && !strings.HasPrefix(n, "\t") {
					break
				}
				i++
				block = append(block, strings.TrimSpace(n))
			}
			v = strings.TrimSpace(strings.Join(block, sep))
		default:
			if len(v) > 1 && (v[0] == '\'' || v[0] == '"') && v[len(v)-1] == v[0] {
				v = strings.NewReplacer(`\"`, `"`, "''", "'").Replace(v[1 : len(v)-1])
			}
		}
		fields[strings.TrimSpace(key)] = v
	}
	return fields, strings.TrimLeft(strings.Join(lines[end+1:], "\n"), "\r\n"), true
}
func discover(folders []string) ([]skill, []string) {
	var skills []skill
	var problems []string
	seen := map[string]string{}
	var walk func(string, int)
	walk = func(dir string, depth int) {
		path := filepath.Join(dir, "SKILL.md")
		if stat, err := os.Stat(path); err == nil && stat.Mode().IsRegular() {
			b, err := os.ReadFile(path)
			if err != nil {
				problems = append(problems, err.Error())
				return
			}
			f, _, ok := frontmatter(string(b))
			name, hasName := f["name"]
			if !hasName {
				name = filepath.Base(dir)
			}
			desc := f["description"]
			var problem string
			switch {
			case !ok:
				problem = "no front matter"
			case !skillName.MatchString(name):
				problem = "the name must be lowercase letters, digits and hyphens, at most 64 long"
			case strings.TrimSpace(desc) == "":
				problem = "no description"
			case len(desc) > 1024:
				problem = "the description is over 1024 characters"
			case seen[name] != "":
				problem = fmt.Sprintf("skill %s is already defined by %s", name, seen[name])
			default:
				seen[name] = path
				skills = append(skills, skill{name, desc, path, f["disable-model-invocation"] == "true"})
			}
			if problem != "" {
				problems = append(problems, path+": "+problem)
			}
			return
		}
		if depth == 0 {
			return
		}
		children, _ := os.ReadDir(dir)
		for _, c := range children {
			if strings.HasPrefix(c.Name(), ".") || c.Name() == "node_modules" {
				continue
			}
			p := filepath.Join(dir, c.Name())
			if c.IsDir() {
				walk(p, depth-1)
			} else if c.Type()&os.ModeSymlink != 0 {
				if st, e := os.Stat(p); e == nil && st.IsDir() {
					walk(p, depth-1)
				}
			}
		}
	}
	for _, d := range folders {
		walk(d, 6)
	}
	return skills, problems
}
func skillFolders(dir, home, project string) []string {
	return []string{filepath.Join(dir, "skills"), filepath.Join(home, ".agents/skills"), filepath.Join(project, ".agents/skills"), filepath.Join(project, ".modular-agent/skills")}
}

const skillPreamble = "The following skills provide specialized instructions for specific tasks.\nUse tools.read in codemode to load a skill's file when the task matches its description.\nResolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls."

func skillPrompt(skills []skill) string {
	var b strings.Builder
	for _, s := range skills {
		if s.ManualOnly {
			continue
		}
		if b.Len() == 0 {
			b.WriteString("<skills>\n" + skillPreamble + "\n\n<available_skills>\n")
		}
		fmt.Fprintf(&b, "  <skill>\n    <name>%s</name>\n    <description>%s</description>\n    <location>%s</location>\n  </skill>\n", xmlEscape.Replace(s.Name), xmlEscape.Replace(s.Description), xmlEscape.Replace(s.File))
	}
	if b.Len() > 0 {
		b.WriteString("</available_skills>\n</skills>")
	}
	return b.String()
}
func expandSkill(skills []skill, text string) (string, error) {
	rest, ok := strings.CutPrefix(text, "/skill:")
	if !ok {
		return text, nil
	}
	name, args := rest, ""
	if i := strings.IndexFunc(rest, unicode.IsSpace); i >= 0 {
		name, args = rest[:i], strings.TrimSpace(rest[i:])
	}
	for _, s := range skills {
		if s.Name != name {
			continue
		}
		b, err := os.ReadFile(s.File)
		if err != nil {
			return "", err
		}
		_, body, _ := frontmatter(string(b))
		out := fmt.Sprintf("<skill name=\"%s\" location=\"%s\">\nReferences are relative to %s.\n\n%s\n</skill>", xmlEscape.Replace(s.Name), xmlEscape.Replace(s.File), filepath.Dir(s.File), strings.TrimRightFunc(body, unicode.IsSpace))
		if args != "" {
			out += "\n\n" + args
		}
		return out, nil
	}
	return "", fmt.Errorf("no skill named %s", name)
}

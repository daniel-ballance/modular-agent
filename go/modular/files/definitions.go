package files

import (
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/modular"
)

func define[Out any](name, description, properties, required string, readOnly bool, run func(context.Context, input, *modular.ToolContext) (Out, error)) modular.Tool {
	var opts []modular.ToolOption
	if readOnly {
		opts = append(opts, modular.ReadOnly(), modular.Parallel(), modular.SafeToRepeat())
	}
	schema := `{"type":"object","properties":` + properties + `,"required":[` + required + `],"additionalProperties":false}`
	return modular.NewSchemaTool(name, description, json.RawMessage(schema), run, opts...)
}

// Tools returns the six tools in standard order.
func Tools(spill string) []modular.Tool {
	return []modular.Tool{
		define("read", `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`, `{
                "path":{"type":"string","description":"Path to the file to read (relative or absolute)"},
                "offset":{"type":"number","description":"Line number to start reading from (1-indexed)"},
                "limit":{"type":"number","description":"Maximum number of lines to read"}
            }`, `"path"`, true, readFile),
		define("exec", `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`, `{
                "command":{"type":"string","description":"Shell command to execute"},
                "timeout":{"type":"number","description":"Timeout in seconds (optional, no default timeout)"}
            }`, `"command"`, false, runCommand(spill)),
		define("edit", `Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.`, `{
                "path":{"type":"string","description":"Path to the file to edit (relative or absolute)"},
                "edits":{"type":"array","description":"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                    "items":{"type":"object","properties":{
                        "oldText":{"type":"string","description":"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."},
                        "newText":{"type":"string","description":"Replacement text for this targeted edit."}
                    },"required":["oldText","newText"],"additionalProperties":false}}
            }`, `"path", "edits"`, false, editFile),
		define("write", `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.`, `{
                "path":{"type":"string","description":"Path to the file to write (relative or absolute)"},
                "content":{"type":"string","description":"Content to write to the file"}
            }`, `"path", "content"`, false, writeFile),
		define("find", `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).`, `{
                "pattern":{"type":"string","description":"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"},
                "path":{"type":"string","description":"Directory to search in (default: current directory)"},
                "limit":{"type":"number","description":"Maximum number of results (default: 1000)"}
            }`, `"pattern"`, true, findFiles),
		define("list", `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).`, `{
                "path":{"type":"string","description":"Directory to list (default: current directory)"},
                "limit":{"type":"number","description":"Maximum number of entries to return (default: 500)"}
            }`, ``, true, listDir),
	}
}

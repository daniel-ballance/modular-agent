// Tool definitions from the standard configuration.
export const definitions = {
  "read": {
    "description": "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
    "input": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Path to the file to read (relative or absolute)"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of lines to read"
        },
        "offset": {
          "type": "number",
          "description": "Line number to start reading from (1-indexed)"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "readOnly": true
  },
  "exec": {
    "description": "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
    "input": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "Shell command to execute"
        },
        "timeout": {
          "type": "number",
          "description": "Timeout in seconds (optional, no default timeout)"
        }
      },
      "required": [
        "command"
      ],
      "additionalProperties": false
    },
    "readOnly": false
  },
  "edit": {
    "description": "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    "input": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Path to the file to edit (relative or absolute)"
        },
        "edits": {
          "type": "array",
          "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
          "items": {
            "type": "object",
            "properties": {
              "oldText": {
                "type": "string",
                "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
              },
              "newText": {
                "type": "string",
                "description": "Replacement text for this targeted edit."
              }
            },
            "required": [
              "oldText",
              "newText"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "path",
        "edits"
      ],
      "additionalProperties": false
    },
    "readOnly": false
  },
  "write": {
    "description": "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    "input": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Path to the file to write (relative or absolute)"
        },
        "content": {
          "type": "string",
          "description": "Content to write to the file"
        }
      },
      "required": [
        "path",
        "content"
      ],
      "additionalProperties": false
    },
    "readOnly": false
  },
  "find": {
    "description": "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
    "input": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"
        },
        "path": {
          "type": "string",
          "description": "Directory to search in (default: current directory)"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of results (default: 1000)"
        }
      },
      "required": [
        "pattern"
      ],
      "additionalProperties": false
    },
    "readOnly": true
  },
  "list": {
    "description": "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
    "input": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Directory to list (default: current directory)"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of entries to return (default: 500)"
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "readOnly": true
  }
} as const;

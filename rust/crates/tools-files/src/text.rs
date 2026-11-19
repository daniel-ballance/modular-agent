//! Text handling shared by the tools: line windows, output limits and edits.
use crate::{MAX_BYTES, MAX_LINES};
use agent_api::*;

pub fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Lines as a person counts them: a final newline ends the last line and
/// does not start an empty one.
fn lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return vec![];
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

pub struct Cut {
    pub content: String,
    pub truncated: bool,
    pub by_bytes: bool,
    pub total_lines: usize,
    pub output_lines: usize,
    /// Head only: the first line alone is over the byte limit.
    pub first_line_too_long: bool,
}

/// Keep whole lines from the start, within both limits.
pub fn truncate_head(content: &str, max_lines: usize, max_bytes: usize) -> Cut {
    let all = lines(content);
    let total_lines = all.len();
    if total_lines <= max_lines && content.len() <= max_bytes {
        return Cut {
            content: content.into(),
            truncated: false,
            by_bytes: false,
            total_lines,
            output_lines: total_lines,
            first_line_too_long: false,
        };
    }
    if all.first().is_some_and(|line| line.len() > max_bytes) {
        return Cut {
            content: String::new(),
            truncated: true,
            by_bytes: true,
            total_lines,
            output_lines: 0,
            first_line_too_long: true,
        };
    }
    let mut kept = vec![];
    let mut bytes = 0;
    let mut by_bytes = false;
    for line in all.iter().take(max_lines) {
        let size = line.len() + usize::from(!kept.is_empty());
        if bytes + size > max_bytes {
            by_bytes = true;
            break;
        }
        bytes += size;
        kept.push(*line);
    }
    Cut {
        content: kept.join("\n"),
        truncated: true,
        by_bytes,
        total_lines,
        output_lines: kept.len(),
        first_line_too_long: false,
    }
}

/// Keep whole lines from the end, within both limits. A single last line over
/// the byte limit is cut at a character boundary.
pub fn truncate_tail(content: &str, max_lines: usize, max_bytes: usize) -> Cut {
    let all = lines(content);
    let total_lines = all.len();
    if total_lines <= max_lines && content.len() <= max_bytes {
        return Cut {
            content: content.into(),
            truncated: false,
            by_bytes: false,
            total_lines,
            output_lines: total_lines,
            first_line_too_long: false,
        };
    }
    let mut kept = vec![];
    let mut bytes = 0;
    let mut by_bytes = false;
    for line in all.iter().rev().take(max_lines) {
        let size = line.len() + usize::from(!kept.is_empty());
        if bytes + size > max_bytes {
            by_bytes = true;
            if kept.is_empty() {
                let mut start = line.len() - max_bytes;
                while !line.is_char_boundary(start) {
                    start += 1;
                }
                kept.push(&line[start..]);
            }
            break;
        }
        bytes += size;
        kept.push(*line);
    }
    kept.reverse();
    Cut {
        content: kept.join("\n"),
        truncated: true,
        by_bytes,
        total_lines,
        output_lines: kept.len(),
        first_line_too_long: false,
    }
}

/// What `read` returns for a text file: the asked window, cut to the limits,
/// with a note saying how to continue.
pub fn read_window(
    content: &str,
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<String> {
    let all = lines(content);
    let total = all.len();
    let start = offset.map(|n| n.saturating_sub(1)).unwrap_or(0);
    if start >= total && !(total == 0 && start == 0) {
        bail!(
            "Offset {} is beyond end of file ({total} lines total)",
            offset.unwrap_or(0)
        );
    }
    let end = limit.map_or(total, |n| (start + n).min(total));
    let window = all[start.min(total)..end].join("\n");
    let cut = truncate_head(&window, MAX_LINES, MAX_BYTES);
    let first = start + 1;
    if cut.first_line_too_long {
        return Ok(format!(
            "[Line {first} is {}, exceeds {} limit. Use exec: sed -n '{first}p' {path} | head -c {MAX_BYTES}]",
            format_size(all[start].len()),
            format_size(MAX_BYTES)
        ));
    }
    if cut.truncated {
        let last = first + cut.output_lines - 1;
        let limit_note = if cut.by_bytes {
            format!(" ({} limit)", format_size(MAX_BYTES))
        } else {
            String::new()
        };
        return Ok(format!(
            "{}\n\n[Showing lines {first}-{last} of {total}{limit_note}. Use offset={} to continue.]",
            cut.content,
            last + 1
        ));
    }
    if end < total {
        return Ok(format!(
            "{}\n\n[{} more lines in file. Use offset={} to continue.]",
            cut.content,
            total - end,
            end + 1
        ));
    }
    Ok(cut.content)
}

/// Join names one to a line, stop at the byte limit, and add the notices.
pub fn bounded_listing(names: Vec<String>, mut notices: Vec<String>) -> String {
    let cut = truncate_head(&names.join("\n"), usize::MAX, MAX_BYTES);
    if cut.truncated {
        notices.push(format!("{} limit reached", format_size(MAX_BYTES)));
    }
    if notices.is_empty() {
        cut.content
    } else {
        format!("{}\n\n[{}]", cut.content, notices.join(". "))
    }
}

/// A pattern without '/' matches a file's name anywhere, as `fd` does.
/// One with '/' matches the path from the search directory.
pub fn glob_filter(files: Vec<String>, pattern: &str) -> Result<Vec<String>> {
    let by_path = pattern.contains('/');
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    let glob = globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| anyhow!("invalid glob pattern: {e}"))?
        .compile_matcher();
    Ok(files
        .into_iter()
        .filter(|file| {
            if by_path {
                glob.is_match(file)
            } else {
                glob.is_match(file.rsplit('/').next().unwrap_or(file))
            }
        })
        .collect())
}

fn edit_label(index: usize, total: usize) -> String {
    if total == 1 {
        "oldText".into()
    } else {
        format!("edits[{index}].oldText")
    }
}

/// Apply every edit against the original text. Matching ignores the file's
/// line-ending style and a byte order mark, and both are kept.
pub fn apply_edits(original: &str, edits: &[(&str, &str)], path: &str) -> Result<String> {
    ensure!(!edits.is_empty(), "edits must contain at least one replacement");
    let (bom, body) = match original.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", original),
    };
    let crlf = body
        .find('\n')
        .is_some_and(|at| at > 0 && body.as_bytes()[at - 1] == b'\r');
    let to_lf = |text: &str| text.replace("\r\n", "\n").replace('\r', "\n");
    let base = to_lf(body);
    let total = edits.len();
    let mut spans = vec![];
    for (index, (old, new)) in edits.iter().enumerate() {
        let (old, new) = (to_lf(old), to_lf(new));
        let label = edit_label(index, total);
        ensure!(!old.is_empty(), "{label} must not be empty in {path}.");
        let count = base.matches(&old).count();
        ensure!(
            count != 0,
            "Could not find {label} in {path}. It must match exactly, including all whitespace and newlines."
        );
        ensure!(
            count == 1,
            "Found {count} occurrences of {label} in {path}. The text must be unique. Provide more context to make it unique."
        );
        let start = base.find(&old).unwrap();
        spans.push((start, start + old.len(), new, index));
    }
    spans.sort_by_key(|span| span.0);
    for pair in spans.windows(2) {
        ensure!(
            pair[0].1 <= pair[1].0,
            "edits[{}] and edits[{}] overlap in {path}. Merge them into one edit or target disjoint regions.",
            pair[0].3,
            pair[1].3
        );
    }
    let mut changed = String::with_capacity(base.len());
    let mut at = 0;
    for (start, end, new, _) in &spans {
        changed.push_str(&base[at..*start]);
        changed.push_str(new);
        at = *end;
    }
    changed.push_str(&base[at..]);
    ensure!(
        changed != base,
        "No changes made to {path}. The replacement produced identical content."
    );
    if crlf {
        changed = changed.replace('\n', "\r\n");
    }
    Ok(format!("{bom}{changed}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_window_reports_how_to_continue() {
        let text = "a\nb\nc\nd\n";
        assert_eq!(read_window(text, "f", None, None).unwrap(), "a\nb\nc\nd");
        assert_eq!(
            read_window(text, "f", Some(2), Some(2)).unwrap(),
            "b\nc\n\n[1 more lines in file. Use offset=4 to continue.]"
        );
        assert!(
            read_window(text, "f", Some(9), None)
                .unwrap_err()
                .to_string()
                .contains("beyond end of file (4 lines total)")
        );
        assert_eq!(read_window("", "f", None, None).unwrap(), "");
        let long = "x\n".repeat(MAX_LINES + 5);
        let out = read_window(&long, "f", None, None).unwrap();
        assert!(out.ends_with(&format!(
            "[Showing lines 1-{MAX_LINES} of {}. Use offset={} to continue.]",
            MAX_LINES + 5,
            MAX_LINES + 1
        )));
        let wide = format!("{}\nrest\n", "y".repeat(MAX_BYTES + 1));
        assert!(
            read_window(&wide, "f", None, None)
                .unwrap()
                .starts_with("[Line 1 is 50.0KB, exceeds 50.0KB limit.")
        );
    }

    #[test]
    fn tail_keeps_the_end_and_whole_lines() {
        let text = (1..=10).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        let cut = truncate_tail(&text, 3, 1000);
        assert_eq!(cut.content, "8\n9\n10");
        assert!(cut.truncated && !cut.by_bytes);
        assert_eq!((cut.total_lines, cut.output_lines), (10, 3));
        let cut = truncate_tail("aaaa\nbbbb\ncccc", 10, 9);
        assert_eq!(cut.content, "bbbb\ncccc");
        assert!(cut.by_bytes);
        let cut = truncate_tail("héllo wörld", 10, 4);
        assert_eq!(cut.content, "rld");
    }

    #[test]
    fn edits_match_the_original_and_keep_its_line_endings() {
        let out = apply_edits("one\r\ntwo\r\nthree\r\n", &[("two\n", "2\n"), ("one", "1")], "f")
            .unwrap();
        assert_eq!(out, "1\r\n2\r\nthree\r\n");
        let out = apply_edits("\u{feff}a b", &[("a", "c")], "f").unwrap();
        assert_eq!(out, "\u{feff}c b");
        let error = |edits: &[(&str, &str)]| {
            apply_edits("x y x z", edits, "f").unwrap_err().to_string()
        };
        assert!(error(&[("x", "q")]).contains("Found 2 occurrences of oldText"));
        assert!(error(&[("w", "q")]).contains("Could not find oldText"));
        assert!(error(&[("y x", "q"), ("x z", "r")]).contains("overlap"));
        assert!(error(&[("y", "y")]).contains("No changes made"));
        assert!(error(&[("", "y")]).contains("must not be empty"));
    }

    #[test]
    fn globs_match_names_or_paths() {
        let files = || {
            ["a.rs", "src/b.rs", "src/deep/c.rs", "src/d.txt"]
                .map(String::from)
                .to_vec()
        };
        assert_eq!(
            glob_filter(files(), "*.rs").unwrap(),
            ["a.rs", "src/b.rs", "src/deep/c.rs"]
        );
        assert_eq!(glob_filter(files(), "src/*.rs").unwrap(), ["src/b.rs"]);
        assert_eq!(
            glob_filter(files(), "src/**/*.rs").unwrap(),
            ["src/b.rs", "src/deep/c.rs"]
        );
        assert!(glob_filter(files(), "[").is_err());
    }
}

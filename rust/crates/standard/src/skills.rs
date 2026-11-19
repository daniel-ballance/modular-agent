//! Agent Skills (https://agentskills.io/specification). A skill is a folder
//! with a `SKILL.md`: a name and a description up front, then instructions.
//! The prompt lists each skill's name, description and file. The model reads
//! the file when a task matches, and a person can load one with `/skill:name`.
use anyhow::{Result, anyhow, ensure};
use modular_agent::{Command, InputChange, Order, Plugin};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 1024;
const MAX_DEPTH: usize = 6;

#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub file: PathBuf,
    /// Listed for people only: the model is not told about it.
    pub manual_only: bool,
}

/// The few YAML forms skill files use up front: `key: value`, quoted values,
/// and `>` or `|` blocks.
pub fn frontmatter(text: &str) -> Option<(BTreeMap<String, String>, &str)> {
    let rest = text.strip_prefix("---")?.trim_start_matches([' ', '\t']);
    let rest = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))?;
    let end = rest
        .match_indices("\n---")
        .find(|(at, _)| {
            let after = &rest[at + 4..];
            after.is_empty() || after.starts_with('\n') || after.starts_with("\r\n")
        })?
        .0;
    let (head, body) = (&rest[..end], &rest[end + 4..]);
    let mut fields = BTreeMap::new();
    let mut lines = head.lines().peekable();
    while let Some(line) = lines.next() {
        if line.starts_with([' ', '\t', '#']) || line.trim().is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let value = if matches!(value, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
            let folded = value.starts_with('>');
            let mut block = vec![];
            while let Some(next) = lines.peek() {
                if !next.trim().is_empty() && !next.starts_with([' ', '\t']) {
                    break;
                }
                block.push(lines.next().unwrap().trim());
            }
            block
                .join(if folded { " " } else { "\n" })
                .trim()
                .to_owned()
        } else {
            let quoted = value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\'')));
            if quoted {
                value[1..value.len() - 1]
                    .replace("\\\"", "\"")
                    .replace("''", "'")
            } else {
                value.to_owned()
            }
        };
        fields.insert(key.trim().to_owned(), value);
    }
    Some((fields, body.trim_start_matches(['\r', '\n'])))
}

fn load(file: &Path) -> Result<Skill> {
    let text = std::fs::read_to_string(file)?;
    let (fields, _) = frontmatter(&text).ok_or_else(|| anyhow!("no front matter"))?;
    let folder = file
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = fields.get("name").cloned().unwrap_or(folder);
    ensure!(
        !name.is_empty()
            && name.len() <= MAX_NAME
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "the name must be lowercase letters, digits and hyphens, at most {MAX_NAME} long"
    );
    let description = fields.get("description").cloned().unwrap_or_default();
    ensure!(!description.trim().is_empty(), "no description");
    ensure!(
        description.len() <= MAX_DESCRIPTION,
        "the description is over {MAX_DESCRIPTION} characters"
    );
    Ok(Skill {
        name,
        description,
        file: file.to_owned(),
        manual_only: fields
            .get("disable-model-invocation")
            .is_some_and(|v| v == "true"),
    })
}

/// A folder with a `SKILL.md` is one skill and is not searched further.
fn walk(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    let file = dir.join("SKILL.md");
    if file.is_file() {
        found.push(file);
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name().is_some_and(|n| {
                    let name = n.to_string_lossy();
                    !name.starts_with('.') && name != "node_modules"
                })
        })
        .collect();
    children.sort();
    for child in children {
        walk(&child, depth - 1, found);
    }
}

/// Skills from each folder, in order. The first skill with a name wins, so
/// earlier folders take precedence. Problems are returned, not fatal.
pub fn discover(folders: &[PathBuf]) -> (Vec<Skill>, Vec<String>) {
    let (mut skills, mut problems): (Vec<Skill>, Vec<String>) = (vec![], vec![]);
    for folder in folders {
        let mut files = vec![];
        walk(folder, MAX_DEPTH, &mut files);
        for file in files {
            match load(&file) {
                Ok(skill) => match skills.iter().find(|s| s.name == skill.name) {
                    Some(first) => problems.push(format!(
                        "{}: skill {} is already defined by {}",
                        file.display(),
                        skill.name,
                        first.file.display()
                    )),
                    None => skills.push(skill),
                },
                Err(error) => problems.push(format!("{}: {error}", file.display())),
            }
        }
    }
    (skills, problems)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn prompt(skills: &[Skill]) -> String {
    let listed: Vec<&Skill> = skills.iter().filter(|s| !s.manual_only).collect();
    if listed.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "The following skills provide specialized instructions for specific tasks.\nUse tools.read in codemode to load a skill's file when the task matches its description.\nResolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.\n\n<available_skills>\n",
    );
    for skill in listed {
        out.push_str(&format!(
            "  <skill>\n    <name>{}</name>\n    <description>{}</description>\n    <location>{}</location>\n  </skill>\n",
            escape(&skill.name),
            escape(&skill.description),
            escape(&skill.file.to_string_lossy())
        ));
    }
    out.push_str("</available_skills>");
    out
}

/// `/skill:name rest` as the input it stands for.
pub fn expand(skills: &[Skill], text: &str) -> Result<Option<String>> {
    let Some(rest) = text.strip_prefix("/skill:") else {
        return Ok(None);
    };
    let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let skill = skills
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow!("no skill named {name}"))?;
    let content = std::fs::read_to_string(&skill.file)?;
    let body = frontmatter(&content).map_or(content.as_str(), |(_, body)| body);
    let folder = skill.file.parent().unwrap_or(Path::new("."));
    let mut out = format!(
        "<skill name=\"{}\" location=\"{}\">\nReferences are relative to {}.\n\n{}\n</skill>",
        escape(&skill.name),
        escape(&skill.file.to_string_lossy()),
        folder.display(),
        body.trim_end()
    );
    if !args.trim().is_empty() {
        out.push_str("\n\n");
        out.push_str(args.trim());
    }
    Ok(Some(out))
}

/// Where skills are looked for: the configuration folder, the shared
/// `~/.agents/skills`, extra folders from settings, then the project's own.
#[derive(Clone)]
pub struct SkillsPlugin {
    pub global: Vec<PathBuf>,
}
impl SkillsPlugin {
    pub fn folders(&self, project: &Path) -> Vec<PathBuf> {
        let mut folders = self.global.clone();
        folders.push(project.join(".agents/skills"));
        folders.push(project.join(".modular-agent/skills"));
        folders
    }
    pub fn for_project(&self, project: &Path) -> Vec<Skill> {
        discover(&self.folders(project)).0
    }
}
impl SkillsPlugin {
    pub fn plugin(self, project: PathBuf) -> Plugin {
        let (input_skills, input_project) = (self.clone(), project.clone());
        Plugin::new("skills")
            .on_input_with(Order::First, move |p| {
                let (skills, project) = (input_skills.clone(), input_project.clone());
                async move {
                    let text = p
                        .content
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("");
                    if let Some(expanded) = expand(&skills.for_project(&project), &text)? {
                        return Ok(InputChange::Change(
                            json!([{"type":"text","text":expanded}]),
                        ));
                    }
                    Ok(InputChange::Pass)
                }
            })
            .command(Command::new(
                "skills",
                "List the available skills.",
                move |_, _| {
                    let (skills, project) = (self.clone(), project.clone());
                    async move {
                        let skills = skills.for_project(&project).into_iter()
                        .map(|s| json!({"name":s.name,"description":s.description,"file":s.file}))
                        .collect::<Vec<_>>();
                        Ok(Some(serde_json::to_string_pretty(&skills)?))
                    }
                },
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(root: &Path, folder: &str, text: &str) {
        let dir = root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), text).unwrap();
    }

    #[test]
    fn front_matter_forms() {
        let (fields, body) = frontmatter(
            "---\nname: pdf-tools\ndescription: >\n  Work with PDFs:\n  merge and split.\nlicense: \"MIT\"\n---\n\n# Use\nSteps.\n",
        )
        .unwrap();
        assert_eq!(fields["name"], "pdf-tools");
        assert_eq!(fields["description"], "Work with PDFs: merge and split.");
        assert_eq!(fields["license"], "MIT");
        assert_eq!(body, "# Use\nSteps.\n");
        assert!(frontmatter("# No front matter").is_none());
        assert!(frontmatter("---\nname: x\nnever closed").is_none());
    }

    #[test]
    fn discovery_lists_valid_skills_and_explains_the_rest() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (root.path().join("a"), root.path().join("b"));
        skill(
            &a,
            "deploy",
            "---\nname: deploy\ndescription: Ship it <fast>\n---\nRun it.",
        );
        skill(
            &a,
            "group/notes",
            "---\ndescription: Take notes\n---\nWrite.",
        );
        skill(
            &a,
            "hidden",
            "---\nname: hidden\ndescription: By hand\ndisable-model-invocation: true\n---\nx",
        );
        skill(&a, "Bad_Name", "---\ndescription: nope\n---\nx");
        skill(&a, "empty", "---\nname: empty\n---\nx");
        skill(
            &b,
            "deploy",
            "---\nname: deploy\ndescription: Shadowed\n---\nx",
        );
        let (skills, problems) = discover(&[a.clone(), b, root.path().join("missing")]);
        let names: Vec<_> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["deploy", "notes", "hidden"]);
        assert_eq!(skills[0].description, "Ship it <fast>");
        assert_eq!(problems.len(), 3);
        let listing = prompt(&skills);
        assert!(listing.contains("<description>Ship it &lt;fast&gt;</description>"));
        assert!(listing.contains("<name>notes</name>") && !listing.contains("hidden"));
        let text = expand(&skills, "/skill:deploy to staging")
            .unwrap()
            .unwrap();
        assert!(text.starts_with("<skill name=\"deploy\""));
        assert!(text.contains("\n\nRun it.\n</skill>\n\nto staging"));
        assert!(expand(&skills, "/skill:nope").is_err());
        assert_eq!(expand(&skills, "plain text").unwrap(), None);
    }
}

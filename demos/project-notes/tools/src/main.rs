use modular_agent::{Code, Error, Plugin, Result, Tool, ToolContext, serve};
use schemars::JsonSchema;
use serde::Deserialize;
use unicode_casefold::UnicodeCaseFold;

const NOTES: &str = "notes.txt";

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddNote {
    note: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchNotes {
    query: String,
}

async fn add_note(input: AddNote, ctx: ToolContext, pause: bool) -> Result<String> {
    let note = input.note;
    if note.trim().is_empty() || note.contains(['\n', '\r']) || note.chars().count() > 200 {
        return Err(ctx.refuse("Use one nonempty line of at most 200 characters."));
    }
    let env = ctx.environment();
    let mut existing = env.read(NOTES).await?;
    existing.extend_from_slice(note.as_bytes());
    existing.push(b'\n');
    env.write(NOTES, &existing).await?;
    if pause {
        std::future::pending::<()>().await;
    }
    Ok(format!("Added: {note}"))
}

async fn search_notes(input: SearchNotes, ctx: ToolContext) -> Result<String> {
    let bytes = ctx.environment().read(NOTES).await?;
    let notes = std::str::from_utf8(&bytes)
        .map_err(|_| Error::new(Code::InvalidRequest, "Notes must be UTF-8."))?;
    let query: String = input.query.case_fold().collect();
    let matches = notes
        .lines()
        .filter(|line| line.case_fold().collect::<String>().contains(&query))
        .collect::<Vec<_>>();
    Ok(if matches.is_empty() {
        "No matching notes.".into()
    } else {
        matches.join("\n")
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let pause = std::env::var("NOTES_DEMO_PAUSE_AFTER_WRITE").as_deref() == Ok("1");
    serve(
        Plugin::new("project-notes")
            .tool(
                Tool::new(
                    "add_note",
                    "Append one line to the project notes. This write is not safe to repeat.",
                )
                .run(move |input, ctx| add_note(input, ctx, pause)),
            )
            .tool(
                Tool::new(
                    "search_notes",
                    "Find lines containing the given text, ignoring case.",
                )
                .read_only()
                .destructive(false)
                .open_world(false)
                .run(search_notes),
            ),
    )
    .await
}

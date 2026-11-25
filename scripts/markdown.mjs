import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

const options = { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] };
// The lazy optional body lets an empty block close on its second line, before any later ---.
const frontMatter = /^---(?:\r\n|\r|\n)(?:(.*?)(?:\r\n|\r|\n))??---(?:\r\n|\r|\n|$)/s;
const bom = /^\uFEFF/;

export const linesOf = (text) => text.split(/\r\n|\r|\n/);

// micromark drops a leading byte-order mark and counts offsets without it, so the text it reads
// starts after the mark. CommonMark has no front matter: its closing --- would underline the line
// above as a heading. Spaces keep the line, column and offset of everything after it.
export const withoutFrontMatter = (source) => source.replace(bom, "").replace(frontMatter, (block) => block.replace(/[^\r\n]/g, " "));

export const parseMarkdown = (source) => fromMarkdown(withoutFrontMatter(source), options);

export function adrStatus(text) {
  return text.replace(bom, "").match(frontMatter)?.[1]?.match(/^status:[ \t]*([^\r\n]+)/m)?.[1].trim().toLowerCase();
}

export function* walk(node, stopAt = []) {
  yield node;
  if (stopAt.includes(node.type)) return;
  for (const child of node.children ?? []) yield* walk(child, stopAt);
}

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

const options = { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] };
const frontMatter = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s;

// CommonMark has no front matter: its closing --- would underline the line above as a heading.
// Spaces keep the line, column and offset of everything after it.
export const withoutFrontMatter = (source) => source.replace(frontMatter, (block) => block.replace(/[^\r\n]/g, " "));

export const parseMarkdown = (source) => fromMarkdown(withoutFrontMatter(source), options);

export function adrStatus(text) {
  return text.match(frontMatter)?.[1].match(/^status:[ \t]*([^\r\n]+)/m)?.[1].trim().toLowerCase();
}

export function* walk(node, stopAt = []) {
  yield node;
  if (stopAt.includes(node.type)) return;
  for (const child of node.children ?? []) yield* walk(child, stopAt);
}

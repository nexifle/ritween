export type HighlightKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "function"
  | "type"
  | "punctuation";

export type HighlightToken = { kind: HighlightKind; text: string };

const KEYWORDS = new Set([
  "abstract",
  "as",
  "asserts",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "module",
  "namespace",
  "new",
  "null",
  "of",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unique",
  "using",
  "var",
  "void",
  "while",
  "yield",
]);

function isIdentStart(char: string) {
  return /[A-Za-z_$]/.test(char);
}
function isIdent(char: string) {
  return /[A-Za-z0-9_$]/.test(char);
}
function isSpace(token: HighlightToken) {
  return token.kind === "plain" && token.text.trim() === "";
}

/** Tokenize TypeScript or JavaScript for the preview source panel. */
export function highlight(code: string): HighlightToken[] {
  const tokens: { kind: HighlightKind | "ident"; text: string }[] = [];
  const length = code.length;
  let index = 0;
  const push = (kind: HighlightKind | "ident", text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && kind !== "ident") last.text += text;
    else tokens.push({ kind, text });
  };
  const scanNumber = () => {
    const start = index;
    if (code[index] === "0" && (code[index + 1] === "x" || code[index + 1] === "X")) {
      index += 2;
      while (index < length && /[0-9a-fA-F_]/.test(code[index])) index += 1;
      push("number", code.slice(start, index));
      return;
    }
    if (code[index] === ".") index += 1;
    while (index < length && /[0-9_]/.test(code[index])) index += 1;
    if (code[index] === "." && /[0-9]/.test(code[index + 1] ?? "")) {
      index += 1;
      while (index < length && /[0-9_]/.test(code[index])) index += 1;
    }
    if (code[index] === "e" || code[index] === "E") {
      let next = index + 1;
      if (code[next] === "+" || code[next] === "-") next += 1;
      if (/[0-9]/.test(code[next] ?? "")) {
        index = next;
        while (index < length && /[0-9_]/.test(code[index])) index += 1;
      }
    }
    push("number", code.slice(start, index));
  };
  const scanString = (quote: string) => {
    const start = index;
    index += 1;
    while (index < length) {
      const char = code[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "\n") break;
      index += 1;
      if (char === quote) break;
    }
    push("string", code.slice(start, index));
  };
  const scanTemplate = () => {
    let start = index;
    index += 1;
    while (index < length) {
      const char = code[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        index += 1;
        push("string", code.slice(start, index));
        return;
      }
      if (char === "$" && code[index + 1] === "{") {
        push("string", code.slice(start, index));
        push("punctuation", "${");
        index += 2;
        scan(true);
        if (code[index] === "}") {
          push("punctuation", "}");
          index += 1;
        }
        start = index;
        continue;
      }
      index += 1;
    }
    push("string", code.slice(start, index));
  };
  const scan = (stopBrace: boolean) => {
    let depth = 0;
    while (index < length) {
      const char = code[index];
      const next = code[index + 1];
      if (stopBrace && char === "}" && depth === 0) return;
      if (char === "/" && next === "/") {
        const start = index;
        index = code.indexOf("\n", index);
        if (index < 0) index = length;
        push("comment", code.slice(start, index));
        continue;
      }
      if (char === "/" && next === "*") {
        const start = index;
        index += 2;
        const end = code.indexOf("*/", index);
        index = end < 0 ? length : end + 2;
        push("comment", code.slice(start, index));
        continue;
      }
      if (char === "'" || char === '"') {
        scanString(char);
        continue;
      }
      if (char === "`") {
        scanTemplate();
        continue;
      }
      if (char === "{" || char === "}") {
        if (char === "{") depth += 1;
        else depth -= 1;
        push("punctuation", char);
        index += 1;
        continue;
      }
      if (/[ \t\r\n]/.test(char)) {
        const start = index;
        while (index < length && /[ \t\r\n]/.test(code[index])) index += 1;
        push("plain", code.slice(start, index));
        continue;
      }
      if (
        (char >= "0" && char <= "9") ||
        (char === "." && next >= "0" && next <= "9")
      ) {
        scanNumber();
        continue;
      }
      if (isIdentStart(char)) {
        const start = index;
        index += 1;
        while (index < length && isIdent(code[index])) index += 1;
        push("ident", code.slice(start, index));
        continue;
      }
      const start = index;
      index += 1;
      while (index < length) {
        const punct = code[index];
        const after = code[index + 1];
        if (
          /[ \t\r\n]/.test(punct) ||
          punct === "'" ||
          punct === '"' ||
          punct === "`" ||
          punct === "{" ||
          punct === "}" ||
          isIdentStart(punct) ||
          (punct >= "0" && punct <= "9") ||
          (punct === "/" && (after === "/" || after === "*"))
        )
          break;
        index += 1;
      }
      push("punctuation", code.slice(start, index));
    }
  };
  scan(false);
  const significant = (from: number, step: number) => {
    let cursor = from;
    while (tokens[cursor] && isSpace(tokens[cursor] as HighlightToken))
      cursor += step;
    return tokens[cursor];
  };
  return tokens.map((token, tokenIndex) => {
    if (token.kind !== "ident") return token as HighlightToken;
    if (KEYWORDS.has(token.text)) return { kind: "keyword", text: token.text };
    const next = significant(tokenIndex + 1, 1);
    if (next?.kind === "punctuation" && next.text.startsWith("("))
      return { kind: "function", text: token.text };
    if (/^[A-Z]/.test(token.text)) return { kind: "type", text: token.text };
    const previous = significant(tokenIndex - 1, -1);
    const openTag =
      previous?.kind === "punctuation" &&
      (previous.text === "<" || previous.text === "</");
    if (openTag && next?.kind === "punctuation" && /^[/|>]/.test(next.text))
      return { kind: "type", text: token.text };
    return { kind: "plain", text: token.text };
  });
}

export function highlightLines(code: string): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];
  for (const token of highlight(code)) {
    const parts = token.text.split("\n");
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ kind: token.kind, text: part });
    });
  }
  if (code.endsWith("\n") && lines.length > 1 && lines[lines.length - 1].length === 0)
    lines.pop();
  return lines;
}

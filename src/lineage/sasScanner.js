// Character-level SAS scanner.
//
// SAS lexes differently enough from SQL that the SQL scanner cannot be reused:
// `*` starts a comment when it opens a statement (and `%*` for the macro
// processor), `--` is not a comment at all, and semicolons terminate every
// statement regardless of parentheses. Getting this wrong is not cosmetic --
// `* drop table x;` would otherwise be read as real code.

/** Quote chars. SAS doubles the quote to escape it; there is no backslash escape. */
const QUOTES = new Set(["'", '"']);

/**
 * Marks every character that sits inside a comment or a quoted string.
 * Returns a Uint8Array: 1 = skippable.
 */
export function maskSas(text) {
  const mask = new Uint8Array(text.length);
  let i = 0;
  // A `*` only opens a comment where a statement may begin: after a semicolon
  // or at the top of the file. Anywhere else it is multiplication.
  let atStatementStart = true;

  while (i < text.length) {
    const ch = text[i];

    // Block comment
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }

    // Statement comment: `* ... ;` or the macro form `%* ... ;`
    if (atStatementStart && (ch === "*" || (ch === "%" && text[i + 1] === "*"))) {
      const semi = text.indexOf(";", i);
      const stop = semi === -1 ? text.length : semi + 1;
      // The terminating semicolon belongs to the comment, so mask it too --
      // otherwise the splitter would cut the script here.
      mask.fill(1, i, stop);
      i = stop;
      atStatementStart = true;
      continue;
    }

    if (QUOTES.has(ch)) {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2; // doubled quote = escaped quote
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      mask.fill(1, i, Math.min(j, text.length));
      i = j;
      atStatementStart = false;
      continue;
    }

    if (ch === ";") {
      atStatementStart = true;
    } else if (!/\s/.test(ch)) {
      atStatementStart = false;
    }

    i += 1;
  }

  return mask;
}

/** Replaces comments with spaces, preserving offsets and line breaks. */
export function blankSasComments(text) {
  const mask = maskSas(text);
  const out = text.split("");
  let i = 0;

  while (i < text.length) {
    if (!mask[i]) {
      i += 1;
      continue;
    }
    // Only comments are blanked; string literals are left alone because their
    // contents are still meaningful (a quoted library name, say).
    const isComment =
      (text[i] === "/" && text[i + 1] === "*") ||
      text[i] === "*" ||
      (text[i] === "%" && text[i + 1] === "*");
    if (!isComment) {
      while (i < text.length && mask[i]) i += 1;
      continue;
    }
    while (i < text.length && mask[i]) {
      if (out[i] !== "\n") out[i] = " ";
      i += 1;
    }
  }

  return out.join("");
}

/** Line number (1-based) of a character offset. */
function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Splits a SAS program on statement-terminating semicolons.
 *
 * Unlike SQL, parentheses do not shield a semicolon in SAS -- a `;` always ends
 * the statement -- so no depth is tracked here.
 */
export function splitSasStatements(text) {
  const mask = maskSas(text);
  const statements = [];
  let start = 0;

  const push = (from, to) => {
    const slice = text.slice(from, to);
    if (!slice.trim()) return;
    let codeAt = from;
    for (let i = from; i < to; i += 1) {
      if (!mask[i] && !/\s/.test(text[i])) {
        codeAt = i;
        break;
      }
    }
    statements.push({
      text: slice.trim(),
      start: from,
      end: to,
      startLine: lineAt(text, codeAt),
    });
  };

  for (let i = 0; i < text.length; i += 1) {
    if (mask[i]) continue;
    if (text[i] !== ";") continue;
    push(start, i);
    start = i + 1;
  }
  push(start, text.length);

  return statements;
}

/** Finds the balanced-paren body starting at `open`, ignoring quoted text. */
export function balancedBody(text, open) {
  const mask = maskSas(text);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (mask[i]) continue;
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
  }
  return { body: text.slice(open + 1), end: text.length };
}

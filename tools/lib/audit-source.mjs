/** Source locations and a small JS lexer; neither evaluates nor rewrites input. */
export const pointerKey = key => String(key).replaceAll("~", "~0").replaceAll("/", "~1");
export const atPointer = (base, key) => `${base}/${pointerKey(key)}`;

export function sourceLocation(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return offset => {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = (low + high) >> 1; if (starts[middle] <= offset) low = middle; else high = middle; }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
}

/** Native JSON parsing validates syntax; this index retains locations and duplicate keys. */
export function parseJsonSource(text) {
  if (text.charCodeAt(0) === 0xfeff) text = " " + text.slice(1);
  const data = JSON.parse(text), locations = new Map(), duplicates = [], locate = sourceLocation(text);
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "")) offset++; };
  function string() {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") offset++;
      else if (char === '"') break;
    }
    return JSON.parse(text.slice(start, offset));
  }
  function value(pointer) {
    whitespace();
    const start = offset;
    locations.set(pointer, { offset: start, ...locate(start) });
    if (text[offset] === "{") {
      offset++; whitespace(); const keys = new Set();
      while (text[offset] !== "}") {
        const keyOffset = offset, key = string(), child = atPointer(pointer, key);
        if (keys.has(key)) duplicates.push({ pointer: child, ...locate(keyOffset), key });
        keys.add(key); whitespace(); offset++; value(child); whitespace();
        if (text[offset] !== ",") break;
        offset++; whitespace();
      }
      offset++;
    } else if (text[offset] === "[") {
      offset++; whitespace(); let index = 0;
      while (text[offset] !== "]") {
        value(atPointer(pointer, index++)); whitespace();
        if (text[offset] !== ",") break;
        offset++; whitespace();
      }
      offset++;
    } else if (text[offset] === '"') string();
    else { while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++; }
    locations.get(pointer).end = offset;
  }
  value("");
  return { data, locations, duplicates, locate };
}

function decodeString(raw) {
  return raw.slice(1, -1).replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(.))/gi,
    (_match, point, unicode, hex, char) => point || unicode || hex ? String.fromCodePoint(parseInt(point ?? unicode ?? hex, 16))
      : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }[char] ?? char));
}

/** Skip comments/regex bodies/template text; retain accessors and interpolated code. */
export function codeTokens(text) {
  const tokens = []; let offset = 0;
  const push = (kind, value, start) => tokens.push({ kind, value, offset: start, end: offset });
  function quoted(quote) {
    const start = offset++;
    while (offset < text.length) { const char = text[offset++]; if (char === "\\") offset++; else if (char === quote) break; }
    push("string", decodeString(text.slice(start, offset)), start);
  }
  function template() {
    const start = offset++; let interpolated = false;
    while (offset < text.length) {
      if (text[offset] === "\\") { offset += 2; continue; }
      if (text[offset] === "`") { offset++; break; }
      if (text.slice(offset, offset + 2) === "${") { interpolated = true; offset += 2; scan(true); }
      else offset++;
    }
    if (!interpolated) push("string", decodeString(text.slice(start, offset)), start);
  }
  function scan(interpolation = false) {
    let depth = 0;
    while (offset < text.length) {
      const start = offset, char = text[offset];
      if (/\s/.test(char)) { offset++; continue; }
      if (text.slice(offset, offset + 2) === "//") { while (offset < text.length && text[offset] !== "\n") offset++; continue; }
      if (text.slice(offset, offset + 2) === "/*") { const end = text.indexOf("*/", offset + 2); offset = end < 0 ? text.length : end + 2; continue; }
      if (char === '"' || char === "'") { quoted(char); continue; }
      if (char === "`") { template(); continue; }
      if (char === "}" && interpolation && !depth) { offset++; return; }
      if (char === "{") depth++;
      if (char === "}") depth--;
      // Regex versus division uses expression-start context. This is a lexical
      // dependency audit, not a JavaScript parser or dynamic property evaluator.
      const previous = tokens.at(-1)?.value;
      if (char === "/" && (!previous || /^(?:[=(:,;!{\[?]|=>|return|throw|case|&&|\|\||\?\?)$/.test(previous))) {
        offset++; let bracket = false;
        while (offset < text.length) {
          const current = text[offset++];
          if (current === "\\") offset++;
          else if (current === "[") bracket = true;
          else if (current === "]") bracket = false;
          else if (current === "/" && !bracket) break;
        }
        while (/[a-z]/i.test(text[offset] ?? "")) offset++;
        push("regex", "", start); continue;
      }
      if (/[\p{L}_$]/u.test(char)) {
        offset++; while (/[\p{L}\p{N}_$]/u.test(text[offset] ?? "")) offset++;
        push("identifier", text.slice(start, offset), start); continue;
      }
      const operator = ["===", "!==", "?.", "=>", "==", "!=", "&&", "||", "??"].find(op => text.startsWith(op, offset));
      offset += operator?.length ?? 1; push("punctuation", operator ?? char, start);
    }
  }
  scan(); return tokens;
}

export function member(tokens, index, name) {
  let next = index + 1;
  if ([".", "?."].includes(tokens[next]?.value)) {
    next++;
    if (tokens[next]?.kind === "identifier") return tokens[next].value === name ? tokens[next] : null;
  }
  if (tokens[next]?.value === "[" && tokens[next + 1]?.kind === "string" && tokens[next + 2]?.value === "]") {
    return tokens[next + 1].value === name ? tokens[next + 1] : null;
  }
  return null;
}

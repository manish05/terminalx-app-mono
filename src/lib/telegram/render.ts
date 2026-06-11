/**
 * Output rendering helpers shared between live-screen flushes and
 * Claude transcript messages.
 *
 * Patterns ported from ccbot's `terminal_parser.py` + `telegram_sender.py`.
 */

const TELEGRAM_MAX = 4096;

/**
 * Strip ANSI / VT escape sequences from a string. Covers CSI (`ESC [ ...`),
 * OSC (`ESC ] ... BEL` or `ESC ] ... ST`), and standalone single-char
 * controls. Bytes outside printable / whitespace get dropped too.
 */
export function stripAnsi(input: string): string {
  // CSI: ESC [ <params> <intermediates> <final-byte 0x40-0x7E>
  // OSC: ESC ] <params> (BEL | ESC \)
  // Plus a few short standalone escapes we want to drop.
  return input
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[=>78cDEFHM]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * Escape a string so it's safe inside Telegram MarkdownV2 outside any
 * formatting context. Per the Bot API docs the special chars are:
 *
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * Plus the escape char itself.
 */
export function escapeMarkdownV2(input: string): string {
  return input.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Escape only what's dangerous *inside* a fenced code block. Inside ``` ```
 * blocks Telegram only treats the backtick and backslash as special.
 */
export function escapeMarkdownV2Code(input: string): string {
  return input.replace(/[`\\]/g, (c) => `\\${c}`);
}

/**
 * Wrap a chunk of plain text as a MarkdownV2 fenced code block. Truncates
 * to fit Telegram's 4096-char message limit, keeping the *latest* content
 * (typical use is "tail of terminal output").
 */
export function asCodeBlock(text: string, max = 3500): string {
  const sliced = text.length > max ? text.slice(text.length - max) : text;
  return "```\n" + escapeMarkdownV2Code(sliced) + "\n```";
}

/**
 * Render a tmux `capture-pane -p -e` output as a Telegram-friendly code
 * block. tmux pads each line with trailing spaces to the pane width and
 * leaves a stack of blank rows below the prompt — both look terrible in
 * Telegram's narrow code-block column. We strip ANSI, trim trailing
 * spaces per line, drop blank trailing lines, then wrap.
 */
export function renderScreen(ansi: string, max = 3500): string {
  const plain = stripAnsi(ansi);
  const lines = plain.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const trimmed = lines.join("\n");
  return asCodeBlock(trimmed, max);
}

/**
 * Convert standard markdown (what Claude / Codex emit) into Telegram
 * MarkdownV2 so replies keep their formatting in chat mode instead of
 * showing literal `**` / backticks (escape-everything) or losing the
 * monospace styling (no parse_mode).
 *
 * Handled: fenced code blocks (with language tag), inline code, bold,
 * italic, strikethrough, links, ATX headers (→ bold line), blockquotes,
 * and `-`/`*`/`+` bullets (→ •). Everything else is escaped. Callers must
 * still keep a plain-text fallback — Telegram rejects the whole message
 * on any entity-parse error.
 */
export function markdownToTelegramV2(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i]!.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim().startsWith(close)) {
        body.push(lines[j]!);
        j++;
      }
      out.push("```" + (fence[2] ?? "") + "\n" + escapeMarkdownV2Code(body.join("\n")) + "\n```");
      i = j + 1; // also skips an unclosed fence's implicit end
      continue;
    }
    out.push(lineToTelegramV2(lines[i]!));
    i++;
  }
  return out.join("\n");
}

function lineToTelegramV2(line: string): string {
  const header = line.match(/^\s*#{1,6}\s+(.*)$/);
  if (header) return "*" + inlineToTelegramV2(header[1]!) + "*";
  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) return ">" + inlineToTelegramV2(quote[1]!);
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return bullet[1]! + "• " + inlineToTelegramV2(bullet[2]!);
  return inlineToTelegramV2(line);
}

/**
 * Inline tokens, longest/most-specific first. Italic deliberately requires
 * non-word boundaries so snake_case identifiers outside backticks survive.
 */
const INLINE_TOKEN =
  /(`+)([^`]+)\1|\[([^\]]+)\]\(([^()\s]+)\)|\*\*([^*]+(?:\*[^*]+)*?)\*\*|~~([^~]+)~~|(?<![\w\\*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)|(?<![\w\\])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g;

function inlineToTelegramV2(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN)) {
    out += escapeMarkdownV2(text.slice(last, m.index));
    if (m[2] !== undefined) {
      out += "`" + escapeMarkdownV2Code(m[2]) + "`";
    } else if (m[3] !== undefined && m[4] !== undefined) {
      out += "[" + escapeMarkdownV2(m[3]) + "](" + m[4].replace(/[)\\]/g, (c) => `\\${c}`) + ")";
    } else if (m[5] !== undefined) {
      out += "*" + inlineToTelegramV2(m[5]) + "*";
    } else if (m[6] !== undefined) {
      out += "~" + inlineToTelegramV2(m[6]) + "~";
    } else if (m[7] !== undefined) {
      out += "_" + inlineToTelegramV2(m[7]) + "_";
    } else if (m[8] !== undefined) {
      out += "_" + inlineToTelegramV2(m[8]) + "_";
    }
    last = m.index + m[0].length;
  }
  out += escapeMarkdownV2(text.slice(last));
  return out;
}

/**
 * Split a MarkdownV2-formatted message into ≤4096-char chunks, preferring
 * newline boundaries and re-opening / closing code fences across splits so
 * each chunk is independently valid.
 */
export function splitForTelegram(text: string, max = TELEGRAM_MAX): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    const candidate = buf ? buf + "\n" + line : line;
    if (candidate.length + (inFence ? 4 : 0) > max) {
      // Flush buffer; close fence if we're mid-fence so the chunk stays
      // valid, then re-open in the next chunk.
      if (inFence && !buf.endsWith("```")) {
        out.push(buf + "\n```");
        buf = "```\n" + line;
      } else {
        out.push(buf);
        buf = line;
      }
      // Pathologically long single line: hard split.
      while (buf.length > max) {
        out.push(buf.slice(0, max));
        buf = buf.slice(max);
      }
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

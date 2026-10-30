import { createHash } from "node:crypto";

import { buildT3WorkSummary } from "./t3Work.mjs";

const FOLLOW_UP_MARKER = /<!--\s*AC_FOLLOWUPS\s*:\s*(\[[\s\S]*?\])\s*-->/giu;

export const DEVICE_RESPONSE_LINE_LENGTH = 31;
export const DEVICE_RESPONSE_LINES_PER_PAGE = 3;
export const DEVICE_RESPONSE_MAX_PAGES = 12;
export const DEVICE_FOLLOW_UP_LIMIT = 2;

/**
 * Bytes of newly generated text one poll may carry.
 *
 * A controller watching a running agent used to re-receive the whole response on every poll, so a
 * reply near the 1,116-character display ceiling was sent again each second while only a few
 * characters had changed. The cursor below lets the device ask for just the tail. The bound is
 * deliberately larger than one screen: catching up after a few missed polls must not need several
 * round trips, but a single poll must not carry an unbounded payload to a device with 8 MB of
 * PSRAM and a shared TLS session.
 */
export const DEVICE_RESPONSE_STREAM_CHUNK = 512;

/**
 * Exact length, in ASCII characters, of `response.stream.fingerprint` and of the
 * `streamFingerprint` query parameter. It is fixed, not a maximum: lowercase hex of the first 8
 * bytes of a SHA-256 (64 bits). A controller needs a 17-byte buffer including the terminator.
 *
 * The digest guards against an ACCIDENTAL rewrite of text the device already holds, not an
 * attacker, so what matters is collision resistance across the few thousand distinct prefixes one
 * reply can pass through. 2^-64 per comparison is far beyond that, and it keeps the value small
 * enough to journal next to the offset on a device with no spare RAM.
 */
export const DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH = 16;

const FINGERPRINT_SHAPE = new RegExp(`^[0-9a-f]{${DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH}}$`, "u");

/**
 * Opaque digest of the exact exposed text a device holds.
 *
 * Hashed as UTF-16LE because every offset in this protocol counts UTF-16 code units: that encoding
 * is injective for ANY string, including a lone surrogate, where UTF-8 would fold it into U+FFFD
 * and let two different prefixes collide. The length is mixed in so no prefix can be confused with
 * a longer text that merely begins the same way. The device never computes this; it echoes it.
 */
export function fingerprintStreamText(text) {
  const value = String(text ?? "");
  return createHash("sha256")
    .update(`${value.length}\0`, "utf8")
    .update(value, "utf16le")
    .digest("hex")
    .slice(0, DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH);
}

/**
 * Adds a hidden, bounded instruction to turns started by a physical controller.
 * The model may only name opaque ids; the gateway validates those ids against
 * the device's current layout before returning anything executable.
 */
export function buildDeviceFollowUpInstruction(controls, currentActionId = null) {
  const actions = eligibleFollowUpActions(controls, currentActionId);
  if (!actions.length) return null;
  const catalogue = actions.map(({ actionId, label }) => ({ id: actionId, label }));
  return [
    "<!--AC_DEVICE_FOLLOWUP_REQUEST",
    "At the end of your response, optionally recommend up to two relevant next actions from this exact JSON catalogue:",
    JSON.stringify(catalogue),
    'Append one machine-readable marker exactly like <!--AC_FOLLOWUPS:["action_id"]-->.',
    "Use only ids from the catalogue, never invent an id, and omit the marker when no listed action is useful.",
    "-->\n",
  ].join("\n");
}

export function appendDeviceFollowUpInstruction(text, instruction) {
  const prompt = String(text ?? "").trim();
  const hidden = typeof instruction === "string" ? instruction.trim() : "";
  return hidden ? `${prompt}\n\n${hidden}` : prompt;
}

export function buildDeviceThreadOutput({
  thread,
  controls = [],
  page = 0,
  after = null,
  streamCursor = null,
} = {}) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message?.role === "assistant")
    .filter(({ message }) => isAtOrAfter(message?.createdAt, after))
    .sort(compareMessages);
  const selected = candidates.at(-1)?.message ?? null;
  const projectedWork = buildT3WorkSummary(thread?.activities);
  const explicitLiveness = ["working", "monitoring"].includes(thread?.backgroundLiveness)
    ? thread.backgroundLiveness
    : null;
  const work = {
    ...projectedWork,
    backgroundLiveness: explicitLiveness ?? projectedWork.backgroundLiveness,
  };
  const active = deviceThreadIsActive(thread) || work.active > 0 || Boolean(work.backgroundLiveness);

  if (!selected) {
    return {
      thread: compactThread(thread),
      work,
      response: {
        messageId: null,
        state: active || after ? "waiting" : "empty",
        page: 0,
        pageCount: 1,
        lines: active || after
          ? work.total > 0
            ? [
                `${work.active} active ${work.active === 1 ? "task" : "tasks"}`,
                `${work.completed} done · ${work.failed} failed`,
                "EXIT returns to actions",
              ]
            : ["Waiting for agent response", "The display will refresh", "EXIT returns to actions"]
          : ["No agent response yet", "Run a thread action first", "EXIT returns to actions"],
        truncated: false,
        updatedAt: null,
        // Nothing to append and no message to anchor to; a device holding a cursor must reset.
        stream: {
          messageId: null,
          offset: 0,
          total: 0,
          appended: "",
          complete: false,
          reset: Boolean(streamCursor?.offset) || Boolean(streamCursor?.fingerprint),
          fingerprint: fingerprintStreamText(""),
        },
      },
      suggestions: [],
    };
  }

  const rawText = String(selected.text ?? "");
  const markerIds = extractFollowUpIds(rawText);
  const visibleText = normalizeResponseText(stripFollowUpMarkers(rawText));
  const allLines = wrapResponseText(visibleText || (selected.streaming ? "Agent is responding" : "Response contained no displayable text"));
  const maximumLines = DEVICE_RESPONSE_LINES_PER_PAGE * DEVICE_RESPONSE_MAX_PAGES;
  const truncated = allLines.length > maximumLines;
  const boundedLines = allLines.slice(0, maximumLines);
  const pageCount = Math.max(1, Math.ceil(boundedLines.length / DEVICE_RESPONSE_LINES_PER_PAGE));
  const safePage = clampInteger(page, 0, pageCount - 1);
  const start = safePage * DEVICE_RESPONSE_LINES_PER_PAGE;
  const lines = boundedLines.slice(start, start + DEVICE_RESPONSE_LINES_PER_PAGE);

  return {
    thread: compactThread(thread),
    work,
    response: {
      messageId: stringOrNull(selected.id ?? selected.messageId),
      state: selected.streaming ? "streaming" : "complete",
      page: safePage,
      pageCount,
      lines,
      truncated,
      updatedAt: stringOrNull(selected.createdAt),
      stream: buildResponseStream({
        messageId: stringOrNull(selected.id ?? selected.messageId),
        rawText: stripFollowUpMarkers(rawText),
        streaming: selected.streaming === true,
        cursor: streamCursor,
      }),
    },
    suggestions: validateFollowUpIds(markerIds, controls),
  };
}

/**
 * The incremental half of the response contract.
 *
 * `lines`/`page` above stay exactly as they were, so a controller that knows nothing about this
 * keeps working; this block is additive. A device sends the message id it is displaying and how
 * many characters of it it already holds, and gets back only what came after.
 *
 * `reset` is the load-bearing field. A cursor can be stale in two ways that look identical from
 * the device's side — the agent started a different message, or the text it held was replaced
 * rather than extended (T3 sends absolute text for a native v2 message update, and only its
 * streaming suffix becomes a delta). Either way the device must replace what is on screen instead
 * of appending to it, exactly as the console's live transcript does on a replay gap.
 */
function buildResponseStream({ messageId, rawText, streaming, cursor }) {
  // Not the same text the paged `lines` use.
  //
  // `normalizeResponseText` rewrites paired markdown — `[docs](url)` becomes `docs`, a code span
  // loses its backticks, a tag is dropped — so normalizing a PARTIAL stream is not prefix-stable.
  // Streaming `Check [do` and then `Check [docs](http://x) now` made the device display
  // `Check [dos now`, because the second poll's offset counted characters of a prefix that had
  // been rewritten, and `reset` only noticed length going backwards. Withholding the tail that
  // normalization could still rewrite makes the exposed text grow-only in the common case, which
  // keeps resets rare. It is an OPTIMISATION, not the guarantee: it cannot be made complete (a
  // rule can depend on a closer the cut hides), so correctness is the fingerprint check below.
  // The paged `lines` keep using the complete text: a page is replaced wholesale, so it never had
  // this problem.
  // Withholding only ever protects text that could STILL be rewritten. Once the turn has settled
  // the text is final, so the whole of it is exposed — otherwise a reply ending in an unclosed
  // construct lost its tail permanently while `complete` claimed the device had everything. That
  // is not a contrived case: a `<` in ordinary prose ("if x < 5") is an unmatched opener, so the
  // withheld tail could be most of the reply. Releasing it at settle is prefix-safe because the
  // withheld region is only ever appended to what was already exposed, never a rewrite of it, and
  // the property test asserts exactly that for the settled exposure as well as mid-stream.
  const full = streaming ? stableVisibleText(rawText) : normalizeResponseText(rawText);
  const total = full.length;
  const sameMessage = Boolean(messageId) && cursor?.messageId === messageId;
  const held = sameMessage && Number.isSafeInteger(cursor?.offset) && cursor.offset >= 0 ? cursor.offset : 0;
  // A cursor past the end means the text shrank, which is a replacement rather than an extension.
  let reset = !sameMessage ? Boolean(cursor?.messageId) : held > total;
  // The fingerprint is the correctness mechanism; everything above and the withholding in
  // `stableRawLength` are optimisations that keep it from firing. Length alone cannot see a
  // prefix that was rewritten in place, and no rule about which constructs are unstable can be
  // complete (a decision may depend on a closer the cut hides). Comparing what the device says it
  // holds with what this poll would have sent for the same range is exact whatever caused the
  // difference. A device that sends none is an older controller and keeps the length test only.
  // A fingerprint that is malformed, or that cannot match, is a mismatch: when in doubt the
  // device re-reads from zero rather than being trusted.
  if (!reset && sameMessage && cursor?.fingerprint !== undefined && cursor?.fingerprint !== null) {
    const supplied = cursor.fingerprint;
    const holdsNothing = held === 0 && supplied === "";
    const shaped = typeof supplied === "string" && FINGERPRINT_SHAPE.test(supplied);
    if (!holdsNothing && !(shaped && supplied === fingerprintStreamText(full.slice(0, held)))) reset = true;
  }
  const offset = reset ? 0 : held;
  const end = chunkEnd(full, offset);
  const appended = full.slice(offset, end);
  return {
    messageId,
    offset,
    total,
    appended,
    // True only when the device now holds every character AND the turn has settled, so firmware
    // can stop polling on one field rather than correlating two.
    complete: !streaming && end >= total,
    reset,
    // Of what the device holds once it applies this response, so the next poll can prove it.
    fingerprint: fingerprintStreamText(full.slice(0, end)),
  };
}

/**
 * Where this poll's chunk ends. A bound that lands between the halves of a surrogate pair would
 * hand the device half a character, which it cannot store faithfully, so the pair waits for the
 * next poll. The fingerprint is over the exact text the device holds, so a half pair would also
 * make every following poll look like a rewrite.
 */
function chunkEnd(full, offset) {
  let end = Math.min(full.length, offset + DEVICE_RESPONSE_STREAM_CHUNK);
  if (end < full.length && end > offset) {
    const last = full.charCodeAt(end - 1);
    const next = full.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return end;
}

export function extractFollowUpIds(text) {
  const matches = [...String(text ?? "").matchAll(FOLLOW_UP_MARKER)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(matches[index][1]);
      if (!Array.isArray(parsed)) continue;
      return parsed.filter((value) => typeof value === "string");
    } catch {
      // Ignore malformed model output. It never becomes an executable action.
    }
  }
  return [];
}

export function stripFollowUpMarkers(text) {
  return String(text ?? "").replace(FOLLOW_UP_MARKER, "").trim();
}

export function wrapResponseText(text, lineLength = DEVICE_RESPONSE_LINE_LENGTH) {
  const width = clampInteger(lineLength, 8, DEVICE_RESPONSE_LINE_LENGTH);
  const normalized = normalizeResponseText(text);
  if (!normalized) return [];
  const output = [];
  for (const paragraph of normalized.split("\n")) {
    if (!paragraph) continue;
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const chunks = splitToken(word, width);
      for (const chunk of chunks) {
        if (!line) {
          line = chunk;
        } else if (line.length + 1 + chunk.length <= width) {
          line += ` ${chunk}`;
        } else {
          output.push(line);
          line = chunk;
        }
      }
    }
    if (line) output.push(line);
  }
  return output;
}

function eligibleFollowUpActions(controls, currentActionId) {
  const seen = new Set();
  return (Array.isArray(controls) ? controls : [])
    .filter((control) => control?.enabled !== false && typeof control?.actionId === "string")
    .filter((control) => control.actionId && control.actionId !== currentActionId)
    .filter((control) => !["status", "stop", "reset"].includes(control.kind))
    .filter((control) => {
      if (seen.has(control.actionId)) return false;
      seen.add(control.actionId);
      return true;
    })
    .slice(0, 8)
    .map((control) => ({
      actionId: control.actionId,
      label: String(control.label ?? "Action").slice(0, 80),
      kind: control.kind ?? "remote_action",
      requiresConfirmation: control.requiresConfirmation !== false,
    }));
}

function validateFollowUpIds(ids, controls) {
  const allowed = new Map(eligibleFollowUpActions(controls, null).map((action) => [action.actionId, action]));
  const output = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    output.push(allowed.get(id));
    if (output.length === DEVICE_FOLLOW_UP_LIMIT) break;
  }
  return output;
}

/**
 * The normalized text whose prefix is settled, for incremental reads.
 *
 * Everything `normalizeResponseText` rewrites is delimiter-paired, so the rewrite only happens
 * once the closing delimiter arrives. Until then those characters may still change meaning, and a
 * device that already appended them would be showing something the agent did not write. So the
 * text is cut before the earliest still-open construct and normalized from what remains.
 *
 * The cost is that the last few characters of a reply appear one poll later, once their markup
 * resolves. That is invisible next to displaying corrupted text. This only reduces how often a
 * reset is needed; anything it misses is caught by the prefix fingerprint, which is what makes the
 * stream correct. The fuzz test in deviceThreadOutputStream.test.mjs is the proof of that.
 */
export function stableVisibleText(text) {
  const raw = String(text ?? "");
  return normalizeResponseText(raw.slice(0, stableRawLength(raw)));
}

function stableRawLength(raw) {
  let cut = raw.length;
  const limit = (index) => { if (index >= 0 && index < cut) cut = index; };

  // A line-start list or quote marker is only stripped once its space arrives: the normalizer
  // matches `[-*+] ` and `> `, so a bare `-` is kept and `- ` is removed. Withhold a final line
  // that is still just a candidate marker. `#{1,6}` needs no trailing space, so it is stable.
  const lineStart = raw.lastIndexOf("\n") + 1;
  if (/^\s{0,3}[-*+>]$/u.test(raw.slice(lineStart))) limit(lineStart);

  // A trailing `!` may be the first character of an image, whose `!` the normalizer consumes, so
  // exposing it now means removing it later. Same reasoning as the `[` rule below, one character
  // earlier; `[`, a backtick and `<` are caught by their own unmatched-opener rules.
  if (raw.endsWith("!")) limit(raw.length - 1);

  // An unclosed `<` could still become a tag, which is dropped entirely. Only one that can still
  // look like a tag or comment start is worth withholding: "x < 5" never becomes one, and holding
  // it back would only delay the rest of an ordinary sentence.
  const openTag = raw.lastIndexOf("<");
  if (openTag >= 0 && raw.indexOf(">", openTag) < 0 && /^(?:\/?(?:[A-Za-z]|$)|!(?:-(?:-|$)|$))/u.test(raw.slice(openTag + 1))) {
    limit(openTag);
  }

  // A `[` is withheld until it is provably not a link. `[text]` alone is left verbatim by the
  // normalizer, but one more character can turn it into `[text](url)` and erase the brackets, so
  // "no closing paren yet" is the only safe test.
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    if (raw[index] !== "[") continue;
    const close = raw.indexOf("]", index);
    if (close < 0 || raw[close + 1] !== "(" || raw.indexOf(")", close) < 0) {
      // An image is `![alt](url)` and the normalizer consumes the `!` along with the brackets, so
      // withholding only from the `[` would expose a bare `!` that later disappears. The property
      // test caught exactly this.
      limit(raw[index - 1] === "!" ? index - 1 : index);
    }
    break;
  }

  // Backticks need two separate rules, because a run's LENGTH is itself still in flight.
  const runs = [...raw.matchAll(/`+/gu)];
  const last = runs[runs.length - 1];
  // The two rules compose; they are not alternatives. Cutting the trailing run can leave an
  // unclosed opener exposed, which was the second thing the property test caught.
  let considered = runs;
  if (last && last.index + last[0].length === raw.length) {
    // The text ends inside a run: `` may still become ```, which turns an inline span into a
    // fence marker and changes what gets stripped. Withhold the run itself. Content emitted
    // before it stays valid, so a streaming code block is not hidden wholesale.
    limit(last.index);
    considered = runs.slice(0, -1);
  }
  // An unclosed inline span (one or two backticks) is left verbatim by the normalizer now and
  // erased once it closes, so it must be withheld. A fence marker of three or more does not have
  // that problem: its content is stripped of the marker either way.
  const inline = considered.filter((run) => run[0].length <= 2);
  if (inline.length % 2 === 1) limit(inline[inline.length - 1].index);

  return cut;
}

export function normalizeResponseText(text) {
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/```[^\n]*\n?/gu, "")
    .replace(/`([^`]+)`/gu, "$1")
    // Tag-LIKE only: a name must follow the `<`. The earlier `<[^>]+>` matched any `<` to the next
    // `>`, so "if x < 5 and y > 3 then" lost "< 5 and y >" from ordinary prose. A complete HTML
    // comment is still dropped, as it was.
    .replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/gu, "")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+] |> )\s?/gmu, "")
    .replace(/[\t\r]+/gu, " ")
    .replace(/ {2,}/gu, " ")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

function splitToken(token, width) {
  if (token.length <= width) return [token];
  const chunks = [];
  for (let offset = 0; offset < token.length; offset += width) chunks.push(token.slice(offset, offset + width));
  return chunks;
}

function compareMessages(left, right) {
  const leftAt = Date.parse(left.message?.createdAt ?? "");
  const rightAt = Date.parse(right.message?.createdAt ?? "");
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
  if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return 1;
  if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return -1;
  return left.index - right.index;
}

function isAtOrAfter(createdAt, after) {
  if (!after) return true;
  const boundary = Date.parse(after);
  if (!Number.isFinite(boundary)) return true;
  const created = Date.parse(createdAt ?? "");
  return Number.isFinite(created) && created >= boundary;
}

function deviceThreadIsActive(thread) {
  return [thread?.session?.status, thread?.latestTurn?.state, thread?.status]
    .some((state) => ["starting", "running", "streaming", "working"].includes(String(state ?? "").toLowerCase()));
}

function compactThread(thread) {
  return {
    id: stringOrNull(thread?.id),
    title: String(thread?.title ?? thread?.name ?? thread?.label ?? "Untitled thread"),
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function clampInteger(value, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? minimum), 10);
  return Math.max(minimum, Math.min(Number.isFinite(parsed) ? parsed : minimum, maximum));
}

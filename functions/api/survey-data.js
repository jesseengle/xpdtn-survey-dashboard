// functions/api/survey-data.js — respondent-based % for multi-select, "Other" last

export async function onRequest(context) {
  const diag = {
    runtime: "Cloudflare Pages Functions",
    now: new Date().toISOString(),
    env_present: {
      SHEET_ID: Boolean(context.env?.SHEET_ID),
      GOOGLE_API_KEY: Boolean(context.env?.GOOGLE_API_KEY),
      SHEET_NAME: Boolean(context.env?.SHEET_NAME),
    },
    steps: [],
  };

  try {
    const SHEET_ID   = context.env.SHEET_ID;
    const API_KEY    = context.env.GOOGLE_API_KEY;
    const SHEET_NAME = context.env.SHEET_NAME || "Sheet1";

    const ok = (obj) =>
      new Response(JSON.stringify(obj, null, 2), {
        headers: { "content-type": "application/json" },
      });

    // === ENV ===
    diag.steps.push("check-env");
    if (!SHEET_ID) {
      diag.error = "Missing SHEET_ID env var.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Env missing", diagnostics: diag, ...(fb || {}) });
    }
    if (!API_KEY) {
      diag.warning = "Missing GOOGLE_API_KEY env var; will try CSV fallback.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "No API key; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    // === SHEETS API ===
    diag.steps.push("fetch-sheets-api");
    const range = encodeURIComponent(`${SHEET_NAME}!A1:V2000`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;

    let apiJson;
    try {
      const r = await fetch(url);
      diag.sheets_api_status = `${r.status} ${r.statusText}`;
      if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
      apiJson = await r.json();
    } catch (e) {
      diag.sheets_api_error = String(e?.message || e);
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Sheets API failed; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    // === PARSE ===
    diag.steps.push("parse-api-values");
    const values = Array.isArray(apiJson?.values) ? apiJson.values : [];
    diag.row_count = values.length;

    const headerIndex = values.findIndex((row) =>
      (row || []).some((cell) => String(cell || "").trim().length)
    );
    if (headerIndex === -1) {
      diag.parse_error = "No non-empty rows found.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "No non-empty rows; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    const headers = values[headerIndex].map((v) => String(v || "").trim());
    const rows = values.slice(headerIndex + 1);
    diag.detected_header_row = headerIndex + 1;
    diag.detected_headers_preview = headers.slice(0, 12);

    const questions = buildQuestions(headers, rows);

    return ok({
      success: true,
      message: "Tallied (API path, display-aware)",
      questions,
      diagnostics: diag,
    });
  } catch (err) {
    return new Response(
      JSON.stringify(
        { success: false, message: "Unhandled error", error: String(err?.message || err) },
        null,
        2
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
}

/* =========================
   CSV FALLBACK
   ========================= */
async function tryCsvFallback(diag, { SHEET_ID, SHEET_GID = "0" }) {
  try {
    diag.steps.push("csv-fallback");
    if (!SHEET_ID) throw new Error("No SHEET_ID for CSV fallback.");
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${encodeURIComponent(
      SHEET_GID
    )}`;
    const r = await fetch(url);
    diag.csv_status = `${r.status} ${r.statusText}`;
    if (!r.ok) throw new Error(`CSV fallback error: ${r.status} ${r.statusText}`);
    const csv = await r.text();
    const { headers, rows } = parseCsv(csv);
    diag.csv_headers_preview = headers.slice(0, 12);
    const questions = buildQuestions(headers, rows);
    return { csv_fallback: true, questions };
  } catch (e) {
    diag.csv_error = String(e?.message || e);
    return { csv_fallback: true, questions: [] };
  }
}

/* =========================
   Question building
   ========================= */
function buildQuestions(headers, rows) {
  const idx = indexByHeader(headers, {
    aiUsage: "Which of the following best describes",
    goToTool: "What’s your go-to AI tool",
    confidence: "How confident are you",
    curiosity: "Which areas of AI are you most curious",
    topPriority: "What’s your top priority for this season",
    creatorAreas: "Which areas of creator marketing",
  });

  const CANONICAL = {
    aiUsage: [
      "Discovering or researching creators",
      "Drafting or reviewing creative briefs",
      "Writing emails, captions, or campaign copy",
      "Analyzing campaign results",
      "Generating images or video",
      "I'm not using AI at work yet",
    ],
    aiCuriosity: [
      "AI for creator discovery",
      "AI for campaign planning & briefing",
      "AI for reviewing creator content",
      "AI-generated content (video, images, voice)",
      "AI assistants & internal tooling",
      "Ethical implications / disclosure guidelines",
      "AI and brand safety",
      "How creators themselves are using AI",
      "AI and the future of creator platforms",
    ],
    creatorAreas: [
      "Creator Discovery & Vetting",
      "Brief Generation & Campaign Planning",
      "Outreach & Communication",
      "Content Review & Brand Safety",
      "Payment, Contracting & Legal Automation",
      "Performance Analysis & Reporting",
      "Competitor Monitoring & Trend Tracking",
      "Creative Co-Pilots for UGC",
      "Marketplace Optimization (e.g. TikTok Shop, Amazon Influencer)",
      "Internal Knowledge Systems & Institutional Memory",
    ],
    topPriority: [
      "Learning from guest speakers",
      "Swapping tactics/tools with peers",
      "Discovering new AI use cases",
      "Connecting 1:1 with others in similar roles",
      "Having a regular space to reflect and stay sharp",
    ],
  };

  const questions = [];
  const get = (row, i) => String((row?.[i] ?? "")).trim();
  const respondentCount = rows.length;

  // ==== Q1: AI Usage (multi) ====
  if (idx.aiUsage > -1) {
    const { counts, others, otherRespondentCount } =
      tallyByInclusion(rows, idx.aiUsage, CANONICAL.aiUsage);
    pushMultiQuestion({
      out: questions,
      title:
        "Which of the following best describes how you're using AI in your work today? (select all that apply)",
      counts,
      others,
      respondentCount,
      otherCount: otherRespondentCount,
      includeZeroBars: true,
    });
  }

  // ==== Q2: Go-to Tool (single; normalize; ≥10% kept) ====
  if (idx.goToTool > -1) {
    const map = Object.create(null);
    rows.forEach((r) => {
      const raw = get(r, idx.goToTool);
      const items = splitOnCommaRespectingEmpty(raw);
      (items.length ? items : [raw]).forEach((x) => {
        const n = normalizeTool(x);
        if (n) map[n] = (map[n] || 0) + 1;
      });
    });

    const total = respondentCount;
    const arr = Object.entries(map)
      .map(([text, count]) => ({
        text,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const keep = arr.filter((r) => r.percentage >= 10);
    const drop = arr.filter((r) => r.percentage < 10);
    if (drop.length) {
      const oc = drop.reduce((s, r) => s + r.count, 0);
      keep.push({
        text: "Other",
        count: oc,
        percentage: total > 0 ? Math.round((oc / total) * 100) : 0,
      });
    }

    questions.push({
      question: "What’s your go-to AI tool (if any) in your current workflow?",
      type: "single_choice",
      responses: moveOtherLast(keep),
      total_responses: total,
      ...(drop.length ? { other_responses: Array.from(new Set(drop.map((d) => d.text))).join(", ") } : {}),
    });
  }

  // ==== Q3: Confidence (scale 1–5) ====
  if (idx.confidence > -1) {
    const map = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    rows.forEach((r) => {
      const n = Number(get(r, idx.confidence));
      if (n >= 1 && n <= 5) map[String(n)] += 1;
    });
    const total = Object.values(map).reduce((s, n) => s + n, 0);
    const responses = ["1", "2", "3", "4", "5"].map((k) => ({
      text: k,
      count: map[k],
      percentage: total > 0 ? Math.round((map[k] / total) * 100) : 0,
    }));
    questions.push({
      question: "How confident are you in using AI tools in your creator marketing work? (1–5)",
      type: "scale",
      responses,
      total_responses: total,
    });
  }

  // ==== Q4: AI Curiosity (multi) ====
  if (idx.curiosity > -1) {
    const { counts, others, otherRespondentCount } =
      tallyByInclusion(rows, idx.curiosity, CANONICAL.aiCuriosity);
    pushMultiQuestion({
      out: questions,
      title:
        "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
      counts,
      others,
      respondentCount,
      otherCount: otherRespondentCount,
      includeZeroBars: true,
    });
  }

  // ==== Q5: Top priority (single) ====
  if (idx.topPriority > -1) {
    const map = Object.create(null);
    rows.forEach((r) => {
      const v = get(r, idx.topPriority);
      if (v) map[v] = (map[v] || 0) + 1;
    });
    const total = Object.values(map).reduce((s, n) => s + n, 0);
    const responses = Object.entries(map)
      .map(([text, count]) => ({
        text,
        count,
        percentage: respondentCount > 0 ? Math.round((count / respondentCount) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);
    questions.push({
      question: "What’s your top priority for this season? (pick 1)",
      type: "single_choice",
      responses,
      total_responses: respondentCount,
    });
  }

  // ==== Q6: Creator Marketing Areas (multi) ====
  if (idx.creatorAreas > -1) {
    const { counts, others, otherRespondentCount } =
      tallyByInclusion(rows, idx.creatorAreas, CANONICAL.creatorAreas);
    pushMultiQuestion({
      out: questions,
      title:
        "Which areas of creator marketing would you be most interested in testing AI tools for?",
      counts,
      others,
      respondentCount,
      otherCount: otherRespondentCount,
      includeZeroBars: true,
    });
  }

  return questions;
}

/* =========================
   Multi-select tally (canonical inclusion)
   Returns:
   - counts: per-canonical option (respondent-based)
   - others: verbatim fragments
   - otherRespondentCount: number of respondents who wrote any non-canonical text
   ========================= */
function tallyByInclusion(rows, colIndex, canonicalList) {
  const counts = Object.create(null);
  canonicalList.forEach((opt) => (counts[opt] = 0));
  const others = [];
  const otherRows = new Set();

  rows.forEach((r, rowIdx) => {
    const raw = String(r?.[colIndex] ?? "").trim();
    if (!raw) return;

    let remaining = raw;

    canonicalList.forEach((opt) => {
      if (raw.toLowerCase().includes(opt.toLowerCase())) {
        counts[opt] += 1;
        // remove opt from remaining
        const re = new RegExp(opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
        remaining = remaining.replace(re, "");
      }
    });

    // anything left → "Other" verbatims
    const frags = splitOnCommaRespectingEmpty(remaining)
      .map((s) => s.trim())
      .filter((s) => s && s.length > 1 && !/^\(empty\)|^na$/i.test(s));

    if (frags.length) {
      otherRows.add(rowIdx);
      frags.forEach((f) => others.push(f));
    }
  });

  return { counts, others, otherRespondentCount: otherRows.size };
}

/* =========================
   Push multi-select question (respondent-based %)
   ========================= */
function pushMultiQuestion({
  out,
  title,
  counts,
  others,
  respondentCount,
  otherCount = 0,
  includeZeroBars = false,
}) {
  const baseRows = Object.entries(counts).map(([text, count]) => ({
    text,
    count: Number(count || 0),
  }));

  const rowsForMath = [...baseRows];
  if (otherCount > 0) rowsForMath.push({ text: "Other", count: otherCount });

  // % of respondents (NOT total selections)
  let rows = rowsForMath.map((r) => ({
    text: r.text,
    count: r.count,
    percentage: respondentCount > 0 ? Math.round((r.count / respondentCount) * 100) : 0,
  }));

  rows = moveOtherLast(rows.sort((a, b) => b.count - a.count));
  if (!includeZeroBars) rows = rows.filter((r) => r.count > 0);

  out.push({
    question: title,
    type: "multiple_choice",
    responses: rows,
    total_responses: respondentCount,
    ...(others.length ? { other_responses: others.join(", ") } : {}),
  });
}

/* =========================
   Utilities
   ========================= */
function moveOtherLast(arr) {
  const main = [];
  const others = [];
  arr.forEach((r) => (r.text.toLowerCase() === "other" ? others.push(r) : main.push(r)));
  return [...main, ...others];
}

function indexByHeader(headers, needles) {
  const find = (needle) =>
    headers.findIndex((h) => h.toLowerCase().includes(needle.toLowerCase()));
  return Object.fromEntries(Object.entries(needles).map(([k, n]) => [k, find(n)]));
}

function parseCsv(text) {
  const lines = text.split("\n").filter((l) => l.trim().length);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.replace(/"/g, "").trim());
  const rows = lines.slice(1).map(splitCsvLine);
  return { headers, rows };
}
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// simple comma split
function splitOnCommaRespectingEmpty(s) {
  const str = String(s || "").trim();
  if (!str) return [];
  return str.split(",").map((x) => x.trim()).filter(Boolean);
}

function normalizeTool(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  const tl = t.toLowerCase();
  if (tl === "gpt" || tl.includes("chat gpt") || tl.includes("chatgpt") || tl.includes("openai"))
    return "ChatGPT";
  if (tl.includes("claude")) return "Claude";
  if (tl.includes("gemini") || tl.includes("bard")) return "Gemini";
  if (tl.includes("gamma")) return "Gamma";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

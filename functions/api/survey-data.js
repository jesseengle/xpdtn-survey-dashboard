// functions/api/survey-data.js — DISPLAY-AWARE, ORDERED, ROBUST "OTHER" HANDLING

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

    // --- Step 1: env check ---
    diag.steps.push("check-env");
    if (!SHEET_ID) {
      diag.error = "Missing SHEET_ID env var.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({
        success: false,
        message: "Env missing",
        diagnostics: diag,
        ...(fb || {}),
      });
    }
    if (!API_KEY) {
      diag.warning =
        "Missing GOOGLE_API_KEY env var; will skip API and try CSV fallback.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({
        success: false,
        message: "No API key; CSV fallback attempted",
        diagnostics: diag,
        ...(fb || {}),
      });
    }

    // --- Step 2: fetch values ---
    diag.steps.push("fetch-sheets-api");
    const range = encodeURIComponent(`${SHEET_NAME}!A1:Z2000`);
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
      return ok({
        success: false,
        message: "Sheets API failed; CSV fallback attempted",
        diagnostics: diag,
        ...(fb || {}),
      });
    }

    // --- Step 3: parse header/rows ---
    diag.steps.push("parse-api-values");
    const values = Array.isArray(apiJson?.values) ? apiJson.values : [];
    diag.row_count = values.length;

    const headerIndex = values.findIndex((row) =>
      (row || []).some((cell) => String(cell || "").trim().length)
    );
    if (headerIndex === -1) {
      diag.parse_error = "No non-empty rows found.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({
        success: false,
        message: "No non-empty rows; CSV fallback attempted",
        diagnostics: diag,
        ...(fb || {}),
      });
    }

    const headers = values[headerIndex].map((v) => String(v || "").trim());
    const rows = values.slice(headerIndex + 1);
    diag.detected_header_row = headerIndex + 1;
    diag.detected_headers_preview = headers.slice(0, 12);

    // --- Step 4: build display-aware questions ---
    const questions = buildQuestions(headers, rows);

    return ok({
      success: true,
      message: "Tallied (API path, display-aware)",
      questions,
      diagnostics: diag,
    });
  } catch (err) {
    diag.unhandled = String(err?.message || err);
    return new Response(
      JSON.stringify(
        {
          success: false,
          message: "Unhandled error",
          diagnostics: diag,
          stack: err?.stack,
        },
        null,
        2
      ),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
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
   DISPLAY / AGGREGATION
   ========================= */

// Canonical choices in the order you want them shown (we'll sort by count desc later,
// but keep this as a stable base and always force "Other" last).
const CANONICAL = {
  aiUsage: [
    "Drafting or reviewing creative briefs",
    "Writing emails, captions, or campaign copy",
    "Discovering or researching creators",
    "Analyzing campaign results",
    "Generating images or video",
    "I'm not using AI at work yet",
  ],
  aiCuriosity: [
    "AI for creator discovery",
    "AI assistants & internal tooling",
    "AI and the future of creator platforms",
    "AI for reviewing creator content",
    "AI for campaign planning & briefing",
    "How creators themselves are using AI",
    "AI and brand safety",
    "AI-generated content (video, images, voice)",
  ],
  creatorAreas: [
    "Creator Discovery & Vetting",
    "Performance Analysis & Reporting",
    "Outreach & Communication",
    "Brief Generation & Campaign Planning",
    "Content Review & Brand Safety",
    "Competitor Monitoring & Trend Tracking",
    "Internal Knowledge Systems & Institutional Memory",
    "Creative Co-Pilots for UGC",
    "Payment, Contracting & Legal Automation",
    "Marketplace Optimization (e.g. TikTok Shop, Amazon Influencer)",
  ],
};

// robust text normalization
const toAsciiQuotes = (s) =>
  String(s || "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');

const norm = (s) =>
  toAsciiQuotes(s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// synonyms to fix mis-matches (esp. the not-using-AI choice)
const AI_USAGE_SYNONYMS = new Map(
  [
    "i'm not using ai at work yet",
    "im not using ai at work yet",
    "i am not using ai at work yet",
    "not using ai at work yet",
  ].map((k) => [k, "I'm not using AI at work yet"])
);

// Normalize “go-to tool” answers
function normalizeTool(s) {
  const t = norm(s);
  if (!t) return "";
  if (t === "gpt" || t.includes("chat gpt") || t.includes("chatgpt") || t.includes("openai"))
    return "ChatGPT";
  if (t.includes("claude")) return "Claude";
  if (t.includes("gemini") || t.includes("bard")) return "Gemini";
  if (t.includes("gamma")) return "Gamma";
  // common no-tool phrases -> "None"
  if (["none", "dont have one", "don't have one", "no", "na"].includes(t)) return "None";
  // Title-case fallback
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

function buildQuestions(headers, rows) {
  const idx = indexByHeader(headers, {
    aiUsage: "Which of the following best describes how you’re using ai",
    goToTool: "what’s your go-to ai tool",
    confidence: "how confident are you",
    curiosity: "which areas of ai are you most curious",
    creatorAreas: "which areas of creator marketing",
  });

  const q = [];

  // helpers
  const get = (row, i) => String((row[i] || "")).trim();
  const splitMulti = (s) =>
    toAsciiQuotes(String(s || ""))
      // handle cases where people typed semicolons or pipes
      .split(/[,;|]/)
      .map((x) => x.trim())
      .filter(Boolean);

  // count/percent helpers
  const toResponses = (counts, total) =>
    Object.entries(counts)
      .map(([text, count]) => ({
        text,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }))
      .filter((r) => r.count > 0);

  // sort: by count desc; ensure "Other" is last if present
  const sortWithOtherLast = (arr) => {
    const others = arr.filter((r) => r.text === "Other");
    const rest = arr.filter((r) => r.text !== "Other").sort((a, b) => b.count - a.count);
    return others.length ? [...rest, ...others] : rest;
  };

  // ========== Q1: AI usage (multi) ==========
  if (idx.aiUsage > -1) {
    const totalRespondents = rows.reduce(
      (n, r) => (get(r, idx.aiUsage).trim() ? n + 1 : n),
      0
    );

    // initialize canonical tallies
    const tally = Object.fromEntries(CANONICAL.aiUsage.map((c) => [c, 0]));
    let otherVerbatims = [];

    rows.forEach((r) => {
      const raw = get(r, idx.aiUsage);
      if (!raw) return;

      const seenForRow = new Set(); // avoid double counting same option per row
      splitMulti(raw).forEach((sel) => {
        // canonical match or synonym repair
        const lowered = norm(sel);
        let matched = CANONICAL.aiUsage.find(
          (c) => norm(c) === lowered || (AI_USAGE_SYNONYMS.get(lowered) === c)
        );

        if (!matched) {
          // some folks typed long phrases; try exact match after ascii/trim
          matched = CANONICAL.aiUsage.find((c) => norm(c) === norm(sel));
        }

        if (matched) {
          if (!seenForRow.has(matched)) {
            tally[matched] += 1;
            seenForRow.add(matched);
          }
        } else {
          // genuine "other" entry: record verbatim once per row item
          otherVerbatims.push(sel);
        }
      });
    });

    // number of rows that had at least ONE non-canonical bit
    const otherCount = otherVerbatims.length ? countDistinctByRowish(otherVerbatims) : 0;

    let responses = toResponses(tally, totalRespondents);

    if (otherCount > 0) {
      responses.push({
        text: "Other",
        count: otherCount,
        percentage: Math.round((otherCount / totalRespondents) * 100),
      });
    }

    responses = sortWithOtherLast(responses);

    q.push({
      question:
        "Which of the following best describes how you're using AI in your work today? (select all that apply)",
      type: "multiple_choice",
      responses,
      total_responses: totalRespondents,
      ...(otherVerbatims.length
        ? { other_responses: otherVerbatims.join(", ") }
        : {}),
    });
  }

  // ========== Q2: Go-to tool (single/free) ==========
  if (idx.goToTool > -1) {
    const totalRespondents = rows.reduce(
      (n, r) => (get(r, idx.goToTool).trim() ? n + 1 : n),
      0
    );

    const counts = Object.create(null);
    rows.forEach((r) => {
      const raw = get(r, idx.goToTool);
      if (!raw) return;
      const items = splitMulti(raw);
      const list = items.length ? items : [raw];
      const seen = new Set();
      list.forEach((x) => {
        const n = normalizeTool(x);
        if (n && !seen.has(n)) {
          counts[n] = (counts[n] || 0) + 1;
          seen.add(n);
        }
      });
    });

    // turn into responses
    let resp = Object.entries(counts)
      .map(([text, count]) => ({
        text,
        count,
        percentage:
          totalRespondents > 0 ? Math.round((count / totalRespondents) * 100) : 0,
      }))
      .filter((r) => r.count > 0);

    // Keep all named tools that have >=10% (your request), aggregate the rest into 'Other'
    const keep = resp.filter((r) => r.text !== "None" && r.percentage >= 10);
    const small = resp.filter((r) => r.text !== "None" && r.percentage < 10);
    const none = resp.find((r) => r.text === "None");

    let final = keep.slice().sort((a, b) => b.count - a.count);

    if (small.length) {
      const oc = small.reduce((s, r) => s + r.count, 0);
      final.push({
        text: "Other",
        count: oc,
        percentage:
          totalRespondents > 0 ? Math.round((oc / totalRespondents) * 100) : 0,
      });
    }

    // If some folks said "None", include it as a normal option (above Other if it beats it)
    if (none) final.push(none);

    final = sortWithOtherLast(final);

    q.push({
      question: "What's your go-to AI tool (if any) in your current workflow?",
      type: "single_choice",
      responses: final,
      total_responses: totalRespondents,
      ...(small.length ? { other_responses: small.map((r) => r.text).join(", ") } : {}),
    });
  }

  // ========== Q3: Confidence (scale 1–5) ==========
  if (idx.confidence > -1) {
    const counts = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    rows.forEach((r) => {
      const n = Number(get(r, idx.confidence));
      if (n >= 1 && n <= 5) counts[String(n)] += 1;
    });
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    const responses = Object.keys(counts).map((k) => ({
      text: k,
      count: counts[k],
      percentage: total > 0 ? Math.round((counts[k] / total) * 100) : 0,
    }));
    q.push({
      question:
        "How confident are you in using AI tools in your creator marketing work? (1–5)",
      type: "scale",
      responses,
      total_responses: total,
    });
  }

  // ========== Q4: Areas of AI (multi) ==========
  if (idx.curiosity > -1) {
    const totalRespondents = rows.reduce(
      (n, r) => (get(r, idx.curiosity).trim() ? n + 1 : n),
      0
    );
    const tally = Object.fromEntries(CANONICAL.aiCuriosity.map((c) => [c, 0]));
    let otherVerbatims = [];

    rows.forEach((r) => {
      const raw = get(r, idx.curiosity);
      if (!raw) return;
      const seen = new Set();
      splitMulti(raw).forEach((sel) => {
        const match = CANONICAL.aiCuriosity.find((c) => norm(c) === norm(sel));
        if (match) {
          if (!seen.has(match)) {
            tally[match] += 1;
            seen.add(match);
          }
        } else {
          otherVerbatims.push(sel);
        }
      });
    });

    const otherCount = otherVerbatims.length ? countDistinctByRowish(otherVerbatims) : 0;

    let responses = toResponses(tally, totalRespondents);
    if (otherCount > 0) {
      responses.push({
        text: "Other",
        count: otherCount,
        percentage:
          totalRespondents > 0 ? Math.round((otherCount / totalRespondents) * 100) : 0,
      });
    }
    responses = sortWithOtherLast(responses);

    q.push({
      question:
        "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
      type: "multiple_choice",
      responses,
      total_responses: totalRespondents,
      ...(otherVerbatims.length
        ? { other_responses: otherVerbatims.join(", ") }
        : {}),
    });
  }

  // ========== Q5: Areas of creator marketing (multi) ==========
  if (idx.creatorAreas > -1) {
    const totalRespondents = rows.reduce(
      (n, r) => (get(r, idx.creatorAreas).trim() ? n + 1 : n),
      0
    );
    const tally = Object.fromEntries(CANONICAL.creatorAreas.map((c) => [c, 0]));
    let otherVerbatims = [];

    rows.forEach((r) => {
      const raw = get(r, idx.creatorAreas);
      if (!raw) return;
      const seen = new Set();
      splitMulti(raw).forEach((sel) => {
        const match = CANONICAL.creatorAreas.find((c) => norm(c) === norm(sel));
        if (match) {
          if (!seen.has(match)) {
            tally[match] += 1;
            seen.add(match);
          }
        } else {
          otherVerbatims.push(sel);
        }
      });
    });

    const otherCount = otherVerbatims.length ? countDistinctByRowish(otherVerbatims) : 0;

    let responses = toResponses(tally, totalRespondents);
    if (otherCount > 0) {
      responses.push({
        text: "Other",
        count: otherCount,
        percentage:
          totalRespondents > 0 ? Math.round((otherCount / totalRespondents) * 100) : 0,
      });
    }
    responses = sortWithOtherLast(responses);

    q.push({
      question:
        "Which areas of creator marketing would you be most interested in testing AI tools for?",
      type: "multiple_choice",
      responses,
      total_responses: totalRespondents,
      ...(otherVerbatims.length
        ? { other_responses: otherVerbatims.join(", ") }
        : {}),
    });
  }

  return q;
}

/* ---------- utilities ---------- */

function indexByHeader(headers, needles) {
  const find = (needle) =>
    headers.findIndex((h) => norm(h).includes(norm(needle)));
  return Object.fromEntries(
    Object.entries(needles).map(([k, n]) => [k, find(n)])
  );
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

// crude way to count "rowish" others: if people typed multiple “other” bits, count each,
// but that matches what your current chart expects (each distinct other selection contributes 1)
function countDistinctByRowish(arr) {
  return arr.length;
}

// functions/api/survey-data.js — DISPLAY-AWARE + DIAGNOSTICS

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

    // ── 1) Env sanity
    diag.steps.push("check-env");
    if (!SHEET_ID) {
      diag.error = "Missing SHEET_ID env var.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Env missing", diagnostics: diag, ...(fb || {}) });
    }
    if (!API_KEY) {
      diag.warning = "Missing GOOGLE_API_KEY env var; will skip API and try CSV fallback.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "No API key; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    // ── 2) Fetch from Google Sheets API
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

    // ── 3) Parse rows
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

    // ── 4) Aggregate in a display-aware way (Tally-style)
    const questions = buildQuestionsFromHeadersAndRows(headers, rows);
    if (!questions.length) {
      diag.aggregation_note = "Aggregation produced 0 questions; trying CSV fallback for comparison.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Aggregation empty; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    return ok({
      success: true,
      message: "Tallied (API path, display-aware)",
      questions,
      diagnostics: diag, // keep while we iterate; remove later if you want
    });
  } catch (err) {
    diag.unhandled = String(err?.message || err);
    return new Response(
      JSON.stringify(
        { success: false, message: "Unhandled error", diagnostics: diag, stack: err?.stack },
        null,
        2
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
}

/* =========================
   CSV FALLBACK (no API key)
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
    const questions = buildQuestionsFromHeadersAndRows(headers, rows);
    return { csv_fallback: true, questions };
  } catch (e) {
    diag.csv_error = String(e?.message || e);
    return { csv_fallback: true, questions: [] };
  }
}

/* =========================
   Display config (exact survey text & order)
   ========================= */
const DISPLAY_CONFIG = {
  aiUsage: {
    title:
      "Which of the following best describes how you’re using AI in your work today? (select all that apply)",
    order: [
      "Discovering or researching creators",
      "Drafting or reviewing creative briefs",
      "Writing emails, captions, or campaign copy",
      "Analyzing campaign results",
      "Generating images or video",
      "I'm not using AI at work yet",
    ],
    type: "multiple_choice",
  },
  goToTool: {
    title: "What’s your go-to AI tool (if any) in your current workflow?",
    type: "single_choice",
  },
  confidence: {
    title: "How confident are you in using AI tools in your creator marketing work?",
    scale: ["1", "2", "3", "4", "5"],
    type: "scale",
  },
  curiosity: {
    title:
      "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
    order: [
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
    type: "multiple_choice",
  },
  topPriority: {
    title: "What’s your top priority for this season? (pick 1)",
    order: [
      "Learning from guest speakers",
      "Swapping tactics/tools with peers",
      "Discovering new AI use cases",
      "Connecting 1:1 with others in similar roles",
      "Having a regular space to reflect and stay sharp",
    ],
    type: "single_choice",
  },
  creatorAreas: {
    title:
      "Which areas of creator marketing would you be most interested in testing AI tools for?",
    order: [
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
    type: "multiple_choice",
  },
};

/* =========================
   Aggregation
   ========================= */
function buildQuestionsFromHeadersAndRows(headers, rows) {
  // find columns by header substrings (safer than hardcoding)
  const idx = indexByHeader(headers, {
    aiUsage: "Which of the following best describes",
    goToTool: "What’s your go-to AI tool",
    confidence: "How confident are you",
    curiosity: "Which areas of AI are you most curious",
    topPriority: "What’s your top priority for this season",
    creatorAreas: "Which areas of creator marketing",
  });

  const CANONICAL = {
    aiUsage: DISPLAY_CONFIG.aiUsage.order,
    aiCuriosity: DISPLAY_CONFIG.curiosity.order,
    creatorAreas: DISPLAY_CONFIG.creatorAreas.order,
    topPriority: DISPLAY_CONFIG.topPriority.order,
  };

  const questions = [];

  const get = (row, i) => String((row[i] || "")).trim();
  const splitMulti = (s) =>
    String(s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  // helper: count how many respondents answered a column (for multi-select %)
  const respondents = (colIdx) =>
    rows.filter((r) => get(r, colIdx).length > 0).length;

  // 1) AI usage (multi, ordered, “Other” last) — % out of respondents
  if (idx.aiUsage > -1) {
    const map = Object.create(null);
    CANONICAL.aiUsage.forEach((v) => (map[v] = 0));
    const other = [];
    const answered = respondents(idx.aiUsage);

    rows.forEach((r) => {
      splitMulti(get(r, idx.aiUsage)).forEach((sel) => {
        const m = CANONICAL.aiUsage.find((o) => o.toLowerCase() === sel.toLowerCase());
        if (m) map[m] += 1;
        else if (!/^\(empty\)|^na$/i.test(sel)) other.push(sel);
      });
    });

    const q = buildDisplayOrderedQuestion(
      "aiUsage",
      map,
      other,
      DISPLAY_CONFIG.aiUsage.order,
      answered
    );
    if (q) questions.push(q);
  }

  // 2) Go-to tool (normalize; group <20% into Other) — % out of respondents
  if (idx.goToTool > -1) {
    const map = Object.create(null);
    rows.forEach((r) => {
      const raw = get(r, idx.goToTool);
      const items = splitMulti(raw);
      (items.length ? items : [raw]).forEach((x) => {
        const n = normalizeTool(x);
        if (n) map[n] = (map[n] || 0) + 1;
      });
    });

    const totalRespondents = respondents(idx.goToTool);
    const { rows: tallied } = tallyMapToResponses(map); // sorted by count

    if (totalRespondents) {
      const popular = tallied
        .map((r) => ({
          text: r.text,
          count: r.count,
          percentage: Math.round((r.count / totalRespondents) * 100),
        }))
        .filter((r) => r.percentage >= 20);

      const small = tallied
        .map((r) => ({
          text: r.text,
          count: r.count,
          percentage: Math.round((r.count / totalRespondents) * 100),
        }))
        .filter((r) => r.percentage < 20);

      let otherList = [];
      if (small.length) {
        const oc = small.reduce((s, r) => s + r.count, 0);
        popular.push({
          text: "Other",
          count: oc,
          percentage: Math.round((oc / totalRespondents) * 100),
        });
        otherList = small.map((r) => r.text);
      }

      questions.push({
        question: DISPLAY_CONFIG.goToTool.title,
        type: DISPLAY_CONFIG.goToTool.type,
        responses: popular,
        total_responses: totalRespondents,
        ...(otherList.length ? { other_responses: otherList.join(", ") } : {}),
      });
    }
  }

  // 3) Confidence 1–5 (keep as-is but force 1→5 order)
  if (idx.confidence > -1) {
    const order = DISPLAY_CONFIG.confidence.scale;
    const map = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    rows.forEach((r) => {
      const n = Number(get(r, idx.confidence));
      if (n >= 1 && n <= 5) map[String(n)] += 1;
    });
    const total = Object.values(map).reduce((s, n) => s + n, 0);
    if (total) {
      const responses = order.map((k) => ({
        text: k,
        count: map[k],
        percentage: Math.round((map[k] / total) * 100),
      }));
      questions.push({
        question: DISPLAY_CONFIG.confidence.title + " (1–5)",
        type: DISPLAY_CONFIG.confidence.type,
        responses,
        total_responses: total,
      });
    }
  }

  // 4) Curiosity (multi)
  if (idx.curiosity > -1) {
    const map = Object.create(null);
    CANONICAL.aiCuriosity.forEach((v) => (map[v] = 0));
    const other = [];
    const answered = respondents(idx.curiosity);

    rows.forEach((r) => {
      splitMulti(get(r, idx.curiosity)).forEach((sel) => {
        const m = CANONICAL.aiCuriosity.find(
          (o) => o.toLowerCase() === sel.toLowerCase()
        );
        if (m) map[m] += 1;
        else if (!/^\(empty\)|^na$/i.test(sel)) other.push(sel);
      });
    });

    const q = buildDisplayOrderedQuestion(
      "curiosity",
      map,
      other,
      DISPLAY_CONFIG.curiosity.order,
      answered
    );
    if (q) questions.push(q);
  }

  // 5) Top priority (single)
  if (idx.topPriority > -1) {
    const map = Object.create(null);
    const answered = respondents(idx.topPriority);
    DISPLAY_CONFIG.topPriority.order.forEach((v) => (map[v] = 0));

    rows.forEach((r) => {
      const v = get(r, idx.topPriority);
      if (v) map[v] = (map[v] || 0) + 1;
    });

    const q = buildDisplayOrderedQuestion(
      "topPriority",
      map,
      [],
      DISPLAY_CONFIG.topPriority.order,
      answered
    );
    if (q) questions.push(q);
  }

  // 6) Creator marketing areas (multi)
  if (idx.creatorAreas > -1) {
    const map = Object.create(null);
    DISPLAY_CONFIG.creatorAreas.order.forEach((v) => (map[v] = 0));
    const other = [];
    const answered = respondents(idx.creatorAreas);

    rows.forEach((r) => {
      splitMulti(get(r, idx.creatorAreas)).forEach((sel) => {
        const m = DISPLAY_CONFIG.creatorAreas.order.find(
          (o) => o.toLowerCase() === sel.toLowerCase()
        );
        if (m) map[m] += 1;
        else if (!/^\(empty\)|^na$/i.test(sel)) other.push(sel);
      });
    });

    const q = buildDisplayOrderedQuestion(
      "creatorAreas",
      map,
      other,
      DISPLAY_CONFIG.creatorAreas.order,
      answered
    );
    if (q) questions.push(q);
  }

  return questions;
}

/* =========================
   Builders & helpers
   ========================= */

// Build a question using a fixed display order and an “Other” bucket.
// percentages are computed out of `respondentsTotal` (Tally style).
function buildDisplayOrderedQuestion(key, countsMap, otherList, order, respondentsTotal) {
  const cfg = DISPLAY_CONFIG[key];
  if (!cfg || !respondentsTotal) return null;

  const responses = [];
  order.forEach((label) => {
    const count = Number(countsMap[label] || 0);
    if (count > 0) {
      responses.push({
        text: label,
        count,
        percentage: Math.round((count / respondentsTotal) * 100),
      });
    }
  });

  let otherResponses = (otherList || []).filter(Boolean);
  if (otherResponses.length) {
    const otherCount = otherResponses.length; // each unmatched selection counted once
    responses.push({
      text: "Other",
      count: otherCount,
      percentage: Math.round((otherCount / respondentsTotal) * 100),
    });
  }

  return {
    question: cfg.title,
    type: cfg.type,
    responses,
    total_responses: respondentsTotal,
    ...(otherResponses.length ? { other_responses: otherResponses.join(", ") } : {}),
  };
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

function normalizeTool(s) {
  const t = String(s || "").toLowerCase();
  if (!t) return "";
  if (t === "gpt" || t.includes("chat gpt") || t.includes("chatgpt") || t.includes("openai"))
    return "ChatGPT";
  if (t.includes("claude")) return "Claude";
  if (t.includes("gemini") || t.includes("bard")) return "Gemini";
  if (t.includes("gamma")) return "Gamma";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

function tallyMapToResponses(map) {
  const total = Object.values(map).reduce((s, n) => s + Number(n || 0), 0);
  const rows = Object.entries(map)
    .map(([text, count]) => ({
      text,
      count: Number(count || 0),
      percentage: total > 0 ? Math.round((count / total) * 100) : 0,
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  return { rows, total };
}

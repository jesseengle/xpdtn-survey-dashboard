// functions/api/survey-data.js — Display-aware, with strict option matching
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

    // ===== Step 1: sanity on env =====
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

    // ===== Step 2: Google Sheets API fetch =====
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
      return ok({
        success: false,
        message: "Sheets API failed; CSV fallback attempted",
        diagnostics: diag,
        ...(fb || {}),
      });
    }

    // ===== Step 3: Parse headers & rows =====
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

    // ===== Step 4: Build questions (aggregation) =====
    const questions = buildQuestionsFromHeadersAndRows(headers, rows);
    if (!questions.length) {
      diag.aggregation_note =
        "Aggregation produced 0 questions; trying CSV fallback for comparison.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({
        success: false,
        message: "Aggregation empty; CSV fallback attempted",
        diagnostics: diag,
        ...(fb || {}),
      });
    }

    return ok({
      success: true,
      message: "Tallied (API path, display-aware)",
      questions,
      diagnostics: diag,
    });
  } catch (err) {
    return new Response(
      JSON.stringify(
        {
          success: false,
          message: "Unhandled error",
          stack: err?.stack,
        },
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
   Aggregation (your rules)
   ========================= */
function buildQuestionsFromHeadersAndRows(headers, rows) {
  // find columns by header substrings (tolerant to edits)
  const idx = indexByHeader(headers, {
    aiUsage: "Which of the following best describes",
    goToTool: "What’s your go-to AI tool",
    confidence: "How confident are you",
    curiosity: "Which areas of AI are you most curious",
    topPriority: "What’s your top priority for this season",
    creatorAreas: "Which areas of creator marketing",
  });

  // Canonical option lists
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

  // helpers
  const get = (row, i) => String((row?.[i] ?? "")).trim();
  const splitMulti = (s) =>
    String(s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const clean = (s) =>
    String(s || "")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const isTrivial = (s) => !s || /^\(empty\)|^na$/i.test(s);

  // 1) AI usage (multi) — STRICT matching + proper "Other" counting
  if (idx.aiUsage > -1) {
    const counts = Object.fromEntries(CANONICAL.aiUsage.map((o) => [o, 0]));
    let otherCount = 0;
    const otherVerbatims = [];

    const canonLower = CANONICAL.aiUsage.map((o) => clean(o));

    rows.forEach((r) => {
      const cell = get(r, idx.aiUsage);
      if (!cell) return;

      const tokens = splitMulti(cell);
      let rowHadOther = false;

      tokens.forEach((tok) => {
        const tClean = clean(tok);
        const matchIdx = canonLower.indexOf(tClean);
        if (matchIdx !== -1) {
          counts[CANONICAL.aiUsage[matchIdx]] += 1;
        } else if (!isTrivial(tok)) {
          rowHadOther = true;
          otherVerbatims.push(tok);
        }
      });

      if (rowHadOther) otherCount += 1;
    });

    // Build responses: sort by count desc, push "Other" last
    const totalRespondents = countNonEmptyRows(rows, idx.aiUsage);
    const resp = Object.entries(counts)
      .map(([text, count]) => ({
        text,
        count,
        percentage:
          totalRespondents > 0
            ? Math.round((count / totalRespondents) * 100)
            : 0,
      }))
      .sort((a, b) => b.count - a.count);

    if (otherCount > 0) {
      resp.push({
        text: "Other",
        count: otherCount,
        percentage:
          totalRespondents > 0
            ? Math.round((otherCount / totalRespondents) * 100)
            : 0,
      });
    }

    const dedupOther = dedupeVerbatims(otherVerbatims, canonLower);
    questions.push({
      question:
        "Which of the following best describes how you're using AI in your work today? (select all that apply)",
      type: "multiple_choice",
      responses: resp,
      total_responses: totalRespondents,
      ...(dedupOther.length ? { other_responses: dedupOther.join(", ") } : {}),
    });
  }

  // 2) Go-to tool (normalize; include >=10%, rest -> Other + verbatims)
  if (idx.goToTool > -1) {
    const map = Object.create(null);
    const others = [];

    const totalRespondents = countNonEmptyRows(rows, idx.goToTool);

    rows.forEach((r) => {
      const raw = get(r, idx.goToTool);
      if (!raw) return;
      const items = splitMulti(raw);
      const list = items.length ? items : [raw];

      let sawNonMain = false;
      list.forEach((x) => {
        const n = normalizeTool(x);
        if (n === "Other") {
          sawNonMain = true;
          if (!isTrivial(x)) others.push(x);
        } else if (n) {
          map[n] = (map[n] || 0) + 1;
        } else {
          sawNonMain = true;
          if (!isTrivial(x)) others.push(x);
        }
      });

      // If they typed only non-main values, we'll fold it into Other via threshold logic below.
    });

    const { rows: dist, total } = tallyMapToResponses(map, totalRespondents);
    const popular = dist.filter((r) => r.percentage >= 10);
    const small = dist.filter((r) => r.percentage < 10);

    if (small.length) {
      const otherCount = small.reduce((s, r) => s + r.count, 0);
      popular.push({
        text: "Other",
        count: otherCount,
        percentage:
          totalRespondents > 0
            ? Math.round((otherCount / totalRespondents) * 100)
            : 0,
      });
    }

    // Always keep “Other” last
    popular.sort((a, b) => {
      if (a.text === "Other") return 1;
      if (b.text === "Other") return -1;
      return b.count - a.count;
    });

    const dedupOther = dedupeVerbatims(
      others,
      ["chatgpt", "claude", "gemini", "gamma"].map((x) => x.toLowerCase())
    );

    questions.push({
      question: "What’s your go-to AI tool (if any) in your current workflow?",
      type: "single_choice",
      responses: popular,
      total_responses: totalRespondents,
      ...(dedupOther.length ? { other_responses: dedupOther.join(", ") } : {}),
    });
  }

  // 3) Confidence 1–5
  if (idx.confidence > -1) {
    const map = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    const totalRespondents = countNonEmptyRows(rows, idx.confidence);

    rows.forEach((r) => {
      const n = Number(get(r, idx.confidence));
      if (n >= 1 && n <= 5) map[String(n)] += 1;
    });

    const responses = ["1", "2", "3", "4", "5"].map((k) => ({
      text: k,
      count: map[k],
      percentage:
        totalRespondents > 0
          ? Math.round((map[k] / totalRespondents) * 100)
          : 0,
    }));

    questions.push({
      question:
        "How confident are you in using AI tools in your creator marketing work? (1–5)",
      type: "scale",
      responses,
      total_responses: totalRespondents,
    });
  }

  // 4) Curiosity (multi)
  if (idx.curiosity > -1) {
    questions.push(
      buildMultiFromCanon({
        title:
          "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
        rows,
        colIndex: idx.curiosity,
        canonical: CANONICAL.aiCuriosity,
      })
    );
  }

  // 5) Top priority (single)
  if (idx.topPriority > -1) {
    const map = Object.create(null);
    const totalRespondents = countNonEmptyRows(rows, idx.topPriority);
    rows.forEach((r) => {
      const v = get(r, idx.topPriority);
      if (v) map[v] = (map[v] || 0) + 1;
    });
    const responses = Object.entries(map)
      .map(([text, count]) => ({
        text,
        count,
        percentage:
          totalRespondents > 0
            ? Math.round((count / totalRespondents) * 100)
            : 0,
      }))
      .sort((a, b) => b.count - a.count);

    questions.push({
      question: "What’s your top priority for this season? (pick 1)",
      type: "single_choice",
      responses,
      total_responses: totalRespondents,
    });
  }

  // 6) Creator marketing areas (multi)
  if (idx.creatorAreas > -1) {
    questions.push(
      buildMultiFromCanon({
        title:
          "Which areas of creator marketing would you be most interested in testing AI tools for?",
        rows,
        colIndex: idx.creatorAreas,
        canonical: CANONICAL.creatorAreas,
      })
    );
  }

  return questions;
}

/* --------- multi-select builder (canonical + “Other last”) --------- */
function buildMultiFromCanon({ title, rows, colIndex, canonical }) {
  const counts = Object.fromEntries(canonical.map((o) => [o, 0]));
  let otherCount = 0;
  const otherVerbatims = [];

  const canonLower = canonical.map((o) =>
    o.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').toLowerCase()
  );

  const totalRespondents = countNonEmptyRows(rows, colIndex);

  rows.forEach((r) => {
    const cell = String(r?.[colIndex] ?? "").trim();
    if (!cell) return;

    const tokens = cell
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let rowHadOther = false;

    tokens.forEach((tok) => {
      const tClean = tok
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"')
        .toLowerCase()
        .trim();
      const matchIdx = canonLower.indexOf(tClean);
      if (matchIdx !== -1) {
        counts[canonical[matchIdx]] += 1;
      } else if (!/^\(empty\)|^na$/i.test(tok)) {
        rowHadOther = true;
        otherVerbatims.push(tok);
      }
    });

    if (rowHadOther) otherCount += 1;
  });

  const responses = Object.entries(counts)
    .map(([text, count]) => ({
      text,
      count,
      percentage:
        totalRespondents > 0
          ? Math.round((count / totalRespondents) * 100)
          : 0,
    }))
    .sort((a, b) => b.count - a.count);

  if (otherCount > 0) {
    responses.push({
      text: "Other",
      count: otherCount,
      percentage:
        totalRespondents > 0
          ? Math.round((otherCount / totalRespondents) * 100)
          : 0,
    });
  }

  const dedupOther = dedupeVerbatims(otherVerbatims, canonLower);

  return {
    question: title,
    type: "multiple_choice",
    responses,
    total_responses: totalRespondents,
    ...(dedupOther.length ? { other_responses: dedupOther.join(", ") } : {}),
  };
}

/* ---------- misc helpers ---------- */
function indexByHeader(headers, needles) {
  const find = (needle) =>
    headers.findIndex((h) => h.toLowerCase().includes(needle.toLowerCase()));
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

function normalizeTool(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return "";
  if (t === "gpt" || t.includes("chat gpt") || t.includes("chatgpt") || t.includes("openai"))
    return "ChatGPT";
  if (t.includes("claude")) return "Claude";
  if (t.includes("gemini") || t.includes("bard")) return "Gemini";
  if (t.includes("gamma")) return "Gamma";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

function tallyMapToResponses(map, totalRespondents) {
  // total = sum of counts (not used for % in multi-selects; we use respondents)
  const total = Object.values(map).reduce((s, n) => s + Number(n || 0), 0);
  const rows = Object.entries(map)
    .map(([text, count]) => ({
      text,
      count: Number(count || 0),
      percentage:
        totalRespondents > 0
          ? Math.round((Number(count || 0) / totalRespondents) * 100)
          : 0,
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  return { rows, total };
}

function countNonEmptyRows(rows, colIndex) {
  let n = 0;
  rows.forEach((r) => {
    const v = String(r?.[colIndex] ?? "").trim();
    if (v) n += 1;
  });
  return n;
}

function dedupeVerbatims(list, canonLower) {
  const s = new Set();
  list.forEach((txt) => {
    const cleaned = txt
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return;
    const lower = cleaned.toLowerCase();
    if (canonLower && canonLower.includes(lower)) return; // don't echo canonical labels
    s.add(cleaned);
  });
  return Array.from(s);
}

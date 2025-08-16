// functions/api/survey-data.js — Multi-select fixed (no comma-splitting), display-aware
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

    // ===== Step 1: env =====
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

    // ===== Step 2: fetch =====
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

    // ===== Step 3: parse =====
    diag.steps.push("parse-api-values");
    const values = Array.isArray(apiJson?.values) ? apiJson.values : [];
    diag.row_count = values.length;

    const headerIndex = values.findIndex(row => (row || []).some(cell => String(cell || "").trim().length));
    if (headerIndex === -1) {
      diag.parse_error = "No non-empty rows found.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "No non-empty rows; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    const headers = values[headerIndex].map(v => String(v || "").trim());
    const rows = values.slice(headerIndex + 1);
    diag.detected_header_row = headerIndex + 1;
    diag.detected_headers_preview = headers.slice(0, 12);

    // ===== Step 4: aggregate =====
    const questions = buildQuestionsFromHeadersAndRows(headers, rows);
    if (!questions.length) {
      diag.aggregation_note = "Aggregation produced 0 questions; trying CSV fallback for comparison.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Aggregation empty; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    return ok({ success: true, message: "Tallied (API path, display-aware)", questions, diagnostics: diag });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, message: "Unhandled error", stack: err?.stack }, null, 2), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
}

/* =========================
   CSV FALLBACK
   ========================= */
async function tryCsvFallback(diag, { SHEET_ID, SHEET_GID = "0" }) {
  try {
    diag.steps.push("csv-fallback");
    if (!SHEET_ID) throw new Error("No SHEET_ID for CSV fallback.");
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${encodeURIComponent(SHEET_GID)}`;
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
   Aggregation
   ========================= */
function buildQuestionsFromHeadersAndRows(headers, rows) {
  const idx = indexByHeader(headers, {
    aiUsage: 'Which of the following best describes',
    goToTool: "What’s your go-to AI tool",
    confidence: 'How confident are you',
    curiosity: 'Which areas of AI are you most curious',
    topPriority: 'What’s your top priority for this season',
    creatorAreas: 'Which areas of creator marketing'
  });

  const CANONICAL = {
    aiUsage: [
      "Discovering or researching creators",
      "Drafting or reviewing creative briefs",
      "Writing emails, captions, or campaign copy",
      "Analyzing campaign results",
      "Generating images or video",
      "I'm not using AI at work yet"
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
      "AI and the future of creator platforms"
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
      "Internal Knowledge Systems & Institutional Memory"
    ],
    topPriority: [
      "Learning from guest speakers",
      "Swapping tactics/tools with peers",
      "Discovering new AI use cases",
      "Connecting 1:1 with others in similar roles",
      "Having a regular space to reflect and stay sharp"
    ]
  };

  const questions = [];
  const get = (row, i) => String((row?.[i] ?? '')).trim();

  // Q1 — multi (phrase detection; commas inside labels are OK)
  if (idx.aiUsage > -1) {
    const totalRespondents = countNonEmptyRows(rows, idx.aiUsage);
    const tally = phraseTally(rows, idx.aiUsage, CANONICAL.aiUsage);
    const responses = toResponsesSorted(tally.map, totalRespondents);
    pushOtherLast(responses, tally.otherCount, totalRespondents);

    questions.push({
      question: "Which of the following best describes how you're using AI in your work today? (select all that apply)",
      type: "multiple_choice",
      responses,
      total_responses: totalRespondents,
      ...(tally.otherVerbatims.length ? { other_responses: tally.otherVerbatims.join(', ') } : {})
    });
  }

  // Go-to tool — single with normalization + ≥10% rule, Other last, verbatims
  if (idx.goToTool > -1) {
    const totalRespondents = countNonEmptyRows(rows, idx.goToTool);
    const map = Object.create(null);
    const otherTexts = [];

    rows.forEach(r => {
      const raw = get(r, idx.goToTool);
      if (!raw) return;
      const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
      const list = parts.length ? parts : [raw];

      list.forEach(x => {
        const n = normalizeTool(x);
        if (n && n !== "Other") {
          map[n] = (map[n] || 0) + 1;
        } else if (!/^\(empty\)|^na$/i.test(x)) {
          otherTexts.push(x);
        }
      });
    });

    let dist = Object.entries(map).map(([text, count]) => ({
      text,
      count,
      percentage: totalRespondents ? Math.round((count / totalRespondents) * 100) : 0
    }));

    const popular = dist.filter(d => d.percentage >= 10).sort((a,b)=>b.count-a.count);
    const small   = dist.filter(d => d.percentage < 10);
    if (small.length) {
      const oc = small.reduce((s,d)=>s+d.count,0);
      popular.push({
        text: "Other",
        count: oc,
        percentage: totalRespondents ? Math.round((oc/totalRespondents)*100) : 0
      });
    }
    // always keep Other last
    popular.sort((a,b)=>{
      if (a.text === "Other") return 1;
      if (b.text === "Other") return -1;
      return b.count - a.count;
    });

    const dedupOther = dedupeVerbatims(otherTexts, ["chatgpt","claude","gemini","gamma"]);

    questions.push({
      question: "What’s your go-to AI tool (if any) in your current workflow?",
      type: "single_choice",
      responses: popular,
      total_responses: totalRespondents,
      ...(dedupOther.length ? { other_responses: dedupOther.join(', ') } : {})
    });
  }

  // Confidence — 1..5 ordered
  if (idx.confidence > -1) {
    const totalRespondents = countNonEmptyRows(rows, idx.confidence);
    const map = { "1":0,"2":0,"3":0,"4":0,"5":0 };
    rows.forEach(r => {
      const n = Number(get(r, idx.confidence));
      if (n>=1 && n<=5) map[String(n)] += 1;
    });
    const responses = ["1","2","3","4","5"].map(k => ({
      text: k, count: map[k],
      percentage: totalRespondents ? Math.round((map[k]/totalRespondents)*100) : 0
    }));
    questions.push({
      question: "How confident are you in using AI tools in your creator marketing work? (1–5)",
      type: "scale",
      responses,
      total_responses: totalRespondents
    });
  }

  // Curiosity — multi via phrase detection
  if (idx.curiosity > -1) {
    const totalRespondents = countNonEmptyRows(rows, idx.curiosity);
    const tally = phraseTally(rows, idx.curiosity, CANONICAL.aiCuriosity);
    const responses = toResponsesSorted(tally.map, totalRespondents);
    pushOtherLast(responses, tally.otherCount, totalRespondents);

    questions.push({
      question: "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
      type: "multiple_choice",
      responses,
      total_responses: totalRespondents,
      ...(tally.otherVerbatims.length ? { other_responses: tally.otherVerbatims.join(', ') } : {})
    });
  }

  // Top priority — single
  if (idx.topPriority > -1) {
    const totalRespondents = countNonEmptyRows(rows, idx.topPriority);
    const map = {};
    rows.forEach(r => {
      const v = get(r, idx.topPriority);
      if (v) map[v] = (map[v] || 0) + 1;
    });
    const responses = Object.entries(map)
      .map(([text,count]) => ({
        text, count,
        percentage: totalRespondents ? Math.round((count/totalRespondents)*100) : 0
      }))
      .sort((a,b)=>b.count-a.count);

    questions.push({
      question: "What’s your top priority for this season? (pick 1)",
      type: "single_choice",
      responses,
      total_responses: totalRespondents
    });
  }

  // Creator areas — multi via phrase detection (handles options with commas)
  if (idx.creatorAreas > -1) {
    const totalRespondents = countNonEmptyRows(rows, idx.creatorAreas);
    const tally = phraseTally(rows, idx.creatorAreas, CANONICAL.creatorAreas);
    const responses = toResponsesSorted(tally.map, totalRespondents);
    pushOtherLast(responses, tally.otherCount, totalRespondents);

    questions.push({
      question: "Which areas of creator marketing would you be most interested in testing AI tools for?",
      type: "multiple_choice",
      responses,
      total_responses: totalRespondents,
      ...(tally.otherVerbatims.length ? { other_responses: tally.otherVerbatims.join(', ') } : {})
    });
  }

  return questions;
}

/* -------- phrase-based multi-select tally (no comma splitting) -------- */
function phraseTally(rows, colIndex, canonical) {
  const map = Object.fromEntries(canonical.map(o => [o, 0]));
  let otherCount = 0;
  const otherVerbatims = [];

  const canonLower = canonical.map(o =>
    o.replace(/[’‘]/g,"'").replace(/[“”]/g,'"').toLowerCase().trim()
  );

  const cleanAll = s =>
    String(s || "")
      .replace(/[’‘]/g,"'")
      .replace(/[“”]/g,'"')
      .trim();

  rows.forEach(r => {
    let raw = cleanAll(r?.[colIndex]);
    if (!raw) return;

    const lower = raw.toLowerCase();
    let matchedAny = false;
    let remainder = lower;

    // For each canonical option, if the phrase appears, count once and remove it from remainder
    canonLower.forEach((optLower, idx) => {
      if (!optLower) return;
      if (remainder.includes(optLower)) {
        map[canonical[idx]] += 1;
        matchedAny = true;
        // remove all occurrences to keep remainder clean for "Other"
        remainder = remainder.split(optLower).join(" ");
      }
    });

    // Clean remainder and decide if there's meaningful text left (Other)
    const remainderText = remainder
      .replace(/[,;|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (remainderText && remainderText !== "(empty)" && remainderText.toLowerCase() !== "na") {
      otherCount += 1;
      // try to produce readable verbatims
      remainderText.split(/[,;|]/).forEach(piece => {
        const p = piece.replace(/\s+/g, " ").trim();
        if (p) otherVerbatims.push(cleanAll(p));
      });
    }
  });

  return { map, otherCount, otherVerbatims: dedupeVerbatims(otherVerbatims, canonLower) };
}

/* ---------------- utils ---------------- */
function pushOtherLast(responses, otherCount, totalRespondents) {
  if (!otherCount) return;
  responses.push({
    text: "Other",
    count: otherCount,
    percentage: totalRespondents ? Math.round((otherCount/totalRespondents)*100) : 0
  });
}

function toResponsesSorted(map, totalRespondents) {
  return Object.entries(map)
    .map(([text, count]) => ({
      text,
      count,
      percentage: totalRespondents ? Math.round((count/totalRespondents)*100) : 0
    }))
    .sort((a,b)=>b.count-a.count);
}

function indexByHeader(headers, needles) {
  const find = (needle) => headers.findIndex(h => h.toLowerCase().includes(needle.toLowerCase()));
  return Object.fromEntries(Object.entries(needles).map(([k, n]) => [k, find(n)]));
}

function parseCsv(text) {
  const lines = text.split("\n").filter(l => l.trim().length);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map(h => h.replace(/"/g, '').trim());
  const rows = lines.slice(1).map(splitCsvLine);
  return { headers, rows };
}
function splitCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i=0;i<line.length;i++){
    const c=line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q){ out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normalizeTool(s){
  const t = String(s||'').toLowerCase().trim();
  if (!t) return '';
  if (t==='gpt' || t.includes('chat gpt') || t.includes('chatgpt') || t.includes('openai')) return 'ChatGPT';
  if (t.includes('claude')) return 'Claude';
  if (t.includes('gemini') || t.includes('bard')) return 'Gemini';
  if (t.includes('gamma')) return 'Gamma';
  if (t === "other") return "Other";
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function tallyMapToResponses(map, totalRespondents){
  const total = Object.values(map).reduce((s,n)=>s+Number(n||0),0);
  const rows = Object.entries(map)
    .map(([text,count]) => ({ text, count: Number(count||0), percentage: totalRespondents>0 ? Math.round((count/totalRespondents)*100) : 0 }))
    .filter(r => r.count > 0)
    .sort((a,b)=>b.count-a.count);
  return { rows, total };
}

function countNonEmptyRows(rows, colIndex) {
  let n = 0;
  rows.forEach(r => {
    const v = String(r?.[colIndex] ?? '').trim();
    if (v) n += 1;
  });
  return n;
}

function dedupeVerbatims(list, canonLower) {
  const s = new Set();
  list.forEach(txt => {
    const cleaned = String(txt||'')
      .replace(/[’‘]/g,"'")
      .replace(/[“”]/g,'"')
      .replace(/\s+/g,' ')
      .trim();
    if (!cleaned) return;
    const lower = cleaned.toLowerCase();
    if (canonLower && canonLower.includes(lower)) return;
    s.add(cleaned);
  });
  return Array.from(s);
}

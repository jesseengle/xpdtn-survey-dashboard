// functions/api/survey-data.js — DISPLAY-AWARE, ORDERED + "OTHER LAST"
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

    const ok = (obj, status = 200) =>
      new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "content-type": "application/json" },
      });

    // --- Env checks ---------------------------------------------------------
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

    // --- Fetch Google Sheets API -------------------------------------------
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

    // --- Parse values -------------------------------------------------------
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

    // --- Build questions (ordered, other-last, correct %s) ------------------
    const questions = buildQuestionsFromHeadersAndRows(headers, rows);

    if (!questions.length) {
      diag.aggregation_note = "Aggregation produced 0 questions; trying CSV fallback for comparison.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Aggregation empty; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    return ok({ success: true, message: "Tallied (API path, display-aware)", questions, diagnostics: diag });

  } catch (err) {
    const diagErr = { unhandled: String(err?.message || err) };
    return new Response(JSON.stringify({ success: false, message: "Unhandled error", ...diagErr }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

/* =========================
   CSV FALLBACK (no API key)
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
   Aggregation (display rules)
   ========================= */
function buildQuestionsFromHeadersAndRows(headers, rows) {
  // locate columns by substrings so header text can vary
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
      // Do NOT include "Other" here; we add it after and count it correctly.
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

  const Q = [];

  // utilities
  const get = (row, i) => String((row[i] ?? "")).trim();
  const splitMulti = (s) => String(s || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  // ---------- 1) AI Usage (multi; ordered; Other last with verbatims) ----------
  if (idx.aiUsage > -1) {
    const order = CANONICAL.aiUsage;
    const counts = Object.fromEntries(order.map(o => [o, 0]));
    const otherVerbatims = new Set();
    const otherRows = new Set();
    let respondents = 0;

    rows.forEach((r, rIdx) => {
      const raw = get(r, idx.aiUsage);
      if (!raw) return;
      respondents += 1;

      const sels = splitMulti(raw);
      sels.forEach(sel => {
        // exact canonical match (case-insensitive)
        const match = order.find(o => o.toLowerCase() === sel.toLowerCase());
        if (match) {
          counts[match] += 1;
        } else if (!/^\(empty\)|^na$/i.test(sel)) {
          otherRows.add(rIdx);
          otherVerbatims.add(sel);
        }
      });
    });

    const responses = order.map(text => ({
      text,
      count: counts[text],
      percentage: respondents ? Math.round((counts[text] / respondents) * 100) : 0,
    }));

    // "Other" goes LAST
    if (otherRows.size) {
      responses.push({
        text: "Other",
        count: otherRows.size,
        percentage: respondents ? Math.round((otherRows.size / respondents) * 100) : 0,
      });
    }

    Q.push({
      question: "Which of the following best describes how you're using AI in your work today? (select all that apply)",
      type: "multiple_choice",
      responses,
      total_responses: respondents,
      ...(otherVerbatims.size ? { other_responses: Array.from(otherVerbatims).join(", ") } : {})
    });
  }

  // ---------- 2) Go-to AI tool (single; normalize; >=10% or group to 'Other' last) ----------
  if (idx.goToTool > -1) {
    const toolCounts = Object.create(null);
    let respondents = 0;

    rows.forEach(r => {
      const raw = get(r, idx.goToTool);
      if (!raw) return;
      respondents += 1;
      const items = splitMulti(raw);
      (items.length ? items : [raw]).forEach(x => {
        const n = normalizeTool(x);
        if (!n) return;
        toolCounts[n] = (toolCounts[n] || 0) + 1;
      });
    });

    // build rows with denominator = respondents
    const all = Object.entries(toolCounts).map(([text, count]) => ({
      text,
      count,
      percentage: respondents ? Math.round((count / respondents) * 100) : 0
    }));

    // keep tools >= 10%, group the rest into "Other"
    const keep = all.filter(r => r.percentage >= 10).sort((a,b)=>b.count-a.count);
    const small = all.filter(r => r.percentage < 10).sort((a,b)=>b.count-a.count);
    if (small.length) {
      const oc = small.reduce((s, r) => s + r.count, 0);
      keep.push({
        text: "Other",
        count: oc,
        percentage: respondents ? Math.round((oc / respondents) * 100) : 0
      });
    }

    Q.push({
      question: "What's your go-to AI tool?",
      type: "single_choice",
      responses: keep,
      total_responses: respondents,
      ...(small.length ? { other_responses: small.map(r => r.text).join(", ") } : {})
    });
  }

  // ---------- 3) Confidence (scale 1–5) ----------
  if (idx.confidence > -1) {
    const map = { "1":0,"2":0,"3":0,"4":0,"5":0 };
    let respondents = 0;
    rows.forEach(r => {
      const val = get(r, idx.confidence);
      if (!val) return;
      respondents += 1;
      const n = Number(val);
      if (n >= 1 && n <= 5) map[String(n)] += 1;
    });

    const responses = ["1","2","3","4","5"].map(k => ({
      text: k,
      count: map[k],
      percentage: respondents ? Math.round((map[k] / respondents) * 100) : 0
    }));

    Q.push({
      question: "How confident are you in using AI tools in your creator marketing work? (1–5)",
      type: "scale",
      responses,
      total_responses: respondents
    });
  }

  // ---------- 4) Areas of AI (multi; ordered; Other last) ----------
  if (idx.curiosity > -1) {
    const order = CANONICAL.aiCuriosity;
    const counts = Object.fromEntries(order.map(o => [o, 0]));
    const otherVerbatims = new Set();
    const otherRows = new Set();
    let respondents = 0;

    rows.forEach((r, rIdx) => {
      const raw = get(r, idx.curiosity);
      if (!raw) return;
      respondents += 1;
      splitMulti(raw).forEach(sel => {
        const match = order.find(o => o.toLowerCase() === sel.toLowerCase());
        if (match) counts[match] += 1;
        else if (!/^\(empty\)|^na$/i.test(sel)) {
          otherRows.add(rIdx);
          otherVerbatims.add(sel);
        }
      });
    });

    const responses = order.map(text => ({
      text,
      count: counts[text],
      percentage: respondents ? Math.round((counts[text] / respondents) * 100) : 0,
    }));

    if (otherRows.size) {
      responses.push({
        text: "Other",
        count: otherRows.size,
        percentage: respondents ? Math.round((otherRows.size / respondents) * 100) : 0,
      });
    }

    Q.push({
      question: "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
      type: "multiple_choice",
      responses,
      total_responses: respondents,
      ...(otherVerbatims.size ? { other_responses: Array.from(otherVerbatims).join(", ") } : {})
    });
  }

  // ---------- 5) Top priority (single; ordered) ----------
  if (idx.topPriority > -1) {
    const order = CANONICAL.topPriority;
    const counts = Object.fromEntries(order.map(o => [o, 0]));
    let respondents = 0;

    rows.forEach(r => {
      const raw = get(r, idx.topPriority);
      if (!raw) return;
      respondents += 1;
      const match = order.find(o => o.toLowerCase() === raw.toLowerCase());
      if (match) counts[match] += 1;
    });

    const responses = order.map(text => ({
      text,
      count: counts[text],
      percentage: respondents ? Math.round((counts[text] / respondents) * 100) : 0
    }));

    Q.push({
      question: "What's your top priority for this season?",
      type: "single_choice",
      responses,
      total_responses: respondents
    });
  }

  // ---------- 6) Areas of creator marketing (multi; ordered; Other last; include 0s) ----------
  if (idx.creatorAreas > -1) {
    const order = CANONICAL.creatorAreas;
    const counts = Object.fromEntries(order.map(o => [o, 0]));
    const otherVerbatims = new Set();
    const otherRows = new Set();
    let respondents = 0;

    rows.forEach((r, rIdx) => {
      const raw = get(r, idx.creatorAreas);
      if (!raw) return;
      respondents += 1;
      splitMulti(raw).forEach(sel => {
        const match = order.find(o => o.toLowerCase() === sel.toLowerCase());
        if (match) counts[match] += 1;
        else if (!/^\(empty\)|^na$/i.test(sel)) {
          otherRows.add(rIdx);
          otherVerbatims.add(sel);
        }
      });
    });

    const responses = order.map(text => ({
      text,
      count: counts[text],
      percentage: respondents ? Math.round((counts[text] / respondents) * 100) : 0,
    }));

    if (otherRows.size) {
      responses.push({
        text: "Other",
        count: otherRows.size,
        percentage: respondents ? Math.round((otherRows.size / respondents) * 100) : 0,
      });
    }

    Q.push({
      question: "Which areas of creator marketing would you be most interested in testing AI tools for?",
      type: "multiple_choice",
      responses,
      total_responses: respondents,
      ...(otherVerbatims.size ? { other_responses: Array.from(otherVerbatims).join(", ") } : {})
    });
  }

  return Q;
}

/* ---------- helpers ---------- */
function indexByHeader(headers, needles) {
  const find = (needle) => headers.findIndex(h => h.toLowerCase().includes(needle.toLowerCase()));
  return Object.fromEntries(Object.entries(needles).map(([k, n]) => [k, find(n)]));
}
function parseCsv(text) {
  const lines = text.split("\n").filter(l => l.trim().length);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map(h => h.replace(/"/g,'').trim());
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
  if(!t) return '';
  if (t==='gpt' || t.includes('chat gpt') || t.includes('chatgpt') || t.includes('openai')) return 'ChatGPT';
  if (t.includes('claude')) return 'Claude';
  if (t.includes('gemini') || t.includes('bard')) return 'Gemini';
  if (t.includes('gamma')) return 'Gamma';
  // Title-case first char as a fallback
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

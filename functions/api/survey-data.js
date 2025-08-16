// functions/api/survey-data.js — DIAGNOSTIC EDITION
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

    // helper responders
    const ok = (obj) => new Response(JSON.stringify(obj, null, 2), { headers: { "content-type": "application/json" } });

    // ===== Step 1: sanity on env =====
    diag.steps.push("check-env");
    if (!SHEET_ID) {
      diag.error = "Missing SHEET_ID env var.";
      // Try CSV fallback anyway
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Env missing", diagnostics: diag, ...(fb || {}) });
    }
    if (!API_KEY) {
      diag.warning = "Missing GOOGLE_API_KEY env var; will skip API and try CSV fallback.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "No API key; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
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
      // If API fails, try CSV fallback next
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Sheets API failed; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    // ===== Step 3: Parse headers & rows =====
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

    // ===== Step 4: Build questions (aggregation) =====
    const questions = buildQuestionsFromHeadersAndRows(headers, rows);
    if (!questions.length) {
      diag.aggregation_note = "Aggregation produced 0 questions; trying CSV fallback for comparison.";
      const fb = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Aggregation empty; CSV fallback attempted", diagnostics: diag, ...(fb || {}) });
    }

    return ok({ success: true, message: "Tallied (API path)", questions, diagnostics: diag });

  } catch (err) {
    diag.unhandled = String(err?.message || err);
    return new Response(JSON.stringify({ success: false, message: "Unhandled error", diagnostics: diag, stack: err?.stack }, null, 2), {
      status: 200, // force 200 so you can read it in the browser
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
   Aggregation (your rules)
   ========================= */
function buildQuestionsFromHeadersAndRows(headers, rows) {
  // find columns by header substrings (safer than hardcoding)
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

  // helpers
  const get = (row, i) => String((row[i] || '')).trim();
  const splitMulti = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

  // tally helpers
  const tally = () => Object.create(null);
  const inc = (m, k) => { m[k] = (m[k] || 0) + 1; };

  // 1) AI usage (multi)
  if (idx.aiUsage > -1) {
    const map = Object.create(null); CANONICAL.aiUsage.forEach(v => map[v] = 0);
    const other = [];
    rows.forEach(r => {
      splitMulti(get(r, idx.aiUsage)).forEach(sel => {
        const m = CANONICAL.aiUsage.find(o => o.toLowerCase() === sel.toLowerCase());
        if (m) inc(map, m); else if (!/^\(empty\)|^na$/i.test(sel)) other.push(sel);
      });
    });
    pushQuestion(questions, "How are you using AI in your work today?", map, other, 'multiple_choice');
  }

  // 2) Go-to tool (normalize; group <20% into Other)
  if (idx.goToTool > -1) {
    const map = tally();
    rows.forEach(r => {
      const raw = get(r, idx.goToTool);
      const items = splitMulti(raw);
      (items.length ? items : [raw]).forEach(x => {
        const n = normalizeTool(x);
        if (n) inc(map, n);
      });
    });
    const { rows:resp, total } = tallyMapToResponses(map);
    if (total) {
      const popular = resp.filter(r => r.percentage >= 20);
      const small   = resp.filter(r => r.percentage < 20);
      if (small.length) {
        const oc = small.reduce((s, r) => s + r.count, 0);
        popular.push({ text: "Other", count: oc, percentage: Math.round((oc / total) * 100) });
      }
      questions.push({
        question: "What's your go-to AI tool?",
        type: "single_choice",
        responses: popular,
        total_responses: total,
        ...(small.length ? { other_responses: small.map(r => r.text).join(', ') } : {})
      });
    }
  }

  // 3) Confidence 1–5
  if (idx.confidence > -1) {
    const map = { "1":0,"2":0,"3":0,"4":0,"5":0 };
    rows.forEach(r => {
      const n = Number(get(r, idx.confidence));
      if (n >= 1 && n <= 5) map[String(n)] += 1;
    });
    const total = Object.values(map).reduce((s,n)=>s+n,0);
    if (total) {
      const responses = Object.keys(map).map(k => ({
        text: k, count: map[k], percentage: Math.round((map[k] / total) * 100)
      }));
      questions.push({ question: "How confident are you in using AI tools in your creator marketing work? (1–5)", type: "scale", responses, total_responses: total });
    }
  }

  // 4) Curiosity (multi)
  if (idx.curiosity > -1) {
    const map = Object.create(null); CANONICAL.aiCuriosity.forEach(v => map[v] = 0);
    const other = [];
    rows.forEach(r => {
      splitMulti(get(r, idx.curiosity)).forEach(sel => {
        const m = CANONICAL.aiCuriosity.find(o => o.toLowerCase() === sel.toLowerCase());
        if (m) inc(map, m); else if (!/^\(empty\)|^na$/i.test(sel)) other.push(sel);
      });
    });
    pushQuestion(questions, "Which areas of AI are you most curious to learn more about this season?", map, other, 'multiple_choice');
  }

  // 5) Top priority (single)
  if (idx.topPriority > -1) {
    const map = tally();
    rows.forEach(r => { const v = get(r, idx.topPriority); if (v) inc(map, v); });
    pushQuestion(questions, "What's your top priority for this season?", map, [], 'single_choice');
  }

  // 6) Creator marketing areas (multi)
  if (idx.creatorAreas > -1) {
    const map = Object.create(null); CANONICAL.creatorAreas.forEach(v => map[v] = 0);
    const other = [];
    rows.forEach(r => {
      splitMulti(get(r, idx.creatorAreas)).forEach(sel => {
        const m = CANONICAL.creatorAreas.find(o => o.toLowerCase() === sel.toLowerCase());
        if (m) inc(map, m); else if (!/^\(empty\)|^na$/i.test(sel)) other.push(sel);
      });
    });
    pushQuestion(questions, "Which areas of creator marketing are you testing AI tools for?", map, other, 'multiple_choice');
  }

  return questions;
}

function pushQuestion(arr, title, countsMap, otherList, type) {
  const { rows, total } = tallyMapToResponses(countsMap);
  if (!total) return;
  arr.push({
    question: title,
    type,
    responses: rows,
    total_responses: total,
    ...(otherList && otherList.length ? { other_responses: otherList.join(', ') } : {})
  });
}

/* ---------- misc helpers ---------- */
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
  const t = String(s||'').toLowerCase();
  if(!t) return '';
  if (t==='gpt' || t.includes('chat gpt') || t.includes('chatgpt') || t.includes('openai')) return 'ChatGPT';
  if (t.includes('claude')) return 'Claude';
  if (t.includes('gemini') || t.includes('bard')) return 'Gemini';
  if (t.includes('gamma')) return 'Gamma';
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
function tallyMapToResponses(map){
  const total = Object.values(map).reduce((s,n)=>s+Number(n||0),0);
  const rows = Object.entries(map)
    .map(([text,count]) => ({ text, count: Number(count||0), percentage: total>0 ? Math.round((count/total)*100) : 0 }))
    .filter(r => r.count > 0)
    .sort((a,b)=>b.count-a.count);
  return { rows, total };
}

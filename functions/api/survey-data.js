// functions/api/survey-data.js — display-aware + diagnostics (Q1 fixes)

export async function onRequest(context) {
  const diag = {
    runtime: "Cloudflare Pages Functions",
    now: new Date().toISOString(),
    env_present: {
      SHEET_ID: !!(context.env && context.env.SHEET_ID),
      GOOGLE_API_KEY: !!(context.env && context.env.GOOGLE_API_KEY),
      SHEET_NAME: !!(context.env && context.env.SHEET_NAME)
    },
    steps: []
  };

  try {
    const SHEET_ID = context.env.SHEET_ID;
    const API_KEY = context.env.GOOGLE_API_KEY;
    const SHEET_NAME = context.env.SHEET_NAME || "Sheet1";

    const ok = function (obj) {
      return new Response(JSON.stringify(obj, null, 2), {
        headers: { "content-type": "application/json" }
      });
    };

    // 1) env check
    diag.steps.push("check-env");
    if (!SHEET_ID) {
      diag.error = "Missing SHEET_ID env var.";
      const fb = await tryCsvFallback(diag, { SHEET_ID: "", SHEET_GID: "0" });
      return ok({ success: false, message: "Env missing", diagnostics: diag, questions: fb.questions });
    }
    if (!API_KEY) {
      diag.warning = "Missing GOOGLE_API_KEY; trying CSV fallback.";
      const fb2 = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "No API key; CSV fallback", diagnostics: diag, questions: fb2.questions });
    }

    // 2) fetch from Sheets API
    diag.steps.push("fetch-sheets-api");
    const range = encodeURIComponent(SHEET_NAME + "!A1:V2000");
    const url = "https://sheets.googleapis.com/v4/spreadsheets/" + SHEET_ID + "/values/" + range + "?key=" + API_KEY;

    let apiJson;
    try {
      const r = await fetch(url);
      diag.sheets_api_status = String(r.status) + " " + r.statusText;
      if (!r.ok) throw new Error("Sheets API error: " + r.status + " " + r.statusText);
      apiJson = await r.json();
    } catch (e) {
      diag.sheets_api_error = String(e && e.message ? e.message : e);
      const fb3 = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Sheets API failed; CSV fallback", diagnostics: diag, questions: fb3.questions });
    }

    // 3) parse rows
    diag.steps.push("parse-api-values");
    const values = Array.isArray(apiJson && apiJson.values) ? apiJson.values : [];
    diag.row_count = values.length;

    const headerIndex = values.findIndex(function (row) {
      return (row || []).some(function (cell) { return String(cell || "").trim().length > 0; });
    });
    if (headerIndex === -1) {
      diag.parse_error = "No non-empty rows found.";
      const fb4 = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "No non-empty rows; CSV fallback", diagnostics: diag, questions: fb4.questions });
    }

    const headers = values[headerIndex].map(function (v) { return String(v || "").trim(); });
    const rows = values.slice(headerIndex + 1);
    diag.detected_header_row = headerIndex + 1;
    diag.detected_headers_preview = headers.slice(0, 12);

    // 4) build questions (display-aware)
    const questions = buildQuestionsFromHeadersAndRows(headers, rows);
    if (!questions.length) {
      diag.aggregation_note = "Aggregation produced 0 questions.";
      const fb5 = await tryCsvFallback(diag, { SHEET_ID, SHEET_GID: "0" });
      return ok({ success: false, message: "Aggregation empty; CSV fallback", diagnostics: diag, questions: fb5.questions });
    }

    return ok({ success: true, message: "Tallied (API path, display-aware)", questions: questions, diagnostics: diag });
  } catch (err) {
    diag.unhandled = String(err && err.message ? err.message : err);
    return new Response(
      JSON.stringify({ success: false, message: "Unhandled error", diagnostics: diag, stack: err && err.stack ? err.stack : "" }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
}

/* ---------- CSV fallback ---------- */
async function tryCsvFallback(diag, cfg) {
  const out = { questions: [] };
  try {
    diag.steps.push("csv-fallback");
    if (!cfg.SHEET_ID) throw new Error("No SHEET_ID for CSV fallback.");
    const url = "https://docs.google.com/spreadsheets/d/" + cfg.SHEET_ID + "/export?format=csv&gid=" + encodeURIComponent(cfg.SHEET_GID || "0");
    const r = await fetch(url);
    diag.csv_status = String(r.status) + " " + r.statusText;
    if (!r.ok) throw new Error("CSV fallback error: " + r.status + " " + r.statusText);
    const csv = await r.text();
    const parsed = parseCsv(csv);
    diag.csv_headers_preview = parsed.headers.slice(0, 12);
    out.questions = buildQuestionsFromHeadersAndRows(parsed.headers, parsed.rows);
  } catch (e) {
    diag.csv_error = String(e && e.message ? e.message : e);
  }
  return out;
}

/* ---------- Display config (exact labels/order) ---------- */
var DISPLAY_CONFIG = {
  aiUsage: {
    title: "Which of the following best describes how you're using AI in your work today? (select all that apply)",
    order: [
      "Discovering or researching creators",
      "Drafting or reviewing creative briefs",
      "Writing emails, captions, or campaign copy",
      "Analyzing campaign results",
      "Generating images or video",
      "I'm not using AI at work yet"
    ],
    type: "multiple_choice"
  },
  goToTool: {
    title: "What's your go-to AI tool (if any) in your current workflow?",
    type: "single_choice"
  },
  confidence: {
    title: "How confident are you in using AI tools in your creator marketing work?",
    scale: ["1", "2", "3", "4", "5"],
    type: "scale"
  },
  curiosity: {
    title: "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
    order: [
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
    type: "multiple_choice"
  },
  topPriority: {
    title: "What's your top priority for this season? (pick 1)",
    order: [
      "Learning from guest speakers",
      "Swapping tactics/tools with peers",
      "Discovering new AI use cases",
      "Connecting 1:1 with others in similar roles",
      "Having a regular space to reflect and stay sharp"
    ],
    type: "single_choice"
  },
  creatorAreas: {
    title: "Which areas of creator marketing would you be most interested in testing AI tools for?",
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
      "Internal Knowledge Systems & Institutional Memory"
    ],
    type: "multiple_choice"
  }
};

// optional aliases to improve matching of free-typed variants
const ALIASES = {
  "AI for campaign planning & briefing": ["AI for campaign planning and briefing", "campaign planning & briefing"],
  "AI assistants & internal tooling": ["AI assistants and internal tooling", "assistants & tooling"],
  "AI for creator discovery": ["creator discovery", "ai for discovery"],
  "AI and the future of creator platforms": ["future of creator platforms", "creator platforms (future)"],
  "AI for reviewing creator content": ["reviewing creator content", "content review (ai)"]
};

/* ---------- Aggregation ---------- */
function buildQuestionsFromHeadersAndRows(headers, rows) {
  var idx = indexByHeader(headers, {
    aiUsage: "Which of the following best describes",
    goToTool: "What's your go-to AI tool",
    confidence: "How confident are you",
    curiosity: "Which areas of AI are you most curious",
    topPriority: "What's your top priority for this season",
    creatorAreas: "Which areas of creator marketing"
  });

  var questions = [];
  var respondentIdx = findRespondentIdIndex(headers);

  var get = function (row, i) { return String((row[i] || "")).trim(); };

  // 1) AI usage (multi; substring based; unique respondent denominator; cleaned verbatims)
  if (idx.aiUsage > -1) {
    var orderUsage = DISPLAY_CONFIG.aiUsage.order;
    var countsUsage = {};
    orderUsage.forEach(function (o) { countsUsage[o] = 0; });
    var othersUsage = [];

    rows.forEach(function (r) {
      var res = matchCanonicalOptions(get(r, idx.aiUsage), orderUsage);
      res.hits.forEach(function (h) { countsUsage[h] += 1; });
      othersUsage = othersUsage.concat(res.leftovers);
    });

    var answeredUsage = respondentsWhoAnswered(rows, idx.aiUsage, respondentIdx).size;
    othersUsage = cleanOtherTextList(othersUsage);

    pushOrderedWithOther(questions, "aiUsage", countsUsage, othersUsage, answeredUsage, orderUsage);
  }

  // 2) Go-to tool (normalize; show any tool >=10% of respondents; group rest as Other)
  if (idx.goToTool > -1) {
    var mapTool = {};
    rows.forEach(function (r) {
      var raw = get(r, idx.goToTool);
      var items = raw.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      (items.length ? items : [raw]).forEach(function (x) {
        var n = normalizeTool(x);
        if (n) mapTool[n] = (mapTool[n] || 0) + 1;
      });
    });

    var totalTool = respondentsWhoAnswered(rows, idx.goToTool, respondentIdx).size;
    if (totalTool) {
      var tallied = Object.keys(mapTool)
        .map(function (k) { return { text: k, count: mapTool[k], percentage: Math.round((mapTool[k] / totalTool) * 100) }; })
        .sort(function (a, b) { return b.count - a.count; });

      var keep = tallied.filter(function (r) { return r.percentage >= 10; });
      var small = tallied.filter(function (r) { return r.percentage < 10; });

      var otherList = small.map(function (r) { return r.text; });
      if (small.length) {
        var oc = small.reduce(function (s, r) { return s + r.count; }, 0);
        keep.push({ text: "Other", count: oc, percentage: Math.round((oc / totalTool) * 100) });
      }

      questions.push({
        question: DISPLAY_CONFIG.goToTool.title,
        type: DISPLAY_CONFIG.goToTool.type,
        responses: keep,
        total_responses: totalTool,
        other_responses: otherList.length ? otherList.join(", ") : undefined
      });
    }
  }

  // 3) Confidence 1–5 (unchanged)
  if (idx.confidence > -1) {
    var orderScale = DISPLAY_CONFIG.confidence.scale;
    var mapConf = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    rows.forEach(function (r) {
      var n = Number(get(r, idx.confidence));
      if (n >= 1 && n <= 5) mapConf[String(n)] += 1;
    });
    var totalConf = Object.values(mapConf).reduce(function (s, n) { return s + n; }, 0);
    if (totalConf) {
      var responsesConf = orderScale.map(function (k) {
        return { text: k, count: mapConf[k], percentage: Math.round((mapConf[k] / totalConf) * 100) };
      });
      questions.push({
        question: DISPLAY_CONFIG.confidence.title + " (1–5)",
        type: DISPLAY_CONFIG.confidence.type,
        responses: responsesConf,
        total_responses: totalConf
      });
    }
  }

  // 4) Curiosity (multi; alias matching; unique respondent denominator; cleaned verbatims)
  if (idx.curiosity > -1) {
    var orderCur = DISPLAY_CONFIG.curiosity.order;
    var countsCur = {};
    orderCur.forEach(function (o) { countsCur[o] = 0; });
    var othersCur = [];

    rows.forEach(function (r) {
      var resCur = matchCanonicalOptions(get(r, idx.curiosity), orderCur);
      resCur.hits.forEach(function (h) { countsCur[h] += 1; });
      othersCur = othersCur.concat(resCur.leftovers);
    });

    var answeredCur = respondentsWhoAnswered(rows, idx.curiosity, respondentIdx).size;
    othersCur = cleanOtherTextList(othersCur);

    pushOrderedWithOther(questions, "curiosity", countsCur, othersCur, answeredCur, orderCur);
  }

  // 5) Top priority (single)
  if (idx.topPriority > -1) {
    var orderTop = DISPLAY_CONFIG.topPriority.order;
    var countsTop = {};
    orderTop.forEach(function (o) { countsTop[o] = 0; });

    rows.forEach(function (r) {
      var v = get(r, idx.topPriority);
      if (v) countsTop[v] = (countsTop[v] || 0) + 1;
    });

    var answeredTop = respondentsWhoAnswered(rows, idx.topPriority, respondentIdx).size;
    pushOrderedWithOther(questions, "topPriority", countsTop, [], answeredTop, orderTop);
  }

  // 6) Creator marketing areas (multi; alias matching; unique denominator; cleaned verbatims)
  if (idx.creatorAreas > -1) {
    var orderAreas = DISPLAY_CONFIG.creatorAreas.order;
    var countsAreas = {};
    orderAreas.forEach(function (o) { countsAreas[o] = 0; });
    var othersAreas = [];

    rows.forEach(function (r) {
      var resA = matchCanonicalOptions(get(r, idx.creatorAreas), orderAreas);
      resA.hits.forEach(function (h) { countsAreas[h] += 1; });
      othersAreas = othersAreas.concat(resA.leftovers);
    });

    var answeredAreas = respondentsWhoAnswered(rows, idx.creatorAreas, respondentIdx).size;
    othersAreas = cleanOtherTextList(othersAreas);

    pushOrderedWithOther(questions, "creatorAreas", countsAreas, othersAreas, answeredAreas, orderAreas);
  }

  return questions;
}

/* ---------- helpers ---------- */
function indexByHeader(headers, needles) {
  function find(needle) {
    return headers.findIndex(function (h) { return h.toLowerCase().indexOf(needle.toLowerCase()) !== -1; });
  }
  var out = {};
  Object.keys(needles).forEach(function (k) { out[k] = find(needles[k]); });
  return out;
}

function findRespondentIdIndex(headers) {
  return headers.findIndex(function (h) { return h.toLowerCase().includes("respondent id"); });
}

function respondentsWhoAnswered(rows, colIdx, respondentIdx) {
  if (colIdx < 0) return new Set();
  const set = new Set();
  rows.forEach(function (r) {
    const ans = String(r[colIdx] || "").trim();
    if (ans) {
      const rid = respondentIdx >= 0 ? String(r[respondentIdx] || "").trim() : "";
      set.add(rid || "__row_" + Math.random());
    }
  });
  return set;
}

// Match canonical options by substring (case-insensitive) + alias support.
// Leftovers (non-canonical text) are returned for "Other responses".
function matchCanonicalOptions(answer, canonicalList) {
  const a = String(answer || "");
  const lower = a.toLowerCase();
  const hits = new Set();
  let consumed = a;

  canonicalList.forEach(function (opt) {
    const names = [opt].concat(ALIASES[opt] || []);
    const matched = names.some(function (name) {
      return lower.indexOf(String(name).toLowerCase()) !== -1;
    });
    if (matched) {
      hits.add(opt);
      const re = new RegExp(opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      consumed = consumed.replace(re, "");
    }
  });

  const leftovers = consumed
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 1 && !/^other\b[:\-\s]*$/i.test(s) && !/^\(empty\)|^na$/i.test(s); });

  return { hits: Array.from(hits), leftovers: leftovers };
}

function cleanOtherTextList(list) {
  const out = [];
  list.forEach(function (s) {
    let t = String(s || "").trim();
    if (!t) return;
    if (/^other\b[:\-\s]*$/i.test(t)) return; // plain "Other"
    t = t.replace(/^other\b[:\-\s]*/i, "");
    t = t.replace(/^[-–—:\s]+/, "");
    t = t.replace(/^"(.+)"$/, "$1").trim();
    if (t && !/^\(empty\)|^na$/i.test(t)) out.push(t);
  });
  return Array.from(new Set(out));
}

function parseCsv(text) {
  var lines = text.split("\n").filter(function (l) { return l.trim().length > 0; });
  if (lines.length < 2) return { headers: [], rows: [] };
  var headers = splitCsvLine(lines[0]).map(function (h) { return h.replace(/"/g, "").trim(); });
  var rows = lines.slice(1).map(splitCsvLine);
  return { headers: headers, rows: rows };
}

function splitCsvLine(line) {
  var out = [];
  var cur = "";
  var q = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') q = !q;
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(function (s) { return s.trim(); });
}

function normalizeTool(s) {
  var t = String(s || "").toLowerCase().trim();
  if (!t) return "";
  if (t === "gpt" || t.indexOf("chat gpt") !== -1 || t.indexOf("chatgpt") !== -1 || t.indexOf("openai") !== -1) return "ChatGPT";
  if (t.indexOf("claude") !== -1) return "Claude";
  if (t.indexOf("gemini") !== -1 || t.indexOf("bard") !== -1) return "Gemini";
  if (t.indexOf("gamma") !== -1) return "Gamma";
  if (t.indexOf("don’t have") !== -1 || t.indexOf("dont have") !== -1 || t === "none" || t.indexOf("no tool") !== -1) return "None";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function tallyMapToResponses(map) {
  var total = Object.values(map).reduce(function (s, n) { return s + Number(n || 0); }, 0);
  var rows = Object.keys(map)
    .map(function (text) {
      var count = Number(map[text] || 0);
      return { text: text, count: count, percentage: total > 0 ? Math.round((count / total) * 100) : 0 };
    })
    .filter(function (r) { return r.count > 0; })
    .sort(function (a, b) { return b.count - a.count; });
  return { rows: rows, total: total };
}

// Push ordered responses and append an "Other" bar for verbatims (if any)
function pushOrderedWithOther(arr, cfgKey, countsMap, otherList, respondentsTotal, order) {
  var cfg = DISPLAY_CONFIG[cfgKey];
  if (!cfg || !respondentsTotal) return;

  var responses = [];
  (order || Object.keys(countsMap)).forEach(function (label) {
    var count = Number(countsMap[label] || 0);
    if (count > 0) {
      responses.push({
        text: label,
        count: count,
        percentage: Math.round((count / respondentsTotal) * 100)
      });
    }
  });

  var verbatim = (otherList || []).filter(Boolean);
  if (verbatim.length) {
    responses.push({
      text: "Other",
      count: verbatim.length,
      percentage: Math.round((verbatim.length / respondentsTotal) * 100)
    });
  }

  arr.push({
    question: cfg.title,
    type: cfg.type,
    responses: responses,
    total_responses: respondentsTotal,
    other_responses: verbatim.length ? verbatim.join(", ") : undefined
  });
}

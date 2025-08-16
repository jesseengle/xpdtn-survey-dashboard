// functions/api/survey-data.js
// Cloudflare Pages Function: builds Tally-like results from a Google Sheet
// Env vars required in Cloudflare Pages > Settings > Variables:
//   - SHEET_ID        (required)  e.g. 1V3VpMGqEFC_qEa03om5bgSHQ8yQ0O-VIHAIi_DG0FHw
//   - GOOGLE_API_KEY  (required)  (restrict by HTTP referrer to your *.pages.dev / domain)
//   - SHEET_NAME      (optional)  default "Sheet1"

export async function onRequest(context) {
  const SHEET_ID   = context.env.SHEET_ID;
  const API_KEY    = context.env.GOOGLE_API_KEY;
  const SHEET_NAME = context.env.SHEET_NAME || "Sheet1";

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (!SHEET_ID) {
    return json({ success: false, message: "Missing SHEET_ID env var.", questions: [] }, 200);
  }
  if (!API_KEY) {
    // We keep status 200 so the browser can read the diagnostics easily
    return json({ success: false, message: "Missing GOOGLE_API_KEY env var.", questions: [] }, 200);
  }

  // 1) Fetch values via Sheets API (A1:V2000 covers your current columns)
  const range = encodeURIComponent(`${SHEET_NAME}!A1:V2000`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;

  let values = [];
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
    const data = await r.json();
    values = Array.isArray(data.values) ? data.values : [];
  } catch (err) {
    return json({ success: false, message: String(err), questions: [] }, 200);
  }

  if (!values.length) {
    return json({ success: true, message: "Empty sheet.", questions: [] }, 200);
  }

  // 2) Detect header row & split
  const headerIndex = values.findIndex(row => (row || []).some(cell => String(cell || "").trim().length));
  if (headerIndex < 0) {
    return json({ success: true, message: "No header row found.", questions: [] }, 200);
  }
  const headers = values[headerIndex].map(h => String(h || "").trim());
  const rows    = values.slice(headerIndex + 1);

  // 3) Map interesting columns by header substring (robust to minor edits)
  const col = indexByHeader(headers, {
    aiUsage:   "Which of the following best describes", // multi-select
    goToTool:  "What’s your go-to AI tool",             // single text, normalize
    confidence:"How confident are you",                  // 1-5
    curiosity: "Which areas of AI are you most curious", // multi-select
    // topPriority intentionally omitted for now (not in your screenshots)
    creatorAreas: "Which areas of creator marketing",    // multi-select
  });

  // 4) Canonical option lists (order matters for display)
  const CANONICAL = {
    aiUsage: [
      "Discovering or researching creators",
      "Drafting or reviewing creative briefs",
      "Writing emails, captions, or campaign copy",
      "Analyzing campaign results",
      "Generating images or video",
      "I'm not using AI at work yet",
    ],
    curiosity: [
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
  };

  const questions = [];

  // ----- Q1: AI Usage (multi) -----
  if (col.aiUsage > -1) {
    const { map, total, otherList } = tallyMulti(rows, col.aiUsage, CANONICAL.aiUsage);
    questions.push(buildQuestion(
      "Which of the following best describes how you're using AI in your work today? (select all that apply)",
      "multiple_choice", map, total, otherList
    ));
  }

  // ----- Q2: Go-to Tool (normalize; include tools >=10%, bucket the rest into Other + list verbatims) -----
  if (col.goToTool > -1) {
    const counts = Object.create(null);
    const totalRespondents = countNonEmpty(rows, col.goToTool);

    rows.forEach(r => {
      const raw = get(r, col.goToTool);
      const parts = splitMulti(raw); // sometimes people comma-separate
      (parts.length ? parts : [raw]).forEach((token) => {
        const name = normalizeTool(token);
        if (!name) return;
        counts[name] = (counts[name] || 0) + 1;
      });
    });

    const resp = mapToResponses(counts, totalRespondents);
    const popular = resp.filter(x => x.percentage >= 10);
    const small   = resp.filter(x => x.percentage < 10);

    if (small.length) {
      const otherCount = small.reduce((s, r) => s + r.count, 0);
      popular.push({
        text: "Other",
        count: otherCount,
        percentage: totalRespondents ? Math.round((otherCount / totalRespondents) * 100) : 0,
      });
    }

    questions.push({
      question: "What's your go-to AI tool?",
      type: "single_choice",
      responses: popular.sort((a,b) => b.count - a.count),
      total_responses: totalRespondents,
      ...(small.length ? { other_responses: small.map(r => r.text).join(', ') } : {}),
    });
  }

  // ----- Q3: Confidence (1–5) -----
  if (col.confidence > -1) {
    const map = { "1":0,"2":0,"3":0,"4":0,"5":0 };
    rows.forEach(r => {
      const n = Number(get(r, col.confidence));
      if (n >= 1 && n <= 5) map[String(n)] += 1;
    });
    const total = Object.values(map).reduce((s, n) => s + n, 0);
    questions.push({
      question: "How confident are you in using AI tools in your creator marketing work? (1–5)",
      type: "scale",
      responses: Object.keys(map).map(k => ({
        text: k,
        count: map[k],
        percentage: total ? Math.round((map[k] / total) * 100) : 0,
      })),
      total_responses: total,
    });
  }

  // ----- Q4: Curiosity (multi) -----
  if (col.curiosity > -1) {
    const { map, total, otherList } = tallyMulti(rows, col.curiosity, CANONICAL.curiosity);
    questions.push(buildQuestion(
      "Which areas of AI are you most curious to learn more about this season? (pick top 3)",
      "multiple_choice", map, total, otherList
    ));
  }

  // ----- Q5: Creator areas for testing (multi) -----
  if (col.creatorAreas > -1) {
    const { map, total, otherList } = tallyMulti(rows, col.creatorAreas, CANONICAL.creatorAreas);
    questions.push(buildQuestion(
      "Which areas of creator marketing would you be most interested in testing AI tools for?",
      "multiple_choice", map, total, otherList
    ));
  }

  return json({
    success: true,
    message: "Tallied (API path, display-aware)",
    questions,
  });
}

/* ===================== helpers ===================== */

const get = (row, i) => String((row[i] || "")).trim();
const splitMulti = (s) => String(s || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

function indexByHeader(headers, needles) {
  const find = (needle) =>
    headers.findIndex(h => h.toLowerCase().includes(needle.toLowerCase()));
  return Object.fromEntries(
    Object.entries(needles).map(([k, n]) => [k, find(n)])
  );
}

function countNonEmpty(rows, colIdx) {
  let n = 0;
  rows.forEach(r => { if (get(r, colIdx)) n += 1; });
  return n;
}

function tallyMulti(rows, colIdx, canonicalList) {
  const map = Object.create(null);
  canonicalList.forEach(v => (map[v] = 0));
  const other = [];
  let answered = 0;

  rows.forEach(r => {
    const raw = get(r, colIdx);
    if (!raw) return;
    answered += 1;

    splitMulti(raw).forEach(sel => {
      const match = canonicalList.find(
        opt => opt.toLowerCase() === sel.toLowerCase()
      );
      if (match) {
        map[match] += 1;
      } else if (!/^\(empty\)|^na$/i.test(sel)) {
        other.push(sel);
      }
    });
  });

  return { map, total: answered, otherList: other };
}

function mapToResponses(map, totalRespondents) {
  return Object.entries(map)
    .map(([text, count]) => ({
      text,
      count: Number(count || 0),
      percentage: totalRespondents ? Math.round((Number(count || 0) / totalRespondents) * 100) : 0,
    }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

function buildQuestion(title, type, countsMap, totalRespondents, otherList) {
  const responses = Object.keys(countsMap)
    .map((key) => ({
      text: key,
      count: countsMap[key],
      percentage: totalRespondents ? Math.round((countsMap[key] / totalRespondents) * 100) : 0,
    }))
    .filter(r => r.count > 0)
    .sort((a,b) => b.count - a.count);

  // If any option literally equals "Other", show its count as a bar but still print verbatims, too.
  const hasOther = responses.some(r => r.text.toLowerCase() === "other");
  const payload = {
    question: title,
    type,
    responses,
    total_responses: totalRespondents,
  };
  if (otherList && otherList.length) {
    payload.other_responses = otherList.join(', ');
    // If there is NOT an "Other" canonical option, we still want to summarize the off-canon entries as a single "Other" bar.
    if (!hasOther) {
      const otherCount = otherList.length;
      payload.responses.push({
        text: "Other",
        count: otherCount,
        percentage: totalRespondents ? Math.round((otherCount / totalRespondents) * 100) : 0,
      });
      payload.responses.sort((a,b)=>b.count-a.count);
    }
  }
  return payload;
}

function normalizeTool(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  const low = t.toLowerCase();
  if (low === "gpt" || low.includes("chatgpt") || low.includes("chat gpt") || low.includes("openai")) return "ChatGPT";
  if (low.includes("claude"))  return "Claude";
  if (low.includes("gemini") || low.includes("bard")) return "Gemini";
  if (low.includes("gamma"))   return "Gamma";
  if (low.includes("spotter")) return "Spotter Studio";
  if (low.includes("heygen"))  return "Heygen";
  if (low.includes("sora"))    return "Sora";
  if (low.includes("don’t") || low.includes("dont") || low.includes("do not") || low.includes("none") || low.includes("no ai")) return "Don’t have one";
  // Title-case fallback (first char uppercase)
  return t[0].toUpperCase() + t.slice(1);
}

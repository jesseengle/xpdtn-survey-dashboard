// functions/api/survey-data.js  (aggregated, UI-ready)
export async function onRequest(context) {
  try {
    const SHEET_ID   = context.env.SHEET_ID;
    const API_KEY    = context.env.GOOGLE_API_KEY;
    const SHEET_NAME = context.env.SHEET_NAME || 'Sheet1';
    if (!SHEET_ID || !API_KEY) return jsonError('Missing SHEET_ID or GOOGLE_API_KEY.');

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_NAME + '!A1:V2000')}?key=${API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return jsonError(`Sheets API ${r.status} ${r.statusText}`);
    const js = await r.json();
    const values = js.values || [];

    // header detection (first non-empty row)
    const headerIndex = values.findIndex(row => (row || []).some(cell => String(cell || '').trim().length));
    if (headerIndex === -1) return jsonOk({ success:true, questions: [] });

    const headers = values[headerIndex].map(v => String(v || '').trim());
    const rows = values.slice(headerIndex + 1);

    // locate the columns by header text (safer than hardcoding)
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

    // 1) AI usage (multi-select)
    if (idx.aiUsage > -1) {
      questions.push(tallyCanonicalMulti(
        "How are you using AI in your work today?",
        rows, idx.aiUsage, CANONICAL.aiUsage
      ));
    }

    // 2) Go-to tool (free text, normalize, group <20% into Other)
    if (idx.goToTool > -1) {
      questions.push(tallyGoToTool(
        "What's your go-to AI tool?",
        rows, idx.goToTool
      ));
    }

    // 3) Confidence 1–5
    if (idx.confidence > -1) {
      questions.push(tallyScale(
        "How confident are you in using AI tools in your creator marketing work? (1–5)",
        rows, idx.confidence
      ));
    }

    // 4) Curiosity (multi-select, canonical)
    if (idx.curiosity > -1) {
      questions.push(tallyCanonicalMulti(
        "Which areas of AI are you most curious to learn more about this season?",
        rows, idx.curiosity, CANONICAL.aiCuriosity
      ));
    }

    // 5) Top priority (single)
    if (idx.topPriority > -1) {
      questions.push(tallySingle(
        "What's your top priority for this season?",
        rows, idx.topPriority, CANONICAL.topPriority
      ));
    }

    // 6) Creator marketing areas (multi-select, canonical)
    if (idx.creatorAreas > -1) {
      questions.push(tallyCanonicalMulti(
        "Which areas of creator marketing are you testing AI tools for?",
        rows, idx.creatorAreas, CANONICAL.creatorAreas
      ));
    }

    // drop empties
    const clean = questions.filter(q => q && q.responses && q.responses.length);

    return jsonOk({ success:true, message:'Tallied', questions: clean });

  } catch (e) {
    return jsonError(e.message || String(e));
  }
}

/* ---------- helpers ---------- */
function indexByHeader(headers, needles) {
  const find = (needle) => headers.findIndex(h => h.toLowerCase().includes(needle.toLowerCase()));
  return Object.fromEntries(Object.entries(needles).map(([k, n]) => [k, find(n)]));
}
function getCell(row, idx){ return String((row[idx]||'')).trim(); }
function splitMulti(s){ return String(s||'').split(',').map(x=>x.trim()).filter(Boolean); }
function normalizeTool(s){
  const t=String(s||'').toLowerCase();
  if(!t) return '';
  if(t==='gpt'||t.includes('chat gpt')||t.includes('chatgpt')||t.includes('openai')) return 'ChatGPT';
  if(t.includes('claude')) return 'Claude';
  if(t.includes('gemini')||t.includes('bard')) return 'Gemini';
  if(t.includes('gamma')) return 'Gamma';
  return s.charAt(0).toUpperCase()+s.slice(1);
}
function tallyMapToResponses(map){
  const total = Object.values(map).reduce((s,n)=>s+Number(n||0),0);
  const rows = Object.entries(map).map(([text,count])=>({
    text, count: Number(count||0), percentage: total>0 ? Math.round((count/total)*100) : 0
  }));
  rows.sort((a,b)=>b.count-a.count);
  return { rows, total };
}

function tallyCanonicalMulti(title, rows, idx, canonical){
  const map = Object.create(null); canonical.forEach(op => map[op]=0);
  const others = [];
  rows.forEach(r=>{
    const items = splitMulti(getCell(r, idx));
    items.forEach(sel=>{
      const m = canonical.find(c => c.toLowerCase() === sel.toLowerCase());
      if (m) map[m] += 1;
      else if(sel && !/^\(empty\)|^na$/i.test(sel)) others.push(sel);
    });
  });
  const { rows:responses, total } = tallyMapToResponses(map);
  if (!total) return null;
  return { question: title, type: 'multiple_choice', responses, total_responses: total, ...(others.length?{other_responses: others.join(', ')}:{}) };
}

function tallyGoToTool(title, rows, idx){
  const map = Object.create(null);
  rows.forEach(r=>{
    const raw = getCell(r, idx);
    const items = splitMulti(raw);
    (items.length?items:[raw]).forEach(x=>{
      const n = normalizeTool(x);
      if (n) map[n] = (map[n]||0)+1;
    });
  });
  const { rows:responses, total } = tallyMapToResponses(map);
  if (!total) return null;

  const popular = responses.filter(r=>r.percentage>=20);
  const small   = responses.filter(r=>r.percentage<20);
  if (small.length){
    const otherCount = small.reduce((s,r)=>s+r.count,0);
    popular.push({ text:'Other', count: otherCount, percentage: total>0?Math.round(otherCount/total*100):0 });
  }
  return { question: title, type: 'single_choice', responses: popular, total_responses: total, ...(small.length?{other_responses: small.map(r=>r.text).join(', ')}:{}) };
}

function tallyScale(title, rows, idx){
  const map = { '1':0,'2':0,'3':0,'4':0,'5':0 };
  rows.forEach(r=>{
    const n = Number(getCell(r, idx));
    if (n>=1 && n<=5) map[String(n)] += 1;
  });
  const total = Object.values(map).reduce((s,n)=>s+n,0);
  if (!total) return null;
  const responses = Object.keys(map).map(k=>({ text:k, count:map[k], percentage: Math.round(map[k]/total*100)}));
  return { question:title, type:'scale', responses, total_responses: total };
}

function jsonOk(obj){ return new Response(JSON.stringify(obj, null, 2), { headers:{'content-type':'application/json'} }); }
function jsonError(message, code=500){ return new Response(JSON.stringify({ success:false, error:message }), { status:code, headers:{'content-type':'application/json'} }); }

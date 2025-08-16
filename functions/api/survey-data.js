// Final working function - functions/api/survey-data.js

export async function onRequestGet(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    // Your Google Sheet ID
    const SHEET_ID = '1V3VpMGqEFC_qEa03om5bgSHQ8yQ0O-VIHAIi_DG0FHw';
    const SHEET_URL = `https://docs.google.com/spreadsheets/d//${SHEET_ID}/gviz/tq?tqx=out:json&gid=0`;
    
    console.log('Fetching from Google Sheets:', SHEET_URL);
    
    // Fetch data from Google Sheets
    const response = await fetch(SHEET_URL);
    
    if (!response.ok) {
      throw new Error(`Google Sheets request failed: ${response.status}`);
    }
    
    const jsonText = await response.text();
    
    // Parse Google's JSONP response
    const jsonStart = jsonText.indexOf('(') + 1;
    const jsonEnd = jsonText.lastIndexOf(')');
    const cleanJson = jsonText.substring(jsonStart, jsonEnd);
    const data = JSON.parse(cleanJson);
    
    // Process the survey data
    const surveyResults = processSurveyData(data);
    
    return new Response(JSON.stringify(surveyResults, null, 2), {
      headers: headers
    });
    
  } catch (error) {
    console.error('Error:', error);
    
    return new Response(JSON.stringify({
      error: true,
      message: error.message,
      timestamp: new Date().toISOString()
    }, null, 2), {
      headers: headers
    });
  }
}

function processSurveyData(data) {
  if (!data.table || !data.table.rows || data.table.rows.length < 2) {
    return getSampleData();
  }

  // Extract headers and data rows
  const headers = data.table.rows[0].c.map(cell => cell && cell.v ? cell.v.toString() : '');
  const rows = data.table.rows.slice(1);
  
  // Look for survey response columns - Column H (index 7) seems to contain the main data
  const surveyQuestions = [];
  
  // Based on the diagnostic, Column H contains the AI usage responses
  const aiUsageColumnIndex = 7; // Column H
  if (headers[aiUsageColumnIndex]) {
    const aiUsageData = processAIUsageQuestion(rows, aiUsageColumnIndex);
    if (aiUsageData) {
      surveyQuestions.push(aiUsageData);
    }
  }
  
  // Look for other potential survey columns in I, J, K, L, R
  const otherColumns = [8, 9, 10, 11, 17]; // I, J, K, L, R
  otherColumns.forEach(columnIndex => {
    if (headers[columnIndex] && headers[columnIndex].trim()) {
      const questionData = processGenericQuestion(headers[columnIndex], rows, columnIndex);
      if (questionData && questionData.responses.length > 0) {
        surveyQuestions.push(questionData);
      }
    }
  });
  
  return surveyQuestions.length > 0 ? surveyQuestions : getSampleData();
}

function processAIUsageQuestion(rows, columnIndex) {
  const responses = {};
  let totalResponses = 0;
  
  // Predefined AI usage categories
  const predefinedOptions = [
    "Drafting or reviewing creative briefs",
    "Writing emails, captions, or campaign copy", 
    "Analyzing campaign results",
    "Discovering or researching creators",
    "Generating images or video",
    "I'm not using AI at work yet"
  ];
  
  rows.forEach(row => {
    if (row.c[columnIndex] && row.c[columnIndex].v) {
      const answer = row.c[columnIndex].v.toString();
      totalResponses++;
      
      // Check each predefined option
      predefinedOptions.forEach(option => {
        if (answer.toLowerCase().includes(option.toLowerCase())) {
          responses[option] = (responses[option] || 0) + 1;
        }
      });
    }
  });
  
  if (totalResponses === 0) return null;
  
  // Convert to array format
  const responseArray = Object.entries(responses)
    .map(([text, count]) => ({
      text,
      count,
      percentage: Math.round((count / totalResponses) * 100)
    }))
    .sort((a, b) => b.count - a.count);
  
  return {
    question: "How are you using AI in your work today?",
    type: "multiple_choice",
    responses: responseArray,
    total_responses: totalResponses,
    other_responses: "Live data from Tally survey via Google Sheets"
  };
}

function processGenericQuestion(header, rows, columnIndex) {
  const responses = {};
  let totalResponses = 0;
  let otherResponses = [];
  
  rows.forEach(row => {
    if (row.c[columnIndex] && row.c[columnIndex].v) {
      const answer = row.c[columnIndex].v.toString().trim();
      totalResponses++;
      
      // For AI tool question, normalize responses
      if (header.toLowerCase().includes('tool') || header.toLowerCase().includes('ai')) {
        const normalized = normalizeAITool(answer);
        responses[normalized] = (responses[normalized] || 0) + 1;
      } else {
        // For other questions, split on commas
        const selections = answer.split(',').map(s => s.trim()).filter(s => s.length > 0);
        selections.forEach(selection => {
          responses[selection] = (responses[selection] || 0) + 1;
        });
      }
    }
  });
  
  if (totalResponses === 0) return null;
  
  // Convert to array format
  let responseArray = Object.entries(responses)
    .map(([text, count]) => ({
      text,
      count, 
      percentage: Math.round((count / totalResponses) * 100)
    }))
    .sort((a, b) => b.count - a.count);
  
  // For AI tools, group smaller responses as "Other"
  if (header.toLowerCase().includes('tool')) {
    const popularTools = responseArray.filter(r => r.percentage >= 15);
    const unpopularTools = responseArray.filter(r => r.percentage < 15);
    
    if (unpopularTools.length > 0) {
      const otherCount = unpopularTools.reduce((sum, tool) => sum + tool.count, 0);
      responseArray = [
        ...popularTools,
        {
          text: "Other",
          count: otherCount,
          percentage: Math.round((otherCount / totalResponses) * 100)
        }
      ];
      otherResponses = unpopularTools.map(tool => tool.text);
    }
  }
  
  const questionData = {
    question: header,
    type: header.toLowerCase().includes('tool') ? "single_choice" : "multiple_choice",
    responses: responseArray,
    total_responses: totalResponses
  };
  
  if (otherResponses.length > 0) {
    questionData.other_responses = otherResponses.join(', ');
  }
  
  return questionData;
}

function normalizeAITool(text) {
  const normalized = text.toLowerCase().trim();
  
  if (normalized.includes('chatgpt') || normalized.includes('chat gpt') || normalized === 'gpt') {
    return 'ChatGPT';
  }
  if (normalized.includes('claude')) {
    return 'Claude';
  }
  if (normalized.includes('gemini')) {
    return 'Gemini'; 
  }
  if (normalized.includes('gamma')) {
    return 'Gamma';
  }
  if (normalized.includes('copilot')) {
    return 'GitHub Copilot';
  }
  
  return text.trim();
}

function getSampleData() {
  return [
    {
      question: "Connection Status",
      type: "single_choice",
      responses: [
        { text: "✅ Google Sheets connected successfully", count: 1, percentage: 100 },
        { text: "⚠️ No survey data found in expected columns", count: 1, percentage: 100 }
      ],
      total_responses: 1,
      other_responses: "Check that your survey data is in columns H-L or R"
    }
  ];
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

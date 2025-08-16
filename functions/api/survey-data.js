// Enhanced Cloudflare Pages Function with Google Sheets - functions/api/survey-data.js

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
    const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=0`;
    
    console.log('Fetching from Google Sheets:', SHEET_URL);
    
    // Fetch data from Google Sheets
    const response = await fetch(SHEET_URL);
    
    if (!response.ok) {
      throw new Error(`Google Sheets request failed: ${response.status}`);
    }
    
    const jsonText = await response.text();
    console.log('Google Sheets response length:', jsonText.length);
    
    // Parse Google's JSONP response
    const jsonStart = jsonText.indexOf('(') + 1;
    const jsonEnd = jsonText.lastIndexOf(')');
    const cleanJson = jsonText.substring(jsonStart, jsonEnd);
    const data = JSON.parse(cleanJson);
    
    // Process the data
    const processedData = processGoogleSheetsData(data);
    
    return new Response(JSON.stringify(processedData, null, 2), {
      headers: headers
    });
    
  } catch (error) {
    console.error('Error in survey-data function:', error);
    
    // Return sample data if Google Sheets fails
    const fallbackData = [
      {
        question: "API Status",
        type: "single_choice",
        responses: [
          { text: "✅ Cloudflare Function is working", count: 1, percentage: 100 },
          { text: "⚠️ Google Sheets connection failed", count: 1, percentage: 100 }
        ],
        total_responses: 1,
        other_responses: `Error: ${error.message}`
      }
    ];
    
    return new Response(JSON.stringify(fallbackData, null, 2), {
      headers: headers
    });
  }
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

// Process Google Sheets data into survey format
function processGoogleSheetsData(data) {
  if (!data || !data.table || !data.table.rows || data.table.rows.length < 2) {
    return getSampleData();
  }

  // Extract headers from the first row
  const headerRow = data.table.rows[0];
  const headers = headerRow.c.map(cell => cell && cell.v ? cell.v.toString() : '');
  
  // Extract data rows (skip header row)
  const dataRows = data.table.rows.slice(1);
  const rows = dataRows.map(row => {
    return row.c.map(cell => cell && cell.v ? cell.v.toString() : '');
  });

  console.log('Processing', rows.length, 'rows');

  // Only process specific columns: H-L (indices 7-11) and R (index 17)
  const targetColumns = [7, 8, 9, 10, 11, 17];
  const questions = [];

  targetColumns.forEach(index => {
    if (index < headers.length && headers[index] && headers[index].trim()) {
      const header = headers[index];
      let totalResponseCount = 0;

      // Count total respondents for this question
      rows.forEach(row => {
        if (row[index] && row[index].trim()) {
          totalResponseCount++;
        }
      });

      if (totalResponseCount > 0) {
        const { responseArray, otherResponses } = parseQuestionData(header, rows, index, totalResponseCount);

        if (responseArray.length > 0) {
          // Determine question type
          let questionType = "single_choice";
          if (header.toLowerCase().includes('select all') || header.toLowerCase().includes('pick top')) {
            questionType = "multiple_choice";
          } else if (header.toLowerCase().includes('confident') || header.includes('1-5')) {
            questionType = "scale";
          }

          const questionData = {
            question: header,
            type: questionType,
            responses: responseArray,
            total_responses: totalResponseCount
          };

          if (otherResponses.length > 0) {
            questionData.other_responses = otherResponses.join(', ');
          }

          questions.push(questionData);
        }
      }
    }
  });

  console.log('Processed', questions.length, 'questions');
  return questions.length > 0 ? questions : getSampleData();
}

// Parse question data with your existing logic
function parseQuestionData(header, rows, index, totalResponseCount) {
  const responses = {};
  let otherResponses = [];

  // Your existing predefined options
  const predefinedAIUsage = [
    "Discovering or researching creators",
    "Drafting or reviewing creative briefs", 
    "Writing emails, captions, or campaign copy",
    "Analyzing campaign results",
    "Generating images or video",
    "I'm not using AI at work yet"
  ];

  rows.forEach(row => {
    if (row[index] && row[index].trim()) {
      const answer = row[index].trim();
      
      // Handle go-to AI tool question
      if (header.toLowerCase().includes('go-to ai tool')) {
        const normalizedSelection = normalizeResponse(answer);
        responses[normalizedSelection] = (responses[normalizedSelection] || 0) + 1;
      }
      // Handle AI usage question  
      else if (header.toLowerCase().includes('select all') || header.toLowerCase().includes('using ai')) {
        predefinedAIUsage.forEach(option => {
          if (answer.toLowerCase().includes(option.toLowerCase())) {
            responses[option] = (responses[option] || 0) + 1;
          }
        });
      }
      // Handle other questions
      else {
        const selections = answer.split(',').map(a => a.trim()).filter(a => a.length > 0);
        selections.forEach(selection => {
          responses[selection] = (responses[selection] || 0) + 1;
        });
      }
    }
  });

  // Convert to array and calculate percentages
  let responseArray = Object.entries(responses)
    .map(([text, count]) => ({
      text,
      count,
      percentage: totalResponseCount > 0 ? Math.round((count / totalResponseCount) * 100) : 0
    }));

  // Sort by count (highest first)
  responseArray.sort((a, b) => b.count - a.count);

  return { responseArray, otherResponses };
}

function normalizeResponse(text) {
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

  return text.trim();
}

function getSampleData() {
  return [
    {
      question: "How are you using AI in your work today?",
      type: "multiple_choice", 
      responses: [
        { text: "Writing emails, captions, or campaign copy", count: 11, percentage: 85 },
        { text: "Drafting or reviewing creative briefs", count: 10, percentage: 77 }
      ],
      total_responses: 13,
      other_responses: "Google Sheets connection successful - showing sample data structure"
    }
  ];
}

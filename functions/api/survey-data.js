// Diagnostic version - functions/api/survey-data.js

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
    
    // Parse Google's JSONP response
    const jsonStart = jsonText.indexOf('(') + 1;
    const jsonEnd = jsonText.lastIndexOf(')');
    const cleanJson = jsonText.substring(jsonStart, jsonEnd);
    const data = JSON.parse(cleanJson);
    
    // DIAGNOSTIC: Show what we're getting from the sheet
    const diagnostic = {
      success: true,
      message: "Google Sheets connection successful!",
      timestamp: new Date().toISOString(),
      
      // Show the sheet structure
      sheet_info: {
        total_rows: data.table ? data.table.rows.length : 0,
        has_data: !!(data.table && data.table.rows && data.table.rows.length > 1)
      },
      
      // Show the headers (first row)
      headers: data.table && data.table.rows && data.table.rows[0] ? 
        data.table.rows[0].c.map((cell, index) => ({
          column: index,
          letter: String.fromCharCode(65 + index), // A, B, C, etc.
          value: cell && cell.v ? cell.v.toString() : '(empty)'
        })) : [],
      
      // Show a few sample rows
      sample_rows: data.table && data.table.rows ? 
        data.table.rows.slice(1, 4).map((row, rowIndex) => ({
          row_number: rowIndex + 2,
          data: row.c.map((cell, colIndex) => ({
            column: String.fromCharCode(65 + colIndex),
            value: cell && cell.v ? cell.v.toString() : '(empty)'
          }))
        })) : [],
        
      // Show specifically what's in columns H-L and R (our target columns)
      target_columns: {
        H: getColumnData(data, 7, 'H'),
        I: getColumnData(data, 8, 'I'), 
        J: getColumnData(data, 9, 'J'),
        K: getColumnData(data, 10, 'K'),
        L: getColumnData(data, 11, 'L'),
        R: getColumnData(data, 17, 'R')
      }
    };
    
    return new Response(JSON.stringify(diagnostic, null, 2), {
      headers: headers
    });
    
  } catch (error) {
    console.error('Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      message: "Failed to connect to Google Sheets",
      timestamp: new Date().toISOString()
    }, null, 2), {
      headers: headers
    });
  }
}

function getColumnData(data, columnIndex, columnLetter) {
  if (!data.table || !data.table.rows || data.table.rows.length < 1) {
    return { error: "No data available" };
  }
  
  const headerRow = data.table.rows[0];
  const header = headerRow.c[columnIndex] && headerRow.c[columnIndex].v ? 
    headerRow.c[columnIndex].v.toString() : '(empty)';
  
  const sampleData = data.table.rows.slice(1, 4).map((row, index) => ({
    row: index + 2,
    value: row.c[columnIndex] && row.c[columnIndex].v ? 
      row.c[columnIndex].v.toString() : '(empty)'
  }));
  
  return {
    column_letter: columnLetter,
    column_index: columnIndex,
    header: header,
    sample_data: sampleData,
    total_responses: data.table.rows.slice(1).filter(row => 
      row.c[columnIndex] && row.c[columnIndex].v
    ).length
  };
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

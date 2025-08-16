// Corrected Cloudflare Pages Function - functions/api/survey-data.js

export async function onRequestGet(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    const testData = {
      success: true,
      message: "🎉 Cloudflare Pages Function is working!",
      timestamp: new Date().toISOString(),
      url: context.request.url,
      method: context.request.method
    };

    return new Response(JSON.stringify(testData, null, 2), {
      status: 200,
      headers: headers
    });

  } catch (error) {
    const errorData = {
      success: false,
      error: 'Function failed',
      message: error.message,
      timestamp: new Date().toISOString()
    };

    return new Response(JSON.stringify(errorData, null, 2), {
      status: 500,
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

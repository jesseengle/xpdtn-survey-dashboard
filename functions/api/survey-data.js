// Cloudflare Pages Function - save as functions/api/survey-data.js

export default {
  async fetch(request, env, ctx) {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    // Handle OPTIONS for CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    try {
      const testData = {
        success: true,
        message: "🎉 Cloudflare Worker is working!",
        timestamp: new Date().toISOString(),
        url: request.url,
        method: request.method,
        environment: "Cloudflare Pages Function"
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
};
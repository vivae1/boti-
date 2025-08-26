// In file: /api/proxy.js

const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // This line allows your Google Site and the development environment to make requests.
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allows all origins for easier debugging
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle the browser's pre-flight request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Securely get the API key from Vercel's environment variables
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('CRITICAL: GEMINI_API_KEY environment variable is not set in Vercel!');
        return res.status(500).json({ error: 'Server configuration error: API key is missing.' });
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

    try {
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body) // Forward the client's request body
        });

        const data = await geminiResponse.json();

        // ** NEW: Check for quota error from Google **
        // Google's quota errors often have a 429 status code.
        if (geminiResponse.status === 429 || (data.error && data.error.message.toLowerCase().includes('quota'))) {
            console.warn('Gemini API quota exceeded.');
            // Send a specific, identifiable error back to the client.
            return res.status(429).json({ error: 'QUOTA_EXCEEDED' });
        }
        
        if (data.error) {
             console.error('Gemini API returned an error:', data.error);
             return res.status(400).json({ error: `Gemini API Error: ${data.error.message}` });
        }
        
        res.status(200).json(data);

    } catch (error) {
        console.error('Error proxying request:', error);
        res.status(500).json({ error: 'Failed to fetch from Gemini API.' });
    }
};

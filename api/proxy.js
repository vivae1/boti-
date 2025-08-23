// In file: /api/proxy.js

const fetch = require('node-fetch');

// --- Rate Limiter Setup ---
// This map will store IP addresses and their request counts.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Allow 10 requests per minute per user

module.exports = async (req, res) => {
    // This line allows your Google Site and the development environment to make requests.
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allows all origins for easier debugging
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle the browser's pre-flight request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // --- Rate Limiter Logic ---
    // Get the user's IP address. Vercel provides this in the 'x-forwarded-for' header.
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    const now = Date.now();
    const userRecord = rateLimitStore.get(ip);

    if (!userRecord) {
        // First request from this IP in a while
        rateLimitStore.set(ip, { count: 1, startTime: now });
    } else {
        // Check if the window has reset
        if (now - userRecord.startTime > RATE_LIMIT_WINDOW_MS) {
            userRecord.startTime = now;
            userRecord.count = 1;
        } else {
            userRecord.count++;
        }

        // If the user has exceeded the limit, block them.
        if (userRecord.count > MAX_REQUESTS_PER_WINDOW) {
            return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
        }
    }
    // --- End of Rate Limiter Logic ---


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

        // Check if Gemini itself returned an error (e.g., invalid key)
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

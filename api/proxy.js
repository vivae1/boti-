// ה-fetch מובנה ב-Node.js 18+, אין צורך ב-require

// --- Rate Limiter Setup ---
// הערה: ב-Serverless המשתנה הזה מתאפס לעיתים קרובות, זה תקין לשימוש בסיסי
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // דקה אחת
const MAX_REQUESTS_PER_WINDOW = 10; // 10 בקשות לדקה לכל משתמש

export default async function handler(req, res) {
    // 1. הגדרת כותרות CORS (כדי שהדפדפן יסכים לדבר עם השרת)
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 2. טיפול בבקשת "בדיקה" של הדפדפן (Pre-flight)
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 3. מנגנון הגבלת קצב (Rate Limiting)
    const ip = req.headers['x-forwarded-for'] || 'unknown-ip';
    const now = Date.now();
    const userRecord = rateLimitStore.get(ip);

    if (!userRecord) {
        rateLimitStore.set(ip, { count: 1, startTime: now });
    } else {
        if (now - userRecord.startTime > RATE_LIMIT_WINDOW_MS) {
            userRecord.startTime = now;
            userRecord.count = 1;
        } else {
            userRecord.count++;
        }

        if (userRecord.count > MAX_REQUESTS_PER_WINDOW) {
            return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
        }
    }

    // 4. בדיקת מפתח ה-API
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        console.error('CRITICAL: GEMINI_API_KEY is missing in Vercel Environment Variables!');
        return res.status(500).json({ 
            error: 'Server configuration error: API Key is missing.',
            details: 'Please set GEMINI_API_KEY in Vercel Settings'
        });
    }

    // 5. שליחת הבקשה לגוגל
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    try {
        // שימוש ב-body שהגיע מהלקוח
        const requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const data = await geminiResponse.json();

        // טיפול בשגיאות מכסה (Quota) או שגיאות אחרות מגוגל
        if (!geminiResponse.ok) {
            console.error('Gemini API Error:', data);
            
            if (geminiResponse.status === 429 || (data.error && data.error.message && data.error.message.toLowerCase().includes('quota'))) {
                return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'The AI service is currently busy.' });
            }
            
            return res.status(geminiResponse.status).json({ error: data.error?.message || 'Error from Google API' });
        }
        
        // החזרת התשובה התקינה לדפדפן
        return res.status(200).json(data);

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}

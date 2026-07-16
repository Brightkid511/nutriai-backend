const axios = require('axios');
const db = require('../config/db');
const genAI = require('../config/gemini');

const SPOONACULAR_API_KEY = process.env.SPOONACULAR_API_KEY;
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=700';

// ==================== EXPONENTIAL BACKOFF RETRY ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const withRetry = async (fn, maxRetries = 4, baseDelay = 1200) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        console.error(`All ${maxRetries + 1} attempts failed.`);
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
};

// ==================== TRANSLATION (Gemini + Fallback) ====================
const translateToEnglish = async (text) => {
  if (!text) return text;
  if (/^[a-zA-Z0-9\s,().&'-]+$/.test(text.trim())) return text.trim();

  try {
    return await withRetry(async () => {
      const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
      const prompt = `Translate this food/dish name to natural English. Return ONLY the English name.\n\nFood: "${text}"\n\nEnglish:`;
      
      const result = await model.generateContent(prompt);
      let translated = result.response.text().trim();
      return translated.replace(/^English:?\s*/i, '').trim() || text;
    }, 3, 1000);
  } catch (e) {
    console.error('Translation failed, using original:', text);
  }

  // Hardcoded fallback
  const map = {
    "wali na maharage": "rice and beans",
    "wali": "rice",
    "ugali": "ugali",
    "nyama choma": "grilled meat",
    "samaki": "fried fish",
    "kuku choma": "grilled chicken",
    "kuku": "chicken",
    "mchicha": "spinach",
    "pilau": "pilau rice",
    "maandazi": "mandazi",
    "mayai": "eggs",
    "ndizi": "banana",
    "viazi": "potatoes",
    "maharage": "beans",
    "chai": "tea",
  };
  return map[text.toLowerCase().trim()] || text;
};

// ==================== CACHING ====================
const getCachedImage = async (mealName) => {
  const [rows] = await db.execute(
    'SELECT image_url FROM food_images WHERE LOWER(meal_name) = LOWER(?) LIMIT 1',
    [mealName]
  );
  return rows.length > 0 ? rows[0].image_url : null;
};

const cacheImage = async (mealName, imageUrl) => {
  try {
    await db.execute(
      `INSERT INTO food_images (meal_name, image_url)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE image_url = VALUES(image_url)`,
      [mealName, imageUrl]
    );
  } catch (error) {
    console.error('Cache error:', error.message);
  }
};

// ==================== SPOONACULAR SEARCH ====================
const searchSpoonacular = async (mealName) => {
  if (!SPOONACULAR_API_KEY) return null;

  const englishName = await translateToEnglish(mealName);

  return await withRetry(async () => {
    const response = await axios.get('https://api.spoonacular.com/recipes/complexSearch', {
      params: { query: englishName, number: 1, sort: 'popularity' },
      headers: { 'x-api-key': SPOONACULAR_API_KEY },
      timeout: 10000,
    });
    return response.data?.results?.[0]?.image || null;
  }, 4, 1200);
};

// ==================== MAIN ENDPOINT ====================
const getFoodImage = async (req, res) => {
  try {
    const { name } = req.query;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const cached = await getCachedImage(name);
    if (cached) {
      return res.json({ success: true, mealName: name, imageUrl: cached });
    }

    const imageUrl = await searchSpoonacular(name);

    if (imageUrl) {
      await cacheImage(name, imageUrl);
      return res.json({ success: true, mealName: name, imageUrl });
    }

    return res.json({ success: true, mealName: name, imageUrl: FALLBACK_IMAGE });
  } catch (error) {
    console.error('getFoodImage error:', error.message);
    return res.json({ 
      success: true, 
      mealName: req.query.name, 
      imageUrl: FALLBACK_IMAGE 
    });
  }
};

module.exports = { getFoodImage };
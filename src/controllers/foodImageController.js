const axios = require('axios');
const db = require('../config/db');

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const UNSPLASH_SEARCH_URL = 'https://api.unsplash.com/search/photos';

const FALLBACK_IMAGE =
  'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=700';

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
    console.error('Failed to cache food image:', error.message);
  }
};

const searchUnsplash = async (mealName) => {
  if (!UNSPLASH_ACCESS_KEY) {
    console.error('UNSPLASH_ACCESS_KEY is not set');
    return null;
  }

  try {
    const response = await axios.get(UNSPLASH_SEARCH_URL, {
      params: {
        query: `${mealName} Tanzanian food`,
        per_page: 1,
        orientation: 'squarish',
      },
      headers: {
        Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
      },
      timeout: 8000,
    });

    const results = response.data?.results;
    if (results && results.length > 0) {
      return results[0].urls.regular;
    }
    return null;
  } catch (error) {
    console.error('Unsplash search failed:', error.message);
    return null;
  }
};

// GET /api/food-images?name=Rice+and+Beans
const getFoodImage = async (req, res) => {
  try {
    const { name } = req.query;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Query param "name" is required',
      });
    }

    const cached = await getCachedImage(name);
    if (cached) {
      return res.json({
        success: true,
        mealName: name,
        imageUrl: cached,
      });
    }

    const found = await searchUnsplash(name);
    if (found) {
      await cacheImage(name, found);
      return res.json({
        success: true,
        mealName: name,
        imageUrl: found,
      });
    }

    return res.json({
      success: true,
      mealName: name,
      imageUrl: FALLBACK_IMAGE,
    });
  } catch (error) {
    console.error('Error fetching food image:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch food image',
    });
  }
};

module.exports = { getFoodImage };
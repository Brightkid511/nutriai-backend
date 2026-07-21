const genAI = require('../config/gemini');
const db = require('../config/db');
const { getHealthProfileText } = require('./healthProfileController');
const AppError = require('../utils/AppError');

// Converts the chat history sent from Flutter (role: 'user' | 'ai')
// into the format Gemini's chat API expects (role: 'user' | 'model').
// Also strips leading 'ai' turns, since Gemini chat history must start
// with a 'user' turn.
const toGeminiHistory = (history) => {
  if (!Array.isArray(history)) return [];

  const mapped = history
    .filter((turn) => turn && typeof turn.content === 'string' && turn.content.trim())
    .map((turn) => ({
      role: turn.role === 'ai' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    }));

  const firstUserIndex = mapped.findIndex((turn) => turn.role === 'user');
  return firstUserIndex === -1 ? [] : mapped.slice(firstUserIndex);
};

// POST /api/ai-chef/chat
// body: { message: string, history: [{ role: 'user' | 'ai', content: string }] }
const chatWithAiChef = async (req, res) => {
  const userId = req.user?.id;
  const { message, history } = req.body;

  if (!userId) {
    throw new AppError('User ID not found in token', 401);
  }
  if (!message || !message.trim()) {
    throw new AppError('Message is required', 400);
  }

  const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
  const user = users[0];

  const profileLine = user
    ? `The user's profile: age ${user.age}, weight ${user.weight}kg, height ${user.height}cm, activity level ${user.activity_level}, goal: ${user.goal}. Use this to tailor suggestions (e.g. portion sizes or ingredient choices) when relevant, but don't force it into every reply.`
    : '';

  const healthProfileText = await getHealthProfileText(userId);

  const systemInstruction = `You are AI Chef, a friendly, practical cooking assistant inside the NutriAI app.

Your main job: help the user decide what to cook, especially based on ingredients they already have at home.
${healthProfileText ? `\n${healthProfileText}\nThese are hard constraints - never suggest a dish that conflicts with the user's allergies, and keep conditions/dietary preference in mind for every suggestion.\n` : ''}
Guidelines:
- When the user lists ingredients, suggest 1-3 realistic meals they could make with them (or mostly with them), favoring simple, common preparations.
- If a suggestion would normally include something the user is allergic to, either omit it or suggest a safe substitute, and don't mention the omitted ingredient in your reasoning.
- If you don't have enough detail (e.g. they just say "I have chicken"), ask a short clarifying question (e.g. what else they have, how much time, dietary preference) before giving a full recipe.
- Keep replies conversational and concise - this is a chat, not a recipe book. Use short paragraphs or a short list, not long essays.
- When giving a recipe, keep it practical: ingredients list + brief steps, nothing overly technical.
- Tanzanian and East African dishes and ingredients (ugali, sukuma wiki, pilau, ndizi, etc.) are common for this user base - lean on that knowledge when it fits, but don't force it if the user is asking about something else.
- ${profileLine}
- Stay focused on food, cooking, and nutrition topics.`;

  let result;
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      systemInstruction,
    });

    const chatHistory = toGeminiHistory(history);
    const chat = model.startChat({ history: chatHistory });

    result = await chat.sendMessage(message);
  } catch (err) {
    // Gemini/network failure - safe to tell the user to retry, but never
    // forward err.message (could contain API key/request internals).
    console.error('AI Chef Gemini call failed:', err);
    throw new AppError('AI Chef is temporarily unavailable. Please try again in a moment.', 502);
  }

  const reply = result.response.text();

  return res.json({
    success: true,
    reply,
  });
};

module.exports = { chatWithAiChef };
const genAI = require('../config/gemini');
const db = require('../config/db');

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
  try {
    const userId = req.user?.id;
    const { message, history } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'User ID not found in token' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
    const user = users[0];

    const profileLine = user
      ? `The user's profile: age ${user.age}, weight ${user.weight}kg, height ${user.height}cm, activity level ${user.activity_level}, goal: ${user.goal}. Use this to tailor suggestions (e.g. portion sizes or ingredient choices) when relevant, but don't force it into every reply.`
      : '';

    const systemInstruction = `You are AI Chef, a friendly, practical cooking assistant inside the NutriAI app.

Your main job: help the user decide what to cook, especially based on ingredients they already have at home.

Guidelines:
- When the user lists ingredients, suggest 1-3 realistic meals they could make with them (or mostly with them), favoring simple, common preparations.
- If you don't have enough detail (e.g. they just say "I have chicken"), ask a short clarifying question (e.g. what else they have, how much time, dietary preference) before giving a full recipe.
- Keep replies conversational and concise - this is a chat, not a recipe book. Use short paragraphs or a short list, not long essays.
- When giving a recipe, keep it practical: ingredients list + brief steps, nothing overly technical.
- Tanzanian and East African dishes and ingredients (ugali, sukuma wiki, pilau, ndizi, etc.) are common for this user base - lean on that knowledge when it fits, but don't force it if the user is asking about something else.
- ${profileLine}
- Stay focused on food, cooking, and nutrition topics.`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      systemInstruction,
    });

    const chatHistory = toGeminiHistory(history);
    const chat = model.startChat({ history: chatHistory });

    const result = await chat.sendMessage(message);
    const reply = result.response.text();

    return res.json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error('AI Chef chat error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { chatWithAiChef };
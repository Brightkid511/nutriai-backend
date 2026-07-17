const db = require('../config/db');

const dayName = (dateStr) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'long' });
};

const startOfWeek = () => {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  return monday.toISOString().split('T')[0];
};

// GET /api/meal-builder/weekly-progress
const getWeeklyProgress = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });

    const monday = startOfWeek();

    const [rows] = await db.execute(
      `SELECT plan_date, breakfast_name, lunch_name, dinner_name, snack_name, total_calories
       FROM meal_plan_history
       WHERE user_id = ? AND plan_date >= ?
       ORDER BY plan_date ASC`,
      [userId, monday]
    );

    const savedDates = new Map(rows.map((r) => [r.plan_date.toISOString().split('T')[0], r]));

    const week = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];
      const saved = savedDates.get(dateStr);

      week.push({
        date: dateStr,
        day_name: dayName(dateStr),
        status: saved ? 'completed' : (new Date(dateStr) > new Date() ? 'upcoming' : 'missed'),
        total_calories: saved?.total_calories || null,
      });
    }

    const completedCount = week.filter((d) => d.status === 'completed').length;

    return res.json({ success: true, week, completed_this_week: completedCount });
  } catch (error) {
    console.error('Get weekly progress error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { getWeeklyProgress };
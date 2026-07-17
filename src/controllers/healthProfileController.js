const db = require('../config/db');

const getHealthProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await db.execute(
      `SELECT allergies, conditions, notes, preferred_foods, foods_to_avoid
       FROM health_profiles
       WHERE user_id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.json({
        allergies: [],
        conditions: [],
        notes: "",
        preferred_foods: [],
        foods_to_avoid: [],
      });
    }

    const profile = rows[0];

    res.json({
      allergies: profile.allergies ? JSON.parse(profile.allergies) : [],
      conditions: profile.conditions ? JSON.parse(profile.conditions) : [],
      notes: profile.notes || "",
      preferred_foods: profile.preferred_foods
        ? JSON.parse(profile.preferred_foods)
        : [],
      foods_to_avoid: profile.foods_to_avoid
        ? JSON.parse(profile.foods_to_avoid)
        : [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to load health profile",
    });
  }
};

const updateHealthProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      allergies = [],
      conditions = [],
      notes = "",
      preferred_foods = [],
      foods_to_avoid = [],
    } = req.body;

    const [existing] = await db.execute(
      "SELECT id FROM health_profiles WHERE user_id = ?",
      [userId]
    );

    if (existing.length > 0) {
      await db.execute(
        `UPDATE health_profiles
         SET allergies=?,
             conditions=?,
             notes=?,
             preferred_foods=?,
             foods_to_avoid=?
         WHERE user_id=?`,
        [
          JSON.stringify(allergies),
          JSON.stringify(conditions),
          notes,
          JSON.stringify(preferred_foods),
          JSON.stringify(foods_to_avoid),
          userId,
        ]
      );
    } else {
      await db.execute(
        `INSERT INTO health_profiles
        (user_id, allergies, conditions, notes, preferred_foods, foods_to_avoid)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          userId,
          JSON.stringify(allergies),
          JSON.stringify(conditions),
          notes,
          JSON.stringify(preferred_foods),
          JSON.stringify(foods_to_avoid),
        ]
      );
    }

    res.json({
      success: true,
      message: "Health profile updated successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to update health profile",
    });
  }
};

module.exports = {
  getHealthProfile,
  updateHealthProfile,
};
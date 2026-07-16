const db = require('../config/db');

const DAY_MS = 24 * 60 * 60 * 1000;

const parseJsonArraySafely = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
};

const toDateOnly = (d) => {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  return date;
};

const daysBetween = (a, b) => Math.round((toDateOnly(b) - toDateOnly(a)) / DAY_MS);

const toLogResponse = (row) => ({
  id: row.id,
  startDate: row.start_date,
  endDate: row.end_date,
  symptoms: parseJsonArraySafely(row.symptoms),
  notes: row.notes || '',
});

const getSettings = async (userId) => {
  const [rows] = await db.execute(
    'SELECT * FROM cycle_settings WHERE user_id = ?',
    [userId]
  );

  if (rows[0]) {
    return {
      avgCycleLength: rows[0].avg_cycle_length,
      avgPeriodLength: rows[0].avg_period_length,
    };
  }

  return { avgCycleLength: 28, avgPeriodLength: 5 };
};

// Builds prediction info (next period date, current cycle day, phase)
// from the logged history plus the user's average cycle/period length.
// If there's real history (2+ logs), the average cycle length is
// recalculated from actual gaps between logged period starts.
const buildPredictions = (logs, settings) => {
  if (logs.length === 0) {
    return {
      currentCycleDay: null,
      currentPhase: null,
      nextPeriodDate: null,
      nextFertileWindowStart: null,
      nextFertileWindowEnd: null,
      cycleLengthUsed: settings.avgCycleLength,
    };
  }

  const sorted = [...logs].sort(
    (a, b) => new Date(b.start_date) - new Date(a.start_date)
  );
  const lastStart = new Date(sorted[0].start_date);

  let cycleLength = settings.avgCycleLength;
  if (sorted.length >= 2) {
    const gaps = [];
    for (let i = 0; i < sorted.length - 1 && i < 5; i++) {
      const gap = daysBetween(sorted[i + 1].start_date, sorted[i].start_date);
      if (gap > 10 && gap < 60) gaps.push(gap);
    }
    if (gaps.length > 0) {
      cycleLength = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    }
  }

  const today = toDateOnly(new Date());
  const dayOfCycle = ((daysBetween(lastStart, today) % cycleLength) + cycleLength) % cycleLength + 1;

  let phase = 'Follicular';
  if (dayOfCycle <= settings.avgPeriodLength) {
    phase = 'Menstrual';
  } else if (dayOfCycle >= cycleLength - 16 && dayOfCycle <= cycleLength - 12) {
    phase = 'Ovulation';
  } else if (dayOfCycle > cycleLength - 12) {
    phase = 'Luteal';
  }

  const nextPeriodDate = new Date(lastStart.getTime() + cycleLength * DAY_MS);
  const fertileStart = new Date(nextPeriodDate.getTime() - 16 * DAY_MS);
  const fertileEnd = new Date(nextPeriodDate.getTime() - 12 * DAY_MS);

  const fmt = (d) => d.toISOString().split('T')[0];

  return {
    currentCycleDay: dayOfCycle,
    currentPhase: phase,
    nextPeriodDate: fmt(nextPeriodDate),
    nextFertileWindowStart: fmt(fertileStart),
    nextFertileWindowEnd: fmt(fertileEnd),
    cycleLengthUsed: cycleLength,
  };
};

// GET /api/cycle-tracking
// Returns logged history, settings, and computed predictions.
// This endpoint is available to any user - it is not gender-gated.
const getCycleData = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const [logs] = await db.execute(
      `SELECT * FROM period_logs
       WHERE user_id = ?
       ORDER BY start_date DESC
       LIMIT 24`,
      [userId]
    );

    const settings = await getSettings(userId);
    const predictions = buildPredictions(logs, settings);

    return res.json({
      success: true,
      logs: logs.map(toLogResponse),
      settings,
      predictions,
    });
  } catch (error) {
    console.error('Error fetching cycle data:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch cycle tracking data',
    });
  }
};

// POST /api/cycle-tracking/logs
// body: { startDate, endDate?, symptoms?: string[], notes? }
const createLog = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const { startDate, endDate = null, symptoms = [], notes = '' } = req.body;

    if (!startDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate is required',
      });
    }

    const [result] = await db.execute(
      `INSERT INTO period_logs (user_id, start_date, end_date, symptoms, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, startDate, endDate, JSON.stringify(symptoms), notes]
    );

    const [rows] = await db.execute(
      'SELECT * FROM period_logs WHERE id = ?',
      [result.insertId]
    );

    return res.status(201).json({
      success: true,
      message: 'Period logged successfully',
      log: toLogResponse(rows[0]),
    });
  } catch (error) {
    console.error('Error creating period log:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to log period',
    });
  }
};

// PUT /api/cycle-tracking/logs/:id
// Used mainly to set endDate once a logged period finishes.
const updateLog = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { startDate, endDate = null, symptoms = [], notes = '' } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    if (!startDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate is required',
      });
    }

    const [result] = await db.execute(
      `UPDATE period_logs
       SET start_date = ?, end_date = ?, symptoms = ?, notes = ?, updated_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [startDate, endDate, JSON.stringify(symptoms), notes, id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Period log not found',
      });
    }

    const [rows] = await db.execute(
      'SELECT * FROM period_logs WHERE id = ?',
      [id]
    );

    return res.json({
      success: true,
      message: 'Period log updated successfully',
      log: toLogResponse(rows[0]),
    });
  } catch (error) {
    console.error('Error updating period log:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to update period log',
    });
  }
};

// DELETE /api/cycle-tracking/logs/:id
const deleteLog = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const [result] = await db.execute(
      'DELETE FROM period_logs WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Period log not found',
      });
    }

    return res.json({
      success: true,
      message: 'Period log deleted successfully',
      logId: id,
    });
  } catch (error) {
    console.error('Error deleting period log:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to delete period log',
    });
  }
};

// PUT /api/cycle-tracking/settings
// body: { avgCycleLength, avgPeriodLength }
const updateSettings = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { avgCycleLength = 28, avgPeriodLength = 5 } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    await db.execute(
      `INSERT INTO cycle_settings (user_id, avg_cycle_length, avg_period_length)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         avg_cycle_length = VALUES(avg_cycle_length),
         avg_period_length = VALUES(avg_period_length),
         updated_at = NOW()`,
      [userId, avgCycleLength, avgPeriodLength]
    );

    return res.json({
      success: true,
      message: 'Cycle settings updated successfully',
      settings: { avgCycleLength, avgPeriodLength },
    });
  } catch (error) {
    console.error('Error updating cycle settings:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to update cycle settings',
    });
  }
};

module.exports = {
  getCycleData,
  createLog,
  updateLog,
  deleteLog,
  updateSettings,
};
const db = require('../config/db');
const AppError = require('../utils/AppError');

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
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const [logs] = await db.execute(
    `SELECT * FROM period_logs WHERE user_id = ? ORDER BY start_date DESC LIMIT 24`,
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
};

// POST /api/cycle-tracking/logs
// body: { startDate, endDate?, symptoms?: string[], notes? }
const createLog = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const { startDate, endDate = null, symptoms = [], notes = '' } = req.body;

  if (!startDate) throw new AppError('startDate is required', 400);

  const [result] = await db.execute(
    `INSERT INTO period_logs (user_id, start_date, end_date, symptoms, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, startDate, endDate, JSON.stringify(symptoms), notes]
  );

  const [rows] = await db.execute('SELECT * FROM period_logs WHERE id = ?', [result.insertId]);

  return res.status(201).json({
    success: true,
    message: 'Period logged successfully',
    log: toLogResponse(rows[0]),
  });
};

// PUT /api/cycle-tracking/logs/:id
// Used mainly to set endDate once a logged period finishes.
const updateLog = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;
  const { startDate, endDate = null, symptoms = [], notes = '' } = req.body;

  if (!userId) throw new AppError('User ID not found in token', 401);
  if (!startDate) throw new AppError('startDate is required', 400);

  const [result] = await db.execute(
    `UPDATE period_logs
     SET start_date = ?, end_date = ?, symptoms = ?, notes = ?, updated_at = NOW()
     WHERE id = ? AND user_id = ?`,
    [startDate, endDate, JSON.stringify(symptoms), notes, id, userId]
  );

  if (result.affectedRows === 0) {
    throw new AppError('Period log not found', 404);
  }

  const [rows] = await db.execute('SELECT * FROM period_logs WHERE id = ?', [id]);

  return res.json({
    success: true,
    message: 'Period log updated successfully',
    log: toLogResponse(rows[0]),
  });
};

// DELETE /api/cycle-tracking/logs/:id
const deleteLog = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;

  if (!userId) throw new AppError('User ID not found in token', 401);

  const [result] = await db.execute(
    'DELETE FROM period_logs WHERE id = ? AND user_id = ?',
    [id, userId]
  );

  if (result.affectedRows === 0) {
    throw new AppError('Period log not found', 404);
  }

  return res.json({ success: true, message: 'Period log deleted successfully', logId: id });
};

// PUT /api/cycle-tracking/settings
// body: { avgCycleLength, avgPeriodLength }
const updateSettings = async (req, res) => {
  const userId = req.user?.id;
  const { avgCycleLength = 28, avgPeriodLength = 5 } = req.body;

  if (!userId) throw new AppError('User ID not found in token', 401);

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
};

module.exports = {
  getCycleData,
  createLog,
  updateLog,
  deleteLog,
  updateSettings,
};
import { getDb, vietnamDateStr } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';
import { getClientInfo } from '../../lib/ip-match.js';
import { getEdgeConfigStatus } from '../../lib/edge-sync.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const rawDays = Number(req.query?.days || 30);
    const days = [7, 30, 90].includes(rawDays) ? rawDays : 30;
    const today = vietnamDateStr();
    const sql = getDb();
    const client = getClientInfo(req);

    const [
      kpiVisitors,
      kpiActivity,
      activeBlocksCount,
      dailyTrend,
      levelBreakdown,
      deviceBreakdown,
      osBreakdown,
      browserBreakdown,
      streakBuckets,
      topLessons,
      hardestVocab,
      zeroSearches,
      topSearches,
      systemErrors,
      visitorIps,
      loginLogs
    ] = await Promise.all([
      // DAU (today), WAU (7d), MAU (30d)
      sql`
        SELECT
          COUNT(DISTINCT visitor_id) FILTER (WHERE stat_date = ${today}::date)::int AS dau,
          COUNT(DISTINCT visitor_id) FILTER (WHERE stat_date >= (${today}::date - INTERVAL '6 days'))::int AS wau,
          COUNT(DISTINCT visitor_id) FILTER (WHERE stat_date >= (${today}::date - INTERVAL '29 days'))::int AS mau
        FROM stats_daily_visitors
      `,
      // Activity totals in selected range
      sql`
        SELECT
          COALESCE(SUM(page_views), 0)::bigint AS page_views,
          COALESCE(SUM(flashcard_answers), 0)::bigint AS flashcard_answers,
          COALESCE(SUM(stroke_quizzes), 0)::bigint AS stroke_quizzes,
          COALESCE(SUM(audio_plays), 0)::bigint AS audio_plays,
          COALESCE(SUM(word_lookups), 0)::bigint AS word_lookups,
          COALESCE(SUM(known_toggles), 0)::bigint AS known_toggles
        FROM stats_daily
        WHERE stat_date >= (${today}::date - ${days - 1}::int)
      `,
      // Active blocked IPs count
      sql`
        SELECT COUNT(*)::int AS cnt
        FROM blocked_ips
        WHERE expires_at IS NULL OR expires_at > NOW()
      `,
      // Daily trend (page views + unique visitors per day)
      sql`
        WITH d AS (
          SELECT stat_date, SUM(page_views)::bigint AS views, SUM(flashcard_answers)::bigint AS flashcards
          FROM stats_daily
          WHERE stat_date >= (${today}::date - ${days - 1}::int)
          GROUP BY stat_date
        ),
        v AS (
          SELECT stat_date, COUNT(DISTINCT visitor_id)::int AS visitors
          FROM stats_daily_visitors
          WHERE stat_date >= (${today}::date - ${days - 1}::int)
          GROUP BY stat_date
        )
        SELECT
          COALESCE(d.stat_date, v.stat_date)::text AS date,
          COALESCE(d.views, 0)::int AS views,
          COALESCE(d.flashcards, 0)::int AS flashcards,
          COALESCE(v.visitors, 0)::int AS visitors
        FROM d FULL OUTER JOIN v ON d.stat_date = v.stat_date
        ORDER BY date ASC
      `,
      // Level distribution (HSK1-HSK4)
      sql`
        SELECT
          level,
          COALESCE(SUM(page_views), 0)::int AS page_views,
          COALESCE(SUM(flashcard_answers), 0)::int AS flashcard_answers,
          COALESCE(SUM(stroke_quizzes), 0)::int AS stroke_quizzes,
          COALESCE(SUM(audio_plays), 0)::int AS audio_plays
        FROM stats_daily
        WHERE stat_date >= (${today}::date - ${days - 1}::int)
          AND level IN ('HSK1', 'HSK2', 'HSK3', 'HSK4')
        GROUP BY level
        ORDER BY level ASC
      `,
      // Device breakdown
      sql`
        SELECT COALESCE(device_type, 'unknown') AS name, COUNT(*)::int AS cnt
        FROM stats_daily_visitors
        WHERE stat_date >= (${today}::date - ${days - 1}::int)
        GROUP BY device_type
        ORDER BY cnt DESC
      `,
      // OS breakdown
      sql`
        SELECT COALESCE(os_name, 'Other') AS name, COUNT(*)::int AS cnt
        FROM stats_daily_visitors
        WHERE stat_date >= (${today}::date - ${days - 1}::int)
        GROUP BY os_name
        ORDER BY cnt DESC
        LIMIT 8
      `,
      // Browser breakdown
      sql`
        SELECT COALESCE(browser_name, 'Other') AS name, COUNT(*)::int AS cnt
        FROM stats_daily_visitors
        WHERE stat_date >= (${today}::date - ${days - 1}::int)
        GROUP BY browser_name
        ORDER BY cnt DESC
        LIMIT 8
      `,
      // Streak distribution
      sql`
        SELECT
          CASE
            WHEN current_streak <= 1 THEN '1 ngày'
            WHEN current_streak BETWEEN 2 AND 3 THEN '2-3 ngày'
            WHEN current_streak BETWEEN 4 AND 7 THEN '4-7 ngày'
            WHEN current_streak BETWEEN 8 AND 14 THEN '8-14 ngày'
            ELSE '15+ ngày'
          END AS bucket,
          COUNT(*)::int AS users,
          COALESCE(SUM(reset_count), 0)::int AS resets
        FROM stats_streaks
        GROUP BY 1
      `,
      // Lesson engagement
      sql`
        SELECT
          level, lesson_id, views_vocab, views_grammar, views_texts, audio_plays, known_toggles,
          (views_vocab + views_grammar + views_texts)::int AS total_views
        FROM stats_lessons
        ORDER BY total_views DESC, level ASC, lesson_id ASC
        LIMIT 30
      `,
      // Hardest vocabulary
      sql`
        SELECT
          level, lesson_id, hanzi, pinyin, vn,
          fc_right::int, fc_wrong::int, popup_clicks::int, stroke_quizzes::int, stroke_mistakes::int,
          CASE
            WHEN (fc_right + fc_wrong) > 0 THEN ROUND((fc_wrong::numeric * 100.0) / (fc_right + fc_wrong), 1)
            ELSE 0
          END AS wrong_rate
        FROM stats_vocab_difficulty
        WHERE (fc_wrong + stroke_mistakes + popup_clicks) > 0
        ORDER BY fc_wrong DESC, stroke_mistakes DESC, popup_clicks DESC
        LIMIT 25
      `,
      // Zero-result search queries
      sql`
        SELECT level, query, hit_count::int, zero_result_count::int, last_searched_at
        FROM stats_searches
        WHERE zero_result_count > 0
        ORDER BY zero_result_count DESC, last_searched_at DESC
        LIMIT 20
      `,
      // Top search queries overall
      sql`
        SELECT level, query, hit_count::int, zero_result_count::int, last_searched_at
        FROM stats_searches
        ORDER BY hit_count DESC, last_searched_at DESC
        LIMIT 20
      `,
      // Asset & client errors
      sql`
        SELECT id, error_type, level, target_url, message, browser_name, os_name, hit_count::int, last_seen_at
        FROM system_errors
        ORDER BY last_seen_at DESC
        LIMIT 25
      `,
      // Visitor IPs (recent & high activity, joined with active block flag)
      sql`
        SELECT
          v.ip_address::text AS ip,
          v.country, v.city, v.device_type, v.os_name, v.browser_name,
          v.total_hits::int, v.failed_admin_logins::int, v.last_path,
          v.first_seen_at, v.last_seen_at,
          EXISTS (
            SELECT 1 FROM blocked_ips b
            WHERE v.ip_address <<= b.ip_cidr
              AND (b.expires_at IS NULL OR b.expires_at > NOW())
          ) AS is_blocked
        FROM visitor_ip_summary v
        ORDER BY v.last_seen_at DESC
        LIMIT 60
      `,
      // Admin login logs
      sql`
        SELECT
          l.id, l.username_tried, l.ip_address::text AS ip,
          l.country, l.city, l.device_type, l.os_name, l.browser_name,
          l.status, l.created_at,
          EXISTS (
            SELECT 1 FROM blocked_ips b
            WHERE l.ip_address <<= b.ip_cidr
              AND (b.expires_at IS NULL OR b.expires_at > NOW())
          ) AS is_blocked
        FROM admin_login_logs l
        ORDER BY l.created_at DESC
        LIMIT 50
      `
    ]);

    const act = kpiActivity[0] || {};
    const vis = kpiVisitors[0] || {};

    return res.status(200).json({
      days,
      currentIp: client.ip,
      edgeConfig: getEdgeConfigStatus(),
      kpis: {
        dau: Number(vis.dau || 0),
        wau: Number(vis.wau || 0),
        mau: Number(vis.mau || 0),
        pageViews: Number(act.page_views || 0),
        flashcardAnswers: Number(act.flashcard_answers || 0),
        strokeQuizzes: Number(act.stroke_quizzes || 0),
        audioPlays: Number(act.audio_plays || 0),
        wordLookups: Number(act.word_lookups || 0),
        knownToggles: Number(act.known_toggles || 0),
        activeBlocks: Number(activeBlocksCount[0]?.cnt || 0)
      },
      dailyTrend,
      levelBreakdown,
      devices: {
        types: deviceBreakdown,
        os: osBreakdown,
        browsers: browserBreakdown
      },
      streakBuckets,
      topLessons,
      hardestVocab,
      searches: {
        zeroResults: zeroSearches,
        top: topSearches
      },
      systemErrors,
      visitorIps,
      loginLogs
    });
  } catch (err) {
    console.error('[api/admin/stats]', err);
    return res.status(500).json({
      error: err?.message || 'Không thể tải dữ liệu thống kê từ Neon.'
    });
  }
}

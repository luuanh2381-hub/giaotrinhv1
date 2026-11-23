import { getDb, readJsonBody, vietnamDateStr } from '../lib/db.js';
import { getClientInfo } from '../lib/ip-match.js';

const VALID_LEVELS = new Set(['ROOT', 'HSK1', 'HSK2', 'HSK3', 'HSK4']);

function cleanLevel(val) {
  const s = String(val || 'ROOT').toUpperCase();
  return VALID_LEVELS.has(s) ? s : 'ROOT';
}

function cleanStr(val, max = 120) {
  return String(val || '').trim().slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    const events = Array.isArray(body?.events) ? body.events.slice(0, 60) : [];
    if (!events.length) {
      return res.status(200).json({ ok: true, processed: 0 });
    }

    const visitorId = cleanStr(body?.visitorId, 64) || 'anon';
    const lastPath = cleanStr(body?.path || '/', 200);
    const client = getClientInfo(req);
    const today = vietnamDateStr();
    const sql = getDb();

    // Pre-aggregate batch in memory to minimize Neon roundtrips
    const dailyMap = new Map(); // level -> counters
    const lessonMap = new Map(); // level|lessonId -> counters
    const vocabMap = new Map(); // level|lessonId|hanzi -> counters
    const searchMap = new Map(); // level|query -> counters
    const errorMap = new Map(); // type|level|target -> info
    let streakUpdate = null;
    let primaryLevel = 'ROOT';

    const getDaily = (lvl) => {
      if (!dailyMap.has(lvl)) {
        dailyMap.set(lvl, {
          page_views: 0,
          flashcard_answers: 0,
          stroke_quizzes: 0,
          audio_plays: 0,
          word_lookups: 0,
          known_toggles: 0,
          streak_events: 0
        });
      }
      return dailyMap.get(lvl);
    };

    const getLesson = (lvl, lid) => {
      const k = `${lvl}|${lid}`;
      if (!lessonMap.has(k)) {
        lessonMap.set(k, {
          level: lvl,
          lessonId: lid,
          views_vocab: 0,
          views_grammar: 0,
          views_texts: 0,
          audio_plays: 0,
          known_toggles: 0
        });
      }
      return lessonMap.get(k);
    };

    const getVocab = (lvl, lid, hanzi, pinyin, vn) => {
      const k = `${lvl}|${lid}|${hanzi}`;
      if (!vocabMap.has(k)) {
        vocabMap.set(k, {
          level: lvl,
          lessonId: lid,
          hanzi,
          pinyin: cleanStr(pinyin, 120),
          vn: cleanStr(vn, 200),
          fc_right: 0,
          fc_wrong: 0,
          popup_clicks: 0,
          stroke_quizzes: 0,
          stroke_mistakes: 0
        });
      }
      return vocabMap.get(k);
    };

    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const type = cleanStr(ev.type, 32);
      const lvl = cleanLevel(ev.level);
      if (lvl !== 'ROOT') primaryLevel = lvl;
      const lid = Number.isInteger(ev.lessonId) && ev.lessonId > 0 && ev.lessonId <= 100 ? ev.lessonId : 0;

      if (type === 'page_view') {
        getDaily(lvl).page_views += 1;
      } else if (type === 'lesson_view' && lid > 0) {
        getDaily(lvl).page_views += 1;
        const l = getLesson(lvl, lid);
        if (ev.tab === 'grammar') l.views_grammar += 1;
        else if (ev.tab === 'texts') l.views_texts += 1;
        else l.views_vocab += 1;
      } else if (type === 'flashcard') {
        getDaily(lvl).flashcard_answers += 1;
        const hanzi = cleanStr(ev.hanzi, 64);
        if (hanzi) {
          const v = getVocab(lvl, lid, hanzi, ev.pinyin, ev.vn);
          if (ev.correct) v.fc_right += 1;
          else v.fc_wrong += 1;
        }
      } else if (type === 'stroke_quiz') {
        getDaily(lvl).stroke_quizzes += 1;
        const hanzi = cleanStr(ev.hanzi, 64);
        if (hanzi) {
          const v = getVocab(lvl, lid, hanzi, ev.pinyin, ev.vn);
          v.stroke_quizzes += 1;
          const mistakes = Math.max(0, Math.min(50, Number(ev.mistakes) || 0));
          v.stroke_mistakes += mistakes;
        }
      } else if (type === 'word_lookup') {
        getDaily(lvl).word_lookups += 1;
        const hanzi = cleanStr(ev.hanzi, 64);
        if (hanzi) {
          const v = getVocab(lvl, lid, hanzi, ev.pinyin, ev.vn);
          v.popup_clicks += 1;
        }
      } else if (type === 'audio_play') {
        getDaily(lvl).audio_plays += 1;
        if (lid > 0) getLesson(lvl, lid).audio_plays += 1;
      } else if (type === 'known_toggle') {
        getDaily(lvl).known_toggles += 1;
        if (lid > 0) getLesson(lvl, lid).known_toggles += 1;
      } else if (type === 'search') {
        const q = cleanStr(ev.query, 120).toLowerCase();
        if (q.length >= 1) {
          const sk = `${lvl}|${q}`;
          if (!searchMap.has(sk)) {
            searchMap.set(sk, { level: lvl, query: q, hit_count: 0, zero_result_count: 0 });
          }
          const s = searchMap.get(sk);
          s.hit_count += 1;
          if (Number(ev.resultCount) === 0) s.zero_result_count += 1;
        }
      } else if (type === 'streak') {
        getDaily(lvl).streak_events += 1;
        const count = Math.max(1, Math.min(3650, Number(ev.count) || 1));
        const event = cleanStr(ev.event, 16) || 'same';
        streakUpdate = { count, event };
      } else if (type === 'error') {
        const errType = cleanStr(ev.errorType || 'js_error', 32);
        const target = cleanStr(ev.targetUrl, 300);
        const msg = cleanStr(ev.message, 300);
        const ek = `${errType}|${lvl}|${target}`;
        if (!errorMap.has(ek)) {
          errorMap.set(ek, { errorType: errType, level: lvl, target, msg, count: 0 });
        }
        errorMap.get(ek).count += 1;
      }
    }

    const queries = [];

    // 1. Visitor IP Summary (1 row per IP)
    queries.push(sql`
      INSERT INTO visitor_ip_summary (
        ip_address, country, city, device_type, os_name, browser_name, total_hits, last_path, first_seen_at, last_seen_at
      )
      VALUES (
        ${client.ip}::inet, ${client.country}, ${client.city}, ${client.device_type},
        ${client.os_name}, ${client.browser_name}, ${events.length}, ${lastPath}, NOW(), NOW()
      )
      ON CONFLICT (ip_address) DO UPDATE SET
        country = COALESCE(NULLIF(EXCLUDED.country, ''), visitor_ip_summary.country),
        city = COALESCE(NULLIF(EXCLUDED.city, ''), visitor_ip_summary.city),
        device_type = EXCLUDED.device_type,
        os_name = EXCLUDED.os_name,
        browser_name = EXCLUDED.browser_name,
        total_hits = visitor_ip_summary.total_hits + EXCLUDED.total_hits,
        last_path = EXCLUDED.last_path,
        last_seen_at = NOW()
    `);

    // 2. Daily unique visitor + device breakdown
    queries.push(sql`
      INSERT INTO stats_daily_visitors (stat_date, visitor_id, level, device_type, os_name, browser_name, country)
      VALUES (${today}::date, ${visitorId}, ${primaryLevel}, ${client.device_type}, ${client.os_name}, ${client.browser_name}, ${client.country})
      ON CONFLICT (stat_date, visitor_id) DO NOTHING
    `);

    // 3. Daily stats per level
    for (const [lvl, d] of dailyMap.entries()) {
      queries.push(sql`
        INSERT INTO stats_daily (
          stat_date, level, page_views, flashcard_answers, stroke_quizzes,
          audio_plays, word_lookups, known_toggles, streak_events
        )
        VALUES (
          ${today}::date, ${lvl}, ${d.page_views}, ${d.flashcard_answers}, ${d.stroke_quizzes},
          ${d.audio_plays}, ${d.word_lookups}, ${d.known_toggles}, ${d.streak_events}
        )
        ON CONFLICT (stat_date, level) DO UPDATE SET
          page_views = stats_daily.page_views + EXCLUDED.page_views,
          flashcard_answers = stats_daily.flashcard_answers + EXCLUDED.flashcard_answers,
          stroke_quizzes = stats_daily.stroke_quizzes + EXCLUDED.stroke_quizzes,
          audio_plays = stats_daily.audio_plays + EXCLUDED.audio_plays,
          word_lookups = stats_daily.word_lookups + EXCLUDED.word_lookups,
          known_toggles = stats_daily.known_toggles + EXCLUDED.known_toggles,
          streak_events = stats_daily.streak_events + EXCLUDED.streak_events
      `);
    }

    // 4. Per-lesson stats
    for (const l of lessonMap.values()) {
      queries.push(sql`
        INSERT INTO stats_lessons (
          level, lesson_id, views_vocab, views_grammar, views_texts, audio_plays, known_toggles, updated_at
        )
        VALUES (
          ${l.level}, ${l.lessonId}, ${l.views_vocab}, ${l.views_grammar},
          ${l.views_texts}, ${l.audio_plays}, ${l.known_toggles}, NOW()
        )
        ON CONFLICT (level, lesson_id) DO UPDATE SET
          views_vocab = stats_lessons.views_vocab + EXCLUDED.views_vocab,
          views_grammar = stats_lessons.views_grammar + EXCLUDED.views_grammar,
          views_texts = stats_lessons.views_texts + EXCLUDED.views_texts,
          audio_plays = stats_lessons.audio_plays + EXCLUDED.audio_plays,
          known_toggles = stats_lessons.known_toggles + EXCLUDED.known_toggles,
          updated_at = NOW()
      `);
    }

    // 5. Vocabulary difficulty stats
    for (const v of vocabMap.values()) {
      queries.push(sql`
        INSERT INTO stats_vocab_difficulty (
          level, lesson_id, hanzi, pinyin, vn, fc_right, fc_wrong,
          popup_clicks, stroke_quizzes, stroke_mistakes, updated_at
        )
        VALUES (
          ${v.level}, ${v.lessonId}, ${v.hanzi}, ${v.pinyin}, ${v.vn},
          ${v.fc_right}, ${v.fc_wrong}, ${v.popup_clicks}, ${v.stroke_quizzes}, ${v.stroke_mistakes}, NOW()
        )
        ON CONFLICT (level, lesson_id, hanzi) DO UPDATE SET
          pinyin = COALESCE(NULLIF(EXCLUDED.pinyin, ''), stats_vocab_difficulty.pinyin),
          vn = COALESCE(NULLIF(EXCLUDED.vn, ''), stats_vocab_difficulty.vn),
          fc_right = stats_vocab_difficulty.fc_right + EXCLUDED.fc_right,
          fc_wrong = stats_vocab_difficulty.fc_wrong + EXCLUDED.fc_wrong,
          popup_clicks = stats_vocab_difficulty.popup_clicks + EXCLUDED.popup_clicks,
          stroke_quizzes = stats_vocab_difficulty.stroke_quizzes + EXCLUDED.stroke_quizzes,
          stroke_mistakes = stats_vocab_difficulty.stroke_mistakes + EXCLUDED.stroke_mistakes,
          updated_at = NOW()
      `);
    }

    // 6. Search keyword stats
    for (const s of searchMap.values()) {
      queries.push(sql`
        INSERT INTO stats_searches (level, query, hit_count, zero_result_count, last_searched_at)
        VALUES (${s.level}, ${s.query}, ${s.hit_count}, ${s.zero_result_count}, NOW())
        ON CONFLICT (level, query) DO UPDATE SET
          hit_count = stats_searches.hit_count + EXCLUDED.hit_count,
          zero_result_count = stats_searches.zero_result_count + EXCLUDED.zero_result_count,
          last_searched_at = NOW()
      `);
    }

    // 7. Streak snapshot
    if (streakUpdate) {
      const resetInc = streakUpdate.event === 'reset' ? 1 : 0;
      queries.push(sql`
        INSERT INTO stats_streaks (visitor_id, current_streak, max_streak, reset_count, last_event, last_active_date, updated_at)
        VALUES (${visitorId}, ${streakUpdate.count}, ${streakUpdate.count}, ${resetInc}, ${streakUpdate.event}, ${today}::date, NOW())
        ON CONFLICT (visitor_id) DO UPDATE SET
          current_streak = EXCLUDED.current_streak,
          max_streak = GREATEST(stats_streaks.max_streak, EXCLUDED.current_streak),
          reset_count = stats_streaks.reset_count + ${resetInc}::int,
          last_event = EXCLUDED.last_event,
          last_active_date = EXCLUDED.last_active_date,
          updated_at = NOW()
      `);
    }

    // 8. System / Asset Errors
    for (const e of errorMap.values()) {
      queries.push(sql`
        INSERT INTO system_errors (error_type, level, target_url, message, browser_name, os_name, hit_count, last_seen_at)
        VALUES (${e.errorType}, ${e.level}, ${e.target}, ${e.msg}, ${client.browser_name}, ${client.os_name}, ${e.count}, NOW())
        ON CONFLICT (error_type, level, target_url) DO UPDATE SET
          message = COALESCE(NULLIF(EXCLUDED.message, ''), system_errors.message),
          browser_name = EXCLUDED.browser_name,
          os_name = EXCLUDED.os_name,
          hit_count = system_errors.hit_count + EXCLUDED.hit_count,
          last_seen_at = NOW()
      `);
    }

    await Promise.all(queries);

    return res.status(200).json({ ok: true, processed: events.length });
  } catch (err) {
    console.error('[api/track]', err);
    return res.status(500).json({ error: 'Tracking failed' });
  }
}

/* ===== Lightweight Batched Telemetry Tracker for HSK Admin Analytics (Neon) ===== */
(function () {
  const VISITOR_KEY = 'hsk_visitor_id_v1';
  const ENDPOINT = '/api/track';
  const FLUSH_INTERVAL_MS = 35000;
  const MAX_BATCH = 20;

  // Skip network tracking if opened directly from local filesystem
  const ENABLED = typeof location !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:');

  function getVisitorId() {
    try {
      let id = localStorage.getItem(VISITOR_KEY);
      if (!id) {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          id = crypto.randomUUID();
        } else {
          id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch {
      return 'anon_' + Math.random().toString(36).slice(2, 10);
    }
  }

  const visitorId = getVisitorId();
  let queue = [];
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer || !ENABLED) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  }

  function push(event) {
    if (!ENABLED || !event || !event.type) return;
    queue.push(event);
    if (queue.length >= MAX_BATCH) {
      flush();
    } else {
      scheduleFlush();
    }
  }

  function flush(useBeacon = false) {
    if (!ENABLED || !queue.length) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const batch = queue.splice(0, 60);
    const payload = JSON.stringify({
      visitorId,
      path: (location.pathname || '/') + (location.hash || ''),
      events: batch
    });

    try {
      if (useBeacon && navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(ENDPOINT, blob);
        return;
      }
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(() => {});
    } catch {
      // Silently ignore network errors (e.g. offline or local static preview)
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));

  // Capture unexpected JS runtime errors
  window.addEventListener('error', (e) => {
    if (!e || !e.message) return;
    const lvl = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.level) ? APP_CONFIG.level : 'ROOT';
    push({
      type: 'error',
      errorType: 'js_error',
      level: lvl,
      targetUrl: String(e.filename || location.pathname || '').slice(0, 240),
      message: String(e.message || '').slice(0, 240)
    });
  });

  window.HSKTracker = {
    trackPageView(level) {
      push({ type: 'page_view', level: level || 'ROOT' });
    },
    trackLesson(level, lessonId, tab) {
      push({
        type: 'lesson_view',
        level: level || 'ROOT',
        lessonId: Number(lessonId) || 0,
        tab: tab || 'vocab'
      });
    },
    trackFlashcard(level, vocab, correct) {
      if (!vocab) return;
      push({
        type: 'flashcard',
        level: level || 'ROOT',
        lessonId: Number(vocab.lessonId) || 0,
        hanzi: vocab.hanzi || '',
        pinyin: vocab.pinyin || '',
        vn: vocab.vn || '',
        correct: Boolean(correct)
      });
    },
    trackStrokeQuiz(level, vocab, mistakes) {
      if (!vocab) return;
      push({
        type: 'stroke_quiz',
        level: level || 'ROOT',
        lessonId: Number(vocab.lessonId) || 0,
        hanzi: vocab.hanzi || '',
        pinyin: vocab.pinyin || '',
        vn: vocab.vn || '',
        mistakes: Number(mistakes) || 0
      });
    },
    trackWordLookup(level, vocab) {
      if (!vocab) return;
      push({
        type: 'word_lookup',
        level: level || 'ROOT',
        lessonId: Number(vocab.lessonId) || 0,
        hanzi: vocab.hanzi || '',
        pinyin: vocab.pinyin || '',
        vn: vocab.vn || ''
      });
    },
    trackAudio(level, lessonId) {
      push({
        type: 'audio_play',
        level: level || 'ROOT',
        lessonId: Number(lessonId) || 0
      });
    },
    trackKnown(level, lessonId) {
      push({
        type: 'known_toggle',
        level: level || 'ROOT',
        lessonId: Number(lessonId) || 0
      });
    },
    trackSearch(level, query, resultCount) {
      const q = String(query || '').trim();
      if (q.length < 2) return;
      push({
        type: 'search',
        level: level || 'ROOT',
        query: q.slice(0, 120),
        resultCount: Number(resultCount) || 0
      });
    },
    trackStreak(count, event) {
      const lvl = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.level) ? APP_CONFIG.level : 'ROOT';
      push({
        type: 'streak',
        level: lvl,
        count: Number(count) || 1,
        event: event || 'same'
      });
    },
    trackError(errorType, level, targetUrl, message) {
      push({
        type: 'error',
        errorType: errorType || 'js_error',
        level: level || 'ROOT',
        targetUrl: String(targetUrl || '').slice(0, 240),
        message: String(message || '').slice(0, 240)
      });
    },
    flush
  };
})();

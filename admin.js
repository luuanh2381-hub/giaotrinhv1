/* ===== HSK Admin Dashboard (Neon PostgreSQL + Vercel Edge Config) ===== */
(function () {
  const adminBtn = document.getElementById('adminBtn');
  const loginModal = document.getElementById('adminLoginModal');
  const dashModal = document.getElementById('adminDashboardModal');
  const loginForm = document.getElementById('adminLoginForm');
  const userInput = document.getElementById('adminUser');
  const passInput = document.getElementById('adminPass');
  const loginSubmitBtn = document.getElementById('adminLoginSubmit');
  const errorEl = document.getElementById('adminLoginError');
  const dashBody = document.getElementById('adminDashBody');

  if (!adminBtn || !loginModal || !dashModal) return;

  const state = {
    authenticated: false,
    user: null,
    currentIp: '',
    edgeConfig: null,
    days: 30,
    activeTab: 'overview',
    stats: null,
    blocks: [],
    loading: false,
    toast: null
  };

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString('vi-VN');
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        dateStyle: 'short',
        timeStyle: 'short'
      }).format(new Date(iso));
    } catch {
      return String(iso);
    }
  }

  function showToast(msg, kind = 'ok') {
    state.toast = { msg, kind };
    renderDashboard();
    setTimeout(() => {
      if (state.toast && state.toast.msg === msg) {
        state.toast = null;
        const el = document.getElementById('adminToast');
        if (el) el.remove();
      }
    }, 4500);
  }

  function updateAdminBtn() {
    adminBtn.textContent = state.authenticated ? 'Quản trị (Admin)' : 'Đăng nhập Admin';
  }

  async function apiJson(url, options = {}) {
    const resp = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || `Yêu cầu thất bại (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  async function checkSession() {
    try {
      const data = await apiJson('/api/admin/me');
      if (data.authenticated) {
        state.authenticated = true;
        state.user = data.user;
        state.currentIp = data.currentIp || '';
        state.edgeConfig = data.edgeConfig || null;
      } else {
        state.authenticated = false;
        state.user = null;
      }
    } catch {
      state.authenticated = false;
    }
    updateAdminBtn();
  }

  async function loadAllData() {
    state.loading = true;
    renderDashboard();
    try {
      const [statsRes, blocksRes] = await Promise.all([
        apiJson(`/api/admin/stats?days=${state.days}`),
        apiJson('/api/admin/blocks')
      ]);
      state.stats = statsRes;
      state.blocks = blocksRes.blocks || [];
      state.currentIp = statsRes.currentIp || blocksRes.currentIp || state.currentIp;
      state.edgeConfig = statsRes.edgeConfig || blocksRes.edgeConfig || state.edgeConfig;
    } catch (err) {
      if (err.status === 401) {
        state.authenticated = false;
        updateAdminBtn();
        dashModal.classList.remove('show');
        openLogin();
        return;
      }
      showToast(err.message || 'Không thể tải dữ liệu từ Neon.', 'err');
    } finally {
      state.loading = false;
      renderDashboard();
    }
  }

  function openLogin() {
    errorEl.textContent = '';
    loginForm.reset();
    loginModal.classList.add('show');
    setTimeout(() => userInput.focus(), 50);
  }

  function openDashboard() {
    dashModal.classList.add('show');
    loadAllData();
  }

  async function blockIp(ip, { scope = 'site_wide', duration_hours = 24, reason = '' } = {}) {
    try {
      const res = await apiJson('/api/admin/blocks', {
        method: 'POST',
        body: JSON.stringify({ ip_cidr: ip, scope, duration_hours, reason })
      });
      const syncMsg = res.syncResult?.synced
        ? 'Đã đồng bộ lên Vercel Edge Config (hiệu lực ngay).'
        : (res.syncResult?.reason ? `Đã lưu Neon, chưa sync Edge Config: ${res.syncResult.reason}` : 'Đã lưu vào Neon.');
      showToast(`Đã chặn ${res.block?.ip_cidr || ip}. ${syncMsg}`, res.syncResult?.synced ? 'ok' : 'warn');
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'err');
    }
  }

  async function unblockIp(id, ipLabel) {
    try {
      const res = await apiJson(`/api/admin/blocks?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const syncMsg = res.syncResult?.synced ? 'Đã đồng bộ Edge Config.' : 'Đã cập nhật trên Neon.';
      showToast(`Đã gỡ chặn ${ipLabel}. ${syncMsg}`, 'ok');
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'err');
    }
  }

  async function resyncEdgeConfig() {
    try {
      const res = await apiJson('/api/admin/blocks', {
        method: 'POST',
        body: JSON.stringify({ action: 'resync' })
      });
      if (res.syncResult?.synced) {
        showToast(`Đã đồng bộ ${res.syncResult.count} IP lên Vercel Edge Config thành công!`, 'ok');
      } else {
        showToast(res.syncResult?.reason || 'Đồng bộ Edge Config chưa thành công.', 'warn');
      }
    } catch (err) {
      showToast(err.message, 'err');
    }
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportJsonReport() {
    if (!state.stats) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      stats: state.stats,
      blocks: state.blocks
    };
    downloadFile(`hsk-admin-report-${state.days}d.json`, JSON.stringify(payload, null, 2), 'application/json');
  }

  function exportCsvHardestVocab() {
    const rows = state.stats?.hardestVocab || [];
    const header = ['Level', 'Lesson', 'Hanzi', 'Pinyin', 'VN', 'FC_Right', 'FC_Wrong', 'Wrong_Rate_%', 'Stroke_Mistakes', 'Popup_Clicks'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const vals = [r.level, r.lesson_id, r.hanzi, r.pinyin || '', r.vn || '', r.fc_right, r.fc_wrong, r.wrong_rate, r.stroke_mistakes, r.popup_clicks];
      lines.push(vals.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    downloadFile(`hsk-hardest-vocab.csv`, '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
  }

  function exportCsvVisitorIps() {
    const rows = state.stats?.visitorIps || [];
    const header = ['IP', 'Country', 'City', 'Device', 'OS', 'Browser', 'Total_Hits', 'Failed_Admin_Logins', 'Blocked', 'Last_Seen'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const vals = [r.ip, r.country || '', r.city || '', r.device_type || '', r.os_name || '', r.browser_name || '', r.total_hits, r.failed_admin_logins, r.is_blocked ? 'YES' : 'NO', r.last_seen_at || ''];
      lines.push(vals.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    downloadFile(`hsk-visitor-ips.csv`, '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
  }

  function renderBarList(items, labelFn, valueFn, colorClass = '') {
    if (!items || !items.length) return '<div class="adm-empty">Chưa có dữ liệu.</div>';
    const max = Math.max(1, ...items.map(valueFn));
    return `<div class="adm-bars">${items.map(it => {
      const val = valueFn(it);
      const pct = Math.max(4, Math.round((val / max) * 100));
      return `
        <div class="adm-bar-row">
          <div class="adm-bar-lbl">${esc(labelFn(it))}</div>
          <div class="adm-bar-track"><div class="adm-bar-fill ${colorClass}" style="width:${pct}%"></div></div>
          <div class="adm-bar-val">${fmtNum(val)}</div>
        </div>
      `;
    }).join('')}</div>`;
  }

  function renderOverviewTab(s) {
    const k = s.kpis || {};
    const trend = s.dailyTrend || [];
    const maxViews = Math.max(1, ...trend.map(d => d.views || 0));

    const trendHtml = trend.length ? `
      <div class="adm-chart">
        ${trend.map(d => {
          const h = Math.max(6, Math.round(((d.views || 0) / maxViews) * 100));
          const shortDate = (d.date || '').slice(5);
          return `
            <div class="adm-chart-col" title="${esc(d.date)}: ${fmtNum(d.views)} lượt xem · ${fmtNum(d.visitors)} người học · ${fmtNum(d.flashcards)} flashcard">
              <div class="adm-chart-bar-wrap"><div class="adm-chart-bar" style="height:${h}%"></div></div>
              <div class="adm-chart-lbl">${esc(shortDate)}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '<div class="adm-empty">Chưa có dữ liệu lượt học trong khoảng thời gian này.</div>';

    const levelColors = { HSK1: 'lvl-1', HSK2: 'lvl-2', HSK3: 'lvl-3', HSK4: 'lvl-4' };
    const levels = ['HSK1', 'HSK2', 'HSK3', 'HSK4'].map(lv => {
      const found = (s.levelBreakdown || []).find(x => x.level === lv);
      return found || { level: lv, page_views: 0, flashcard_answers: 0, stroke_quizzes: 0, audio_plays: 0 };
    });
    const maxLvl = Math.max(1, ...levels.map(x => x.page_views));

    const deviceMap = { mobile: 'Điện thoại', desktop: 'Máy tính', tablet: 'Máy tính bảng', bot: 'Bot / Tool' };
    const streakOrder = ['1 ngày', '2-3 ngày', '4-7 ngày', '8-14 ngày', '15+ ngày'];
    const streaks = streakOrder.map(b => {
      const found = (s.streakBuckets || []).find(x => x.bucket === b);
      return { bucket: b, users: found ? found.users : 0 };
    });

    return `
      <div class="adm-kpi-grid">
        <div class="adm-kpi"><div class="k-num">${fmtNum(k.dau)}</div><div class="k-lbl">Người học hôm nay (DAU)</div></div>
        <div class="adm-kpi"><div class="k-num">${fmtNum(k.wau)}</div><div class="k-lbl">7 ngày qua (WAU)</div></div>
        <div class="adm-kpi"><div class="k-num">${fmtNum(k.mau)}</div><div class="k-lbl">30 ngày qua (MAU)</div></div>
        <div class="adm-kpi"><div class="k-num">${fmtNum(k.pageViews)}</div><div class="k-lbl">Lượt xem (${state.days}n)</div></div>
        <div class="adm-kpi"><div class="k-num">${fmtNum(k.flashcardAnswers)}</div><div class="k-lbl">Lượt Flashcard</div></div>
        <div class="adm-kpi"><div class="k-num">${fmtNum(k.strokeQuizzes)}</div><div class="k-lbl">Luyện viết nét</div></div>
        <div class="adm-kpi"><div class="k-num">${fmtNum(k.audioPlays)}</div><div class="k-lbl">Lượt nghe Audio</div></div>
        <div class="adm-kpi warn"><div class="k-num">${fmtNum(k.activeBlocks)}</div><div class="k-lbl">IP đang bị chặn</div></div>
      </div>

      <div class="adm-card">
        <div class="adm-card-title">Lượt học theo ngày (${state.days} ngày gần nhất)</div>
        ${trendHtml}
      </div>

      <div class="adm-two-col">
        <div class="adm-card">
          <div class="adm-card-title">Phân bố theo cấp độ HSK1 – HSK4</div>
          <div class="adm-bars">
            ${levels.map(l => {
              const pct = l.page_views ? Math.max(4, Math.round((l.page_views / maxLvl) * 100)) : 0;
              return `
                <div class="adm-bar-row">
                  <div class="adm-bar-lbl"><strong>${l.level}</strong></div>
                  <div class="adm-bar-track"><div class="adm-bar-fill ${levelColors[l.level]}" style="width:${pct}%"></div></div>
                  <div class="adm-bar-val">${fmtNum(l.page_views)}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Phân bố chuỗi ngày học (Streak)</div>
          ${renderBarList(streaks, x => x.bucket, x => x.users, 'lvl-3')}
        </div>
      </div>

      <div class="adm-three-col">
        <div class="adm-card">
          <div class="adm-card-title">Loại thiết bị</div>
          ${renderBarList(s.devices?.types, x => deviceMap[x.name] || x.name, x => x.cnt)}
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Hệ điều hành</div>
          ${renderBarList(s.devices?.os, x => x.name, x => x.cnt, 'lvl-4')}
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Trình duyệt</div>
          ${renderBarList(s.devices?.browsers, x => x.name, x => x.cnt, 'lvl-2')}
        </div>
      </div>
    `;
  }

  function renderLearningTab(s) {
    const hard = s.hardestVocab || [];
    const lessons = s.topLessons || [];
    const zeroS = s.searches?.zeroResults || [];
    const topS = s.searches?.top || [];
    const errs = s.systemErrors || [];

    return `
      <div class="adm-card">
        <div class="adm-card-title">Top từ vựng khó nhớ / hay sai nhất</div>
        ${hard.length ? `
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead><tr><th>Cấp / Bài</th><th>Hán tự</th><th>Nghĩa</th><th>Flashcard (Sai/Đúng)</th><th>Tỷ lệ sai</th><th>Lỗi nét</th><th>Tra bài khóa</th></tr></thead>
              <tbody>
                ${hard.map(r => `
                  <tr>
                    <td><span class="adm-pill">${esc(r.level)} · B${r.lesson_id}</span></td>
                    <td><strong class="hanzi">${esc(r.hanzi)}</strong> <span class="adm-sub">${esc(r.pinyin || '')}</span></td>
                    <td>${esc(r.vn || '')}</td>
                    <td><span class="txt-red">${fmtNum(r.fc_wrong)}</span> / <span class="txt-green">${fmtNum(r.fc_right)}</span></td>
                    <td><strong>${r.wrong_rate}%</strong></td>
                    <td>${fmtNum(r.stroke_mistakes)}</td>
                    <td>${fmtNum(r.popup_clicks)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="adm-empty">Chưa có dữ liệu Flashcard / viết nét / tra từ.</div>'}
      </div>

      <div class="adm-card">
        <div class="adm-card-title">Thống kê lượt học theo bài (Top 30)</div>
        ${lessons.length ? `
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead><tr><th>Cấp độ</th><th>Bài</th><th>Từ vựng</th><th>Ngữ pháp</th><th>Bài khóa</th><th>Audio</th><th>Đánh dấu thuộc</th></tr></thead>
              <tbody>
                ${lessons.map(l => `
                  <tr>
                    <td><span class="adm-pill">${esc(l.level)}</span></td>
                    <td><strong>Bài ${l.lesson_id}</strong></td>
                    <td>${fmtNum(l.views_vocab)}</td>
                    <td>${fmtNum(l.views_grammar)}</td>
                    <td>${fmtNum(l.views_texts)}</td>
                    <td>${fmtNum(l.audio_plays)}</td>
                    <td>${fmtNum(l.known_toggles)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="adm-empty">Chưa có dữ liệu lượt xem bài học.</div>'}
      </div>

      <div class="adm-two-col">
        <div class="adm-card">
          <div class="adm-card-title">Từ khóa tìm không thấy kết quả</div>
          ${zeroS.length ? `
            <div class="adm-table-wrap">
              <table class="adm-table">
                <thead><tr><th>Cấp</th><th>Từ khóa</th><th>Lượt 0 KQ</th></tr></thead>
                <tbody>
                  ${zeroS.map(q => `<tr><td>${esc(q.level)}</td><td><strong>${esc(q.query)}</strong></td><td class="txt-red">${fmtNum(q.zero_result_count)}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          ` : '<div class="adm-empty">Chưa có truy vấn tìm không thấy kết quả.</div>'}
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Top từ khóa được tìm nhiều nhất</div>
          ${topS.length ? `
            <div class="adm-table-wrap">
              <table class="adm-table">
                <thead><tr><th>Cấp</th><th>Từ khóa</th><th>Lượt tìm</th></tr></thead>
                <tbody>
                  ${topS.map(q => `<tr><td>${esc(q.level)}</td><td><strong>${esc(q.query)}</strong></td><td>${fmtNum(q.hit_count)}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          ` : '<div class="adm-empty">Chưa có dữ liệu tìm kiếm.</div>'}
        </div>
      </div>

      <div class="adm-card">
        <div class="adm-card-title">Cảnh báo lỗi tài nguyên (Audio / HanziWriter / JS)</div>
        ${errs.length ? `
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead><tr><th>Loại lỗi</th><th>Cấp</th><th>Đường dẫn / Ký tự</th><th>Chi tiết</th><th>Số lần</th><th>Lần cuối</th></tr></thead>
              <tbody>
                ${errs.map(e => `
                  <tr>
                    <td><span class="adm-pill danger">${esc(e.error_type)}</span></td>
                    <td>${esc(e.level)}</td>
                    <td class="adm-mono">${esc(e.target_url)}</td>
                    <td>${esc(e.message)}</td>
                    <td><strong>${fmtNum(e.hit_count)}</strong></td>
                    <td>${fmtDateTime(e.last_seen_at)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="adm-empty">Tuyệt vời — chưa ghi nhận lỗi audio hay lỗi hệ thống nào.</div>'}
      </div>
    `;
  }

  function renderSecurityTab(s) {
    const ec = state.edgeConfig || {};
    const ecBanner = ec.configured
      ? `<div class="adm-status-bar ok">
           <span><strong>Vercel Global Config đã kết nối</strong> (${esc(ec.edgeConfigId)}) · Chặn IP toàn web HSK ở tầng Edge (~1ms).</span>
           <button type="button" class="btn btn-ghost adm-sm-btn" id="admResyncEdgeBtn">Đồng bộ lại Global Config</button>
         </div>`
      : `<div class="adm-status-bar warn">
           <span><strong>Chưa cấu hình đầy đủ Vercel Global Config</strong> (cần <code>GLOBAL_CONFIG</code> &amp; <code>VERCEL_API_TOKEN</code> trên Vercel để chặn toàn web ở tầng Edge). Danh sách chặn hiện vẫn lưu trên Neon.</span>
         </div>`;

    const activeBlocks = (state.blocks || []).filter(b => b.is_active);
    const visitorIps = s.visitorIps || [];

    return `
      ${ecBanner}

      <div class="adm-card">
        <div class="adm-card-title">Chặn IP / Dải mạng thủ công</div>
        <form id="admBlockForm" class="adm-block-form">
          <input type="text" id="admBlockIp" placeholder="IP hoặc CIDR (vd: 113.161.10.5 hoặc 113.161.10.0/24)" required>
          <select id="admBlockScope">
            <option value="site_wide">Chặn toàn web HSK</option>
            <option value="admin_only">Chỉ chặn đăng nhập Admin</option>
          </select>
          <select id="admBlockDuration">
            <option value="1">1 giờ</option>
            <option value="24" selected>24 giờ</option>
            <option value="168">7 ngày</option>
            <option value="720">30 ngày</option>
            <option value="">Vĩnh viễn</option>
          </select>
          <input type="text" id="admBlockReason" placeholder="Lý do chặn (tùy chọn)…">
          <button type="submit" class="btn btn-wrong adm-sm-btn">Chặn IP</button>
        </form>
      </div>

      <div class="adm-card">
        <div class="adm-card-title">Danh sách IP đang bị chặn (${activeBlocks.length})</div>
        ${activeBlocks.length ? `
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead><tr><th>IP / CIDR</th><th>Phạm vi</th><th>Lý do</th><th>Hết hạn</th><th>Thao tác</th></tr></thead>
              <tbody>
                ${activeBlocks.map(b => `
                  <tr>
                    <td class="adm-mono"><strong>${esc(b.ip_cidr)}</strong>${b.is_auto ? ' <span class="adm-pill warn">Auto</span>' : ''}</td>
                    <td><span class="adm-pill ${b.scope === 'site_wide' ? 'danger' : ''}">${b.scope === 'site_wide' ? 'Toàn web HSK' : 'Chỉ Admin'}</span></td>
                    <td>${esc(b.reason || '—')}</td>
                    <td>${b.expires_at ? fmtDateTime(b.expires_at) : '<strong>Vĩnh viễn</strong>'}</td>
                    <td><button type="button" class="btn btn-ghost adm-xs-btn js-unblock-btn" data-id="${b.id}" data-ip="${esc(b.ip_cidr)}">Gỡ chặn</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="adm-empty">Hiện không có địa chỉ IP nào đang bị chặn.</div>'}
      </div>

      <div class="adm-card">
        <div class="adm-card-title">IP truy cập web gần đây &amp; Loại thiết bị (Top 60 mới nhất)</div>
        ${visitorIps.length ? `
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead><tr><th>Địa chỉ IP</th><th>Vị trí</th><th>Thiết bị / OS / Trình duyệt</th><th>Lượt xem</th><th>Sai Admin</th><th>Lần cuối</th><th>Thao tác</th></tr></thead>
              <tbody>
                ${visitorIps.map(v => {
                  const isMe = v.ip === state.currentIp;
                  const loc = [v.city, v.country].filter(Boolean).join(', ') || '—';
                  const dev = `${v.device_type || '?'} · ${v.os_name || '?'} · ${v.browser_name || '?'}`;
                  let actionHtml = '';
                  if (isMe) {
                    actionHtml = '<span class="adm-pill ok">IP của bạn</span>';
                  } else if (v.is_blocked) {
                    actionHtml = '<span class="adm-pill danger">Đang bị chặn</span>';
                  } else {
                    actionHtml = `<button type="button" class="btn btn-wrong adm-xs-btn js-quick-block" data-ip="${esc(v.ip)}">Chặn 24h</button>`;
                  }
                  return `
                    <tr>
                      <td class="adm-mono"><strong>${esc(v.ip)}</strong></td>
                      <td>${esc(loc)}</td>
                      <td>${esc(dev)}</td>
                      <td>${fmtNum(v.total_hits)}</td>
                      <td class="${v.failed_admin_logins > 0 ? 'txt-red' : ''}">${fmtNum(v.failed_admin_logins)}</td>
                      <td>${fmtDateTime(v.last_seen_at)}</td>
                      <td>${actionHtml}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="adm-empty">Chưa có dữ liệu IP truy cập.</div>'}
      </div>
    `;
  }

  function renderSystemTab(s) {
    const logs = s.loginLogs || [];
    const statusLabel = {
      success: ['Thành công', 'ok'],
      failed: ['Sai mật khẩu', 'danger'],
      blocked: ['Bị chặn', 'warn'],
      auto_banned: ['Tự động khóa', 'danger']
    };

    return `
      <div class="adm-card">
        <div class="adm-card-title">Nhật ký đăng nhập Admin (IP &amp; Thiết bị)</div>
        ${logs.length ? `
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead><tr><th>Thời gian</th><th>Tài khoản</th><th>IP</th><th>Vị trí</th><th>Thiết bị / Trình duyệt</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
              <tbody>
                ${logs.map(l => {
                  const [lbl, cls] = statusLabel[l.status] || [l.status, ''];
                  const loc = [l.city, l.country].filter(Boolean).join(', ') || '—';
                  const isMe = l.ip === state.currentIp;
                  let act = '';
                  if (isMe) act = '<span class="adm-pill ok">IP của bạn</span>';
                  else if (l.is_blocked) act = '<span class="adm-pill danger">Đã chặn</span>';
                  else act = `<button type="button" class="btn btn-wrong adm-xs-btn js-quick-block" data-ip="${esc(l.ip)}">Chặn IP</button>`;
                  return `
                    <tr>
                      <td>${fmtDateTime(l.created_at)}</td>
                      <td><strong>${esc(l.username_tried)}</strong></td>
                      <td class="adm-mono">${esc(l.ip)}</td>
                      <td>${esc(loc)}</td>
                      <td>${esc(`${l.device_type || '?'} · ${l.os_name || '?'} · ${l.browser_name || '?'}`)}</td>
                      <td><span class="adm-pill ${cls}">${esc(lbl)}</span></td>
                      <td>${act}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="adm-empty">Chưa có nhật ký đăng nhập nào.</div>'}
      </div>

      <div class="adm-two-col">
        <div class="adm-card">
          <div class="adm-card-title">Đổi mật khẩu Admin</div>
          <form id="admPasswordForm" class="admin-form">
            <div class="admin-field">
              <label for="admCurPass">Mật khẩu hiện tại</label>
              <input type="password" id="admCurPass" required>
            </div>
            <div class="admin-field">
              <label for="admNewPass">Mật khẩu mới (tối thiểu 8 ký tự)</label>
              <input type="password" id="admNewPass" minlength="8" required>
            </div>
            <button type="submit" class="btn btn-primary adm-sm-btn">Cập nhật mật khẩu</button>
          </form>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Xuất báo cáo thống kê</div>
          <p class="adm-sub" style="margin:0 0 12px;">Tải dữ liệu thống kê từ Neon để lưu trữ hoặc phân tích trên Excel / Google Sheets.</p>
          <div class="adm-export-row">
            <button type="button" class="btn btn-ghost adm-sm-btn" id="admExportJson">Xuất toàn bộ (JSON)</button>
            <button type="button" class="btn btn-ghost adm-sm-btn" id="admExportVocabCsv">Xuất Từ khó (CSV)</button>
            <button type="button" class="btn btn-ghost adm-sm-btn" id="admExportIpCsv">Xuất Danh sách IP (CSV)</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderDashboard() {
    if (!dashBody) return;

    const toastHtml = state.toast
      ? `<div id="adminToast" class="adm-status-bar ${state.toast.kind}">${esc(state.toast.msg)}</div>`
      : '';

    const tabs = [
      ['overview', 'Tổng quan'],
      ['learning', 'Học tập & Từ khó'],
      ['security', 'IP & Chặn truy cập'],
      ['system', 'Đăng nhập & Hệ thống']
    ];

    let tabContent = '<div class="adm-loading">Đang tải dữ liệu thống kê từ Neon Singapore…</div>';
    if (!state.loading && state.stats) {
      if (state.activeTab === 'overview') tabContent = renderOverviewTab(state.stats);
      else if (state.activeTab === 'learning') tabContent = renderLearningTab(state.stats);
      else if (state.activeTab === 'security') tabContent = renderSecurityTab(state.stats);
      else if (state.activeTab === 'system') tabContent = renderSystemTab(state.stats);
    }

    dashBody.innerHTML = `
      <div class="admin-dash-banner">
        <div>
          <div class="admin-dash-title">Xin chào, <strong>${esc(state.user?.username || 'admin')}</strong></div>
          <div class="admin-dash-sub">
            Neon AWS Singapore · IP của bạn: <span class="adm-mono">${esc(state.currentIp || '—')}</span>
          </div>
        </div>
        <div class="adm-head-actions">
          <select id="admDaysSelect" class="adm-select">
            <option value="7" ${state.days === 7 ? 'selected' : ''}>7 ngày</option>
            <option value="30" ${state.days === 30 ? 'selected' : ''}>30 ngày</option>
            <option value="90" ${state.days === 90 ? 'selected' : ''}>90 ngày</option>
          </select>
          <button type="button" class="btn btn-ghost adm-sm-btn" id="admRefreshBtn">↻ Làm mới</button>
          <button type="button" class="btn btn-wrong adm-sm-btn" id="adminLogoutBtn">Đăng xuất</button>
        </div>
      </div>

      ${toastHtml}

      <div class="adm-tabs">
        ${tabs.map(([key, label]) => `
          <button type="button" class="adm-tab-btn ${state.activeTab === key ? 'active' : ''}" data-tab="${key}">${label}</button>
        `).join('')}
      </div>

      <div class="adm-tab-panel">${tabContent}</div>
    `;

    // Bind events inside dashboard
    dashBody.querySelectorAll('.adm-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.getAttribute('data-tab');
        renderDashboard();
      });
    });

    const daysSel = document.getElementById('admDaysSelect');
    if (daysSel) {
      daysSel.addEventListener('change', () => {
        state.days = Number(daysSel.value) || 30;
        loadAllData();
      });
    }

    const refreshBtn = document.getElementById('admRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAllData);

    const logoutBtn = document.getElementById('adminLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await apiJson('/api/admin/logout', { method: 'POST' }).catch(() => {});
        state.authenticated = false;
        state.user = null;
        state.stats = null;
        dashModal.classList.remove('show');
        updateAdminBtn();
      });
    }

    const resyncBtn = document.getElementById('admResyncEdgeBtn');
    if (resyncBtn) resyncBtn.addEventListener('click', resyncEdgeConfig);

    const blockForm = document.getElementById('admBlockForm');
    if (blockForm) {
      blockForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ip = document.getElementById('admBlockIp').value.trim();
        const scope = document.getElementById('admBlockScope').value;
        const durVal = document.getElementById('admBlockDuration').value;
        const reason = document.getElementById('admBlockReason').value.trim();
        await blockIp(ip, {
          scope,
          duration_hours: durVal === '' ? null : Number(durVal),
          reason
        });
      });
    }

    dashBody.querySelectorAll('.js-unblock-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const ip = btn.getAttribute('data-ip');
        if (confirm(`Gỡ chặn địa chỉ ${ip}?`)) unblockIp(id, ip);
      });
    });

    dashBody.querySelectorAll('.js-quick-block').forEach(btn => {
      btn.addEventListener('click', () => {
        const ip = btn.getAttribute('data-ip');
        const reason = prompt(`Chặn toàn web HSK trong 24 giờ cho IP ${ip}?\nNhập lý do (có thể để trống):`, 'Hoạt động bất thường');
        if (reason !== null) {
          blockIp(ip, { scope: 'site_wide', duration_hours: 24, reason: reason.trim() });
        }
      });
    });

    const pwdForm = document.getElementById('admPasswordForm');
    if (pwdForm) {
      pwdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = document.getElementById('admCurPass').value;
        const newPassword = document.getElementById('admNewPass').value;
        try {
          const res = await apiJson('/api/admin/password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword })
          });
          pwdForm.reset();
          showToast(res.message || 'Đổi mật khẩu thành công!', 'ok');
        } catch (err) {
          showToast(err.message, 'err');
        }
      });
    }

    const exJson = document.getElementById('admExportJson');
    if (exJson) exJson.addEventListener('click', exportJsonReport);
    const exVocab = document.getElementById('admExportVocabCsv');
    if (exVocab) exVocab.addEventListener('click', exportCsvHardestVocab);
    const exIp = document.getElementById('admExportIpCsv');
    if (exIp) exIp.addEventListener('click', exportCsvVisitorIps);
  }

  // Modal & login wiring
  adminBtn.addEventListener('click', () => {
    if (state.authenticated) openDashboard();
    else openLogin();
  });

  document.getElementById('adminLoginClose')?.addEventListener('click', () => loginModal.classList.remove('show'));
  document.getElementById('adminDashClose')?.addEventListener('click', () => dashModal.classList.remove('show'));

  [loginModal, dashModal, document.getElementById('featuresModal')].forEach(ov => {
    if (!ov) return;
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('show'); });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      loginModal.classList.remove('show');
      dashModal.classList.remove('show');
      document.getElementById('featuresModal')?.classList.remove('show');
    }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = userInput.value.trim();
    const password = passInput.value;
    errorEl.textContent = '';
    if (loginSubmitBtn) loginSubmitBtn.disabled = true;

    try {
      const data = await apiJson('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      state.authenticated = true;
      state.user = data.user;
      state.currentIp = data.currentIp || '';
      loginModal.classList.remove('show');
      updateAdminBtn();
      openDashboard();
    } catch (err) {
      errorEl.textContent = err.message || 'Đăng nhập thất bại.';
      passInput.select();
    } finally {
      if (loginSubmitBtn) loginSubmitBtn.disabled = false;
    }
  });

  // Track landing page view & check existing admin session
  if (window.HSKTracker) window.HSKTracker.trackPageView('ROOT');
  checkSession();
})();

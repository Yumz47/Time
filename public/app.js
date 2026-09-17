/**
 * TimePulse Frontend Application Logic
 * Supreme Court / General Registry
 * Production Clock-In / Attendance Management Platform
 */

document.addEventListener('DOMContentLoaded', () => {
  // ─── GLOBAL STATE ─────────────────────────────────────────────────────────
  let authToken = localStorage.getItem('tp_token') || null;
  let currentUser = JSON.parse(localStorage.getItem('tp_user') || 'null');
  let currentTab = 'live-board';
  let departments = [];
  let allEmployeesList = []; // for dropdown selects
  let leaveTypesList = [];

  // Live board state
  let liveBoardData = [];
  let liveActiveFilter = 'all';
  let liveRefreshInterval = null;
  let liveCountdown = 60;
  let liveCountdownInterval = null;

  // Smart reports state
  let activeSmartReport = 'summary';

  // Biometric punch log pagination
  let punchPage = 1;
  const punchLimit = 25;
  let reportData = [];

  // Admin modules state
  let deviceEditId = null;
  let userEditId = null;
  let appUserEditId = null;
  let deletePendingFn = null;
  let allDevices = [];
  let allUsersAdmin = [];

  // ─── DOM ELEMENTS ─────────────────────────────────────────────────────────
  const appLayoutEl = document.getElementById('app-layout');
  const loginScreenEl = document.getElementById('login-screen');
  const loginForm = document.getElementById('login-form');
  const loginUsernameInput = document.getElementById('login-username');
  const loginPasswordInput = document.getElementById('login-password');
  const loginErrorMsg = document.getElementById('login-error-msg');
  const btnLoginSubmit = document.getElementById('btn-login-submit');

  const userSessionName = document.getElementById('user-session-name');
  const userSessionRole = document.getElementById('user-session-role');
  const userSessionAvatar = document.getElementById('user-session-avatar');
  const btnLogout = document.getElementById('btn-logout');

  const liveClockEl = document.getElementById('live-clock');
  const bridgeIndicatorEl = document.getElementById('bridge-indicator');
  const bridgeLastSyncEl = document.getElementById('bridge-last-sync');
  const btnTriggerSync = document.getElementById('btn-trigger-sync');

  const navButtons = document.querySelectorAll('.nav-item');
  const tabViews = document.querySelectorAll('.tab-view');
  const pageTitleEl = document.getElementById('page-title');
  const pageSubtitleEl = document.getElementById('page-subtitle');

  // Shared modals
  const confirmDeleteModal = document.getElementById('confirm-delete-modal');
  const confirmDeleteTitle = document.getElementById('confirm-delete-title');
  const confirmDeleteMessage = document.getElementById('confirm-delete-message');

  // ─── 0. THEME ENGINE & CONTROLLER ──────────────────────────────────────────
  const btnThemeToggle = document.getElementById('btn-theme-toggle');
  const btnThemeToggleLogin = document.getElementById('btn-theme-toggle-login');
  const themeToggleLabel = document.getElementById('theme-toggle-label');
  const themeToggleLoginLabel = document.getElementById('theme-toggle-login-label');

  function getActiveTheme() {
    if (document.body.classList.contains('light-theme')) return 'light';
    if (document.body.classList.contains('dark-theme')) return 'dark';
    try {
      const stored = localStorage.getItem('tp_theme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (e) {}
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  function applyTheme(targetTheme, persist = true) {
    const theme = (typeof ThemeHelper !== 'undefined') 
      ? ThemeHelper.normalizeTheme(targetTheme) 
      : (targetTheme === 'light' ? 'light' : 'dark');

    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.remove('dark-theme', 'light-theme');
    document.body.classList.add(`${theme}-theme`);

    if (persist) {
      try {
        localStorage.setItem('tp_theme', theme);
      } catch (e) {}
    }

    const nextModeName = (theme === 'dark') ? 'Light' : 'Dark';
    const currentModeName = (theme === 'dark') ? 'Dark' : 'Light';

    if (themeToggleLabel) {
      themeToggleLabel.textContent = currentModeName;
    }
    if (themeToggleLoginLabel) {
      themeToggleLoginLabel.textContent = currentModeName;
    }
    if (btnThemeToggle) {
      btnThemeToggle.setAttribute('aria-label', `Switch to ${nextModeName} Mode`);
      btnThemeToggle.setAttribute('title', `Switch to ${nextModeName} Mode`);
    }
    if (btnThemeToggleLogin) {
      btnThemeToggleLogin.setAttribute('aria-label', `Switch to ${nextModeName} Mode`);
      btnThemeToggleLogin.setAttribute('title', `Switch to ${nextModeName} Mode`);
    }
  }

  function toggleTheme() {
    const current = getActiveTheme();
    const next = (typeof ThemeHelper !== 'undefined') 
      ? ThemeHelper.getNextTheme(current) 
      : (current === 'dark' ? 'light' : 'dark');
    applyTheme(next, true);
  }

  if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', toggleTheme);
  }
  if (btnThemeToggleLogin) {
    btnThemeToggleLogin.addEventListener('click', toggleTheme);
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      try {
        if (!localStorage.getItem('tp_theme')) {
          applyTheme(e.matches ? 'dark' : 'light', false);
        }
      } catch (err) {}
    });
  }

  // Initial theme sync
  applyTheme(getActiveTheme(), false);

  // ─── 1. AUTHENTICATED FETCH HELPER ─────────────────────────────────────────
  async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (authToken) {
      headers['x-auth-token'] = authToken;
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('Session expired or unauthorized');
    }
    return res;
  }

  function handleUnauthorized() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('tp_token');
    localStorage.removeItem('tp_user');
    showLoginScreen();
    showToast('Session expired. Please sign in again.', 'error');
  }

  function showLoginScreen() {
    loginScreenEl.style.display = 'flex';
    appLayoutEl.style.display = 'none';
    if (liveRefreshInterval) clearInterval(liveRefreshInterval);
    if (liveCountdownInterval) clearInterval(liveCountdownInterval);
  }

  function showAppLayout() {
    loginScreenEl.style.display = 'none';
    appLayoutEl.style.display = 'flex';
    applyUserSessionUI();
  }

  function applyUserSessionUI() {
    if (!currentUser) return;
    userSessionName.textContent = currentUser.full_name || currentUser.username;
    userSessionRole.textContent = currentUser.role.toUpperCase();
    const initials = (currentUser.full_name || currentUser.username)
      .split(' ')
      .map(w => w.charAt(0))
      .join('')
      .substring(0, 2)
      .toUpperCase();
    userSessionAvatar.textContent = initials || 'US';

    if (currentUser.role === 'viewer') {
      document.body.classList.add('role-viewer');
    } else {
      document.body.classList.remove('role-viewer');
    }
  }

  async function checkAuth() {
    if (!authToken) {
      showLoginScreen();
      return false;
    }
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'x-auth-token': authToken }
      });
      if (!res.ok) throw new Error('Invalid session');
      const data = await res.json();
      currentUser = data.user;
      localStorage.setItem('tp_user', JSON.stringify(currentUser));
      showAppLayout();
      return true;
    } catch (e) {
      handleUnauthorized();
      return false;
    }
  }

  // Login form handler
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginErrorMsg.style.display = 'none';
    btnLoginSubmit.disabled = true;
    btnLoginSubmit.querySelector('span').textContent = 'Signing in...';

    try {
      const username = loginUsernameInput.value.trim();
      const password = loginPasswordInput.value;

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('tp_token', authToken);
      localStorage.setItem('tp_user', JSON.stringify(currentUser));

      loginPasswordInput.value = '';
      showAppLayout();
      showToast(`Welcome back, ${currentUser.full_name || currentUser.username}!`, 'success');
      bootstrapApp();
    } catch (err) {
      loginErrorMsg.textContent = err.message;
      loginErrorMsg.style.display = 'block';
    } finally {
      btnLoginSubmit.disabled = false;
      btnLoginSubmit.querySelector('span').textContent = 'Sign In';
    }
  });

  // Demo presets
  document.getElementById('btn-preset-admin')?.addEventListener('click', () => {
    loginUsernameInput.value = 'admin';
    loginPasswordInput.value = 'Admin@2026!';
    loginForm.requestSubmit();
  });
  document.getElementById('btn-preset-viewer')?.addEventListener('click', () => {
    loginUsernameInput.value = 'viewer';
    loginPasswordInput.value = 'Viewer@2026!';
    loginForm.requestSubmit();
  });

  // Logout handler
  btnLogout.addEventListener('click', async () => {
    try {
      if (authToken) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'x-auth-token': authToken }
        });
      }
    } catch (err) {
      // continue
    }
    authToken = null;
    currentUser = null;
    localStorage.removeItem('tp_token');
    localStorage.removeItem('tp_user');
    showLoginScreen();
    showToast('Signed out successfully', 'info');
  });

  // ─── 2. LIVE CLOCK ─────────────────────────────────────────────────────────
  function updateLiveClock() {
    const now = new Date();
    liveClockEl.textContent = now.toLocaleTimeString([], { hour12: false });
  }
  setInterval(updateLiveClock, 1000);
  updateLiveClock();

  // ─── 3. TOAST NOTIFICATIONS ────────────────────────────────────────────────
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ─── 4. NAVIGATION SWITCHING ───────────────────────────────────────────────
  const titles = {
    'live-board':   { title: 'Live Attendance Board', subtitle: 'Real-time biometric punch tracking & daily presence' },
    dashboard:      { title: 'Executive Dashboard',   subtitle: 'High-level metrics, activity streams and department breakdown' },
    employees:      { title: 'Personnel Directory',   subtitle: 'Search and inspect personnel profiles and historical logs' },
    punches:        { title: 'Punch Activity Log',    subtitle: 'Chronological raw audit trail of biometric logs' },
    shifts:         { title: 'Shifts & Schedules',    subtitle: 'Supreme Court & General Registry working hours and cycle runs' },
    leaves:         { title: 'Leave Management',      subtitle: 'Employee leave requests, approvals and balance records' },
    holidays:       { title: 'Holiday Calendar',      subtitle: 'Official national and gazetted registry holidays' },
    corrections:    { title: 'Punch Corrections',     subtitle: 'Manual audit adjustments and biometric dispute corrections' },
    'smart-reports': { title: 'Reports Studio',       subtitle: 'Customizable attendance reporting, column builder, and export hub' },
    reports:        { title: 'Reports Studio',        subtitle: 'Customizable attendance reporting, column builder, and export hub' },
    devices:        { title: 'Clock Devices',         subtitle: 'Manage biometric readers (ZKTeco/standalone readers)' },
    'users-admin':  { title: 'Personnel Admin',       subtitle: 'Create, update and delete staff members in database' },
    'app-users':    { title: 'System User Accounts',  subtitle: 'Configure platform access logins and roles (Admin/Viewer)' }
  };

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      let target = btn.dataset.tab;
      if (target === 'smart-reports') target = 'reports';
      if (!titles[target]) return;

      navButtons.forEach(b => b.classList.remove('active'));
      tabViews.forEach(v => v.classList.remove('active'));

      btn.classList.add('active');
      const viewEl = document.getElementById(`view-${target}`);
      if (viewEl) viewEl.classList.add('active');

      pageTitleEl.textContent = titles[target].title;
      pageSubtitleEl.textContent = titles[target].subtitle;
      currentTab = target;

      switchTabLoader(target);
    });
  });

  function switchTabLoader(target) {
    if (target === 'live-board')    loadLiveBoard();
    if (target === 'dashboard')    loadDashboard();
    if (target === 'employees')    loadEmployees();
    if (target === 'punches')      loadPunches();
    if (target === 'shifts')       loadShifts();
    if (target === 'leaves')       loadLeaves();
    if (target === 'holidays')     loadHolidays();
    if (target === 'corrections')  loadCorrections();
    if (target === 'reports' || target === 'smart-reports') initReportsStudio();
    if (target === 'devices')      loadDevices();
    if (target === 'users-admin')  loadUsersAdmin();
    if (target === 'app-users')    loadAppUsers();
  }

  // ─── 5. STATUS & HARDWARE DEVICE BRIDGE ─────────────────────────────────────
  async function checkBridgeStatus() {
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      if (data.status === 'online') {
        bridgeIndicatorEl.className = 'status-indicator online';
        if (data.syncInProgress) {
          bridgeIndicatorEl.className = 'status-indicator syncing';
          bridgeLastSyncEl.textContent = 'Sync in progress...';
          btnTriggerSync.classList.add('spinning');
        } else if (data.lastSync) {
          const syncDate = new Date(data.lastSync.sync_end || data.lastSync.sync_start);
          bridgeLastSyncEl.textContent = `Last sync: ${syncDate.toLocaleTimeString()}`;
          btnTriggerSync.classList.remove('spinning');
        } else {
          bridgeLastSyncEl.textContent = 'Hardware clocks connected';
        }

        if (data.stats) {
          const kpiTotal = document.getElementById('kpi-total-employees');
          const kpiPunches = document.getElementById('kpi-total-punches');
          if (kpiTotal) kpiTotal.textContent = data.stats.employeeCount.toLocaleString();
          if (kpiPunches) kpiPunches.textContent = data.stats.punchCount.toLocaleString();
        }
      }
    } catch (e) {
      bridgeIndicatorEl.className = 'status-indicator error';
      bridgeLastSyncEl.textContent = 'Database offline';
    }
  }

  btnTriggerSync.addEventListener('click', async () => {
    btnTriggerSync.classList.add('spinning');
    bridgeIndicatorEl.className = 'status-indicator syncing';
    bridgeLastSyncEl.textContent = 'Syncing devices...';
    showToast('Connecting to biometric clocks...', 'info');

    try {
      const res = await apiFetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const devRes = data.result || data.deviceResult || {};
        const totalDevs = devRes.totalDevices ?? 0;
        const onlineDevs = devRes.successfulDevices ?? 0;
        const inserted = devRes.totalPunchesInserted ?? devRes.punchesInserted ?? 0;
        if (totalDevs > 0) {
          showToast(`Sync complete! ${onlineDevs}/${totalDevs} clock(s) online, ${inserted} new punch(es) synced.`, 'success');
        } else {
          showToast('Device sync complete. All records verified.', 'success');
        }
        checkBridgeStatus();
        switchTabLoader(currentTab);
      } else {
        showToast(`Sync error: ${data.error || 'Unknown'}`, 'error');
      }
    } catch (e) {
      showToast('Sync request failed to connect', 'error');
    } finally {
      btnTriggerSync.classList.remove('spinning');
    }
  });

  // ─── 6. DEPARTMENTS & EMPLOYEES CACHE ──────────────────────────────────────
  async function loadDepartments() {
    try {
      const res = await apiFetch('/api/departments');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      departments = await res.json();
      if (Array.isArray(departments)) {
        const optionsHtml = departments
          .map(d => `<option value="${d.dept_id}">${escapeHtml(d.dept_name)}</option>`)
          .join('');

        const empDeptFilter = document.getElementById('emp-dept-filter');
        if (empDeptFilter) empDeptFilter.innerHTML = '<option value="">All Departments</option>' + optionsHtml;

        const liveDeptFilter = document.getElementById('live-dept-filter');
        if (liveDeptFilter) liveDeptFilter.innerHTML = '<option value="">All Departments</option>' + optionsHtml;

        const smartDeptFilter = document.getElementById('smart-dept-filter');
        if (smartDeptFilter) smartDeptFilter.innerHTML = '<option value="">All Departments</option>' + optionsHtml;

        const reportDept = document.getElementById('report-dept');
        if (reportDept) reportDept.innerHTML = '<option value="">All Departments</option>' + optionsHtml;

        const useradminDeptFilter = document.getElementById('useradmin-dept-filter');
        if (useradminDeptFilter) useradminDeptFilter.innerHTML = '<option value="">All Departments</option>' + optionsHtml;

        const userFormDept = document.getElementById('user-form-dept');
        if (userFormDept) userFormDept.innerHTML = '<option value="">No Department</option>' + optionsHtml;
      }
    } catch (e) {
      console.warn('Could not load departments:', e);
    }
  }

  async function loadEmployeesForSelects() {
    try {
      const res = await apiFetch('/api/employees');
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.employees || []);
      if (list.length > 0) {
        allEmployeesList = list;
        const options = allEmployeesList
          .map(e => `<option value="${e.user_id}">${escapeHtml(e.name)} (Badge: ${escapeHtml(e.badge_number || e.user_id)})</option>`)
          .join('');

        const leaveEmpSelect = document.getElementById('leave-form-emp');
        if (leaveEmpSelect) leaveEmpSelect.innerHTML = '<option value="">Select Employee...</option>' + options;

        const corrEmpSelect = document.getElementById('corr-form-emp');
        if (corrEmpSelect) corrEmpSelect.innerHTML = '<option value="">Select Employee...</option>' + options;
      }
    } catch (e) {
      console.warn('Could not load employees for select:', e);
    }
  }

  // ─── 7. MODULE: LIVE ATTENDANCE BOARD ──────────────────────────────────────
  const liveDateInput = document.getElementById('live-date-input');
  const liveDeptFilter = document.getElementById('live-dept-filter');
  const liveSearchInput = document.getElementById('live-search-input');
  const liveBoardGrid = document.getElementById('live-board-grid');
  const liveKpiTotal = document.getElementById('live-kpi-total');
  const liveKpiIn = document.getElementById('live-kpi-in');
  const liveKpiOut = document.getElementById('live-kpi-out');
  const liveKpiAbsent = document.getElementById('live-kpi-absent');
  const btnRefreshLive = document.getElementById('btn-refresh-live');
  const liveTimerLabel = document.getElementById('live-timer-label');
  const filterPills = document.querySelectorAll('.filter-pill');

  // Initialize date picker to today or latest known active date (2026-09-14)
  if (liveDateInput && !liveDateInput.value) {
    const todayStr = new Date().toISOString().split('T')[0];
    liveDateInput.value = todayStr > '2026-09-14' ? '2026-09-14' : todayStr;
  }

  async function loadLiveBoard() {
    if (!liveBoardGrid) return;
    const date = liveDateInput.value || '2026-09-14';
    const deptId = liveDeptFilter.value;

    liveBoardGrid.innerHTML = '<div class="grid-loading" style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">Fetching live board data...</div>';

    try {
      const params = new URLSearchParams({ date });
      if (deptId) params.append('dept_id', deptId);

      const res = await apiFetch(`/api/attendance/live?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      liveBoardData = data.employees || [];

      // Update KPIs
      if (data.summary) {
        liveKpiTotal.textContent = data.summary.total;
        liveKpiIn.textContent = data.summary.currently_in;
        liveKpiOut.textContent = data.summary.currently_out;
        liveKpiAbsent.textContent = data.summary.absent;

        document.getElementById('count-all').textContent = data.summary.total;
        document.getElementById('count-in').textContent = data.summary.currently_in;
        document.getElementById('count-out').textContent = data.summary.currently_out;
        document.getElementById('count-absent').textContent = data.summary.absent;
      }

      renderLiveBoard();
      resetLiveCountdown();
    } catch (e) {
      liveBoardGrid.innerHTML = `<div class="table-empty" style="grid-column:1/-1;color:var(--accent-rose);">Error loading live board: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderLiveBoard() {
    const q = (liveSearchInput.value || '').trim().toLowerCase();
    const filtered = liveBoardData.filter(emp => {
      // status filter
      if (liveActiveFilter === 'in' && emp.status !== 'in') return false;
      if (liveActiveFilter === 'out' && emp.status !== 'out') return false;
      if (liveActiveFilter === 'absent' && emp.status !== 'absent') return false;

      // search filter
      if (q) {
        const matchName = (emp.name || '').toLowerCase().includes(q);
        const matchBadge = (emp.badge_number || '').toLowerCase().includes(q);
        const matchDept = (emp.dept_name || '').toLowerCase().includes(q);
        return matchName || matchBadge || matchDept;
      }
      return true;
    });

    if (filtered.length === 0) {
      liveBoardGrid.innerHTML = '<div class="table-empty" style="grid-column:1/-1;">No personnel match the selected criteria</div>';
      return;
    }

    liveBoardGrid.innerHTML = filtered.map(emp => {
      const statusClass = `status-${emp.status}`;
      const statusLabel = emp.status === 'in' ? 'IN' : emp.status === 'out' ? 'OUT' : 'ABSENT';
      const lastPunchFormatted = emp.last_punch_time ? formatTime(emp.last_punch_time) : 'No punch today';
      const firstInFormatted = emp.first_in_time ? formatTime(emp.first_in_time) : '--';
      const deviceTag = emp.device_alias ? `via ${escapeHtml(emp.device_alias)}` : '';
      const initials = (emp.name || '?').split(' ').map(n => n.charAt(0)).join('').substring(0, 2).toUpperCase();

      return `
        <div class="employee-card ${statusClass}" data-user-id="${emp.user_id}">
          <div class="card-top">
            <div class="card-avatar">${initials}</div>
            <div class="card-title-group">
              <div class="card-emp-name" title="${escapeHtml(emp.name)}">${escapeHtml(emp.name)}</div>
              <div class="card-emp-badge">Badge #${escapeHtml(emp.badge_number || emp.user_id)}</div>
            </div>
            <span class="status-pill ${statusClass}">${statusLabel}</span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div class="card-dept">${escapeHtml((!emp.dept_name || emp.dept_name === 'This Company') ? 'General Registry' : emp.dept_name)}</div>
            <span style="font-size:0.75rem; color:var(--text-muted);">First In: <strong style="color:var(--text-secondary)">${firstInFormatted}</strong></span>
          </div>

          <div class="card-punch-info">
            <span class="punch-time-tag">${lastPunchFormatted}</span>
            <span class="punch-device-tag">${deviceTag}</span>
          </div>
        </div>
      `;
    }).join('');

    // Clicking an employee card opens their full audit history modal
    liveBoardGrid.querySelectorAll('.employee-card').forEach(card => {
      card.addEventListener('click', () => {
        openEmployeeModal(parseInt(card.dataset.userId, 10));
      });
    });
  }

  // Filter pills
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      liveActiveFilter = pill.dataset.liveFilter;
      renderLiveBoard();
    });
  });

  liveDateInput?.addEventListener('change', loadLiveBoard);
  liveDeptFilter?.addEventListener('change', loadLiveBoard);
  liveSearchInput?.addEventListener('input', () => {
    renderLiveBoard();
  });
  btnRefreshLive?.addEventListener('click', () => {
    loadLiveBoard();
    showToast('Live board refreshed', 'info');
  });

  function resetLiveCountdown() {
    liveCountdown = 60;
    if (liveTimerLabel) liveTimerLabel.textContent = `Auto 60s`;
    if (liveCountdownInterval) clearInterval(liveCountdownInterval);
    liveCountdownInterval = setInterval(() => {
      liveCountdown--;
      if (liveCountdown <= 0) {
        liveCountdown = 60;
        if (currentTab === 'live-board') loadLiveBoard();
      }
      if (liveTimerLabel) liveTimerLabel.textContent = `Auto ${liveCountdown}s`;
    }, 1000);
  }

  // ─── 8. MODULE: REPORTS STUDIO (UNIFIED CUSTOMIZABLE REPORT BUILDER) ────────
  let reportsStudioInitialized = false;

  const COLUMN_DEFS = {
    daily: [
      { id: 'date', label: 'Date', default: true, render: r => `<strong>${r.date}</strong>`, getValue: r => r.date },
      { id: 'badge_number', label: 'Badge #', default: true, render: r => `<span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span>`, getValue: r => r.badge_number || r.user_id },
      { id: 'name', label: 'Personnel Name', default: true, render: r => `<strong>${escapeHtml(r.name)}</strong>`, getValue: r => r.name },
      { id: 'dept_name', label: 'Department', default: true, render: r => escapeHtml(r.dept_name || 'General'), getValue: r => r.dept_name || 'General' },
      { id: 'first_in', label: 'First In', default: true, render: r => `<span class="font-mono">${formatTime(r.first_in)}</span>`, getValue: r => r.first_in ? new Date(r.first_in).toLocaleTimeString() : '' },
      { id: 'last_out', label: 'Last Out', default: true, render: r => `<span class="font-mono">${formatTime(r.last_out)}</span>`, getValue: r => r.last_out ? new Date(r.last_out).toLocaleTimeString() : '' },
      { id: 'punch_count', label: 'Punches', default: true, render: r => `<span class="punch-count-pill">${r.punch_count}</span>`, getValue: r => r.punch_count },
      { id: 'total_hours', label: 'Total Hours', default: true, render: r => `<strong style="color:var(--accent-cyan);">${r.total_hours !== null && r.total_hours !== undefined ? r.total_hours + ' hrs' : '--'}</strong>`, getValue: r => r.total_hours !== null && r.total_hours !== undefined ? r.total_hours : '' },
      { id: 'status', label: 'Status', default: true, render: r => {
        if (r.is_auto_out) return '<span class="report-status-badge late">Auto Out</span>';
        if (Number(r.total_hours) >= 7.5) return '<span class="report-status-badge on-time">Completed</span>';
        if (Number(r.total_hours) > 0) return '<span class="report-status-badge late">Partial</span>';
        return '<span class="report-status-badge absent">No Punch Out</span>';
      }, getValue: r => r.is_auto_out ? 'Auto Out' : (Number(r.total_hours) >= 7.5 ? 'Completed' : 'Partial') }
    ],
    summary: [
      { id: 'badge_number', label: 'Badge #', default: true, render: r => `<span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span>`, getValue: r => r.badge_number || r.user_id },
      { id: 'name', label: 'Employee', default: true, render: r => `<strong>${escapeHtml(r.name)}</strong>`, getValue: r => r.name },
      { id: 'dept_name', label: 'Department', default: true, render: r => escapeHtml(r.dept_name || 'General'), getValue: r => r.dept_name || 'General' },
      { id: 'days_present', label: 'Days Present', default: true, render: r => `<span class="punch-count-pill">${r.days_present} days</span>`, getValue: r => r.days_present },
      { id: 'total_punches', label: 'Total Punches', default: true, render: r => r.total_punches, getValue: r => r.total_punches },
      { id: 'late_count', label: 'Late Count', default: true, render: r => `<span class="${Number(r.late_count) > 0 ? 'report-status-badge late' : 'report-status-badge on-time'}">${r.late_count}</span>`, getValue: r => r.late_count },
      { id: 'earliest_in', label: 'Earliest In', default: true, render: r => `<span class="font-mono">${r.earliest_in || '--'}</span>`, getValue: r => r.earliest_in || '' },
      { id: 'latest_in', label: 'Latest In', default: false, render: r => `<span class="font-mono">${r.latest_in || '--'}</span>`, getValue: r => r.latest_in || '' },
      { id: 'last_seen', label: 'Last Seen', default: true, render: r => `<span class="font-mono" style="font-size:0.85rem">${r.last_seen ? formatDateTime(r.last_seen) : '--'}</span>`, getValue: r => r.last_seen || '' }
    ],
    late: [
      { id: 'date', label: 'Date', default: true, render: r => `<strong>${r.date}</strong>`, getValue: r => r.date },
      { id: 'badge_number', label: 'Badge #', default: true, render: r => `<span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span>`, getValue: r => r.badge_number || r.user_id },
      { id: 'name', label: 'Employee', default: true, render: r => `<strong>${escapeHtml(r.name)}</strong>`, getValue: r => r.name },
      { id: 'dept_name', label: 'Department', default: true, render: r => escapeHtml(r.dept_name || 'General'), getValue: r => r.dept_name || 'General' },
      { id: 'check_in_time', label: 'Check-In Time', default: true, render: r => `<span class="font-mono" style="color:var(--accent-amber); font-weight:700;">${r.check_in_time}</span>`, getValue: r => r.check_in_time },
      { id: 'threshold', label: 'Threshold', default: true, render: (r, th) => `<span class="font-mono" style="color:var(--text-muted);">${th || '08:15'}</span>`, getValue: (r, th) => th || '08:15' },
      { id: 'minutes_late', label: 'Minutes Late', default: true, render: r => `<span class="report-status-badge late">${r.minutes_late}</span>`, getValue: r => r.minutes_late },
      { id: 'status', label: 'Status', default: true, render: () => `<span class="report-status-badge late">TARDY</span>`, getValue: () => 'TARDY' }
    ],
    absent: [
      { id: 'badge_number', label: 'Badge #', default: true, render: r => `<span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span>`, getValue: r => r.badge_number || r.user_id },
      { id: 'name', label: 'Employee', default: true, render: r => `<strong>${escapeHtml(r.name)}</strong>`, getValue: r => r.name },
      { id: 'dept_name', label: 'Department', default: true, render: r => escapeHtml(r.dept_name || 'General'), getValue: r => r.dept_name || 'General' },
      { id: 'date', label: 'Target Date', default: true, render: (r, th, from) => from || '—', getValue: (r, th, from) => from || '' },
      { id: 'last_known_punch', label: 'Last Known Punch', default: true, render: r => `<span style="color:var(--text-muted); font-size:0.85rem">${r.last_known_punch ? formatDateTime(r.last_known_punch) : 'Never recorded'}</span>`, getValue: r => r.last_known_punch || 'Never' },
      { id: 'status', label: 'Status', default: true, render: () => `<span class="report-status-badge absent">ABSENT</span>`, getValue: () => 'ABSENT' }
    ],
    overtime: [
      { id: 'date', label: 'Date', default: true, render: r => `<strong>${r.date}</strong>`, getValue: r => r.date },
      { id: 'badge_number', label: 'Badge #', default: true, render: r => `<span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span>`, getValue: r => r.badge_number || r.user_id },
      { id: 'name', label: 'Employee', default: true, render: r => `<strong>${escapeHtml(r.name)}</strong>`, getValue: r => r.name },
      { id: 'dept_name', label: 'Department', default: true, render: r => escapeHtml(r.dept_name || 'General'), getValue: r => r.dept_name || 'General' },
      { id: 'last_punch_time', label: 'Last Punch Out', default: true, render: r => `<span class="font-mono" style="color:var(--accent-cyan); font-weight:700;">${r.last_punch_time}</span>`, getValue: r => r.last_punch_time },
      { id: 'threshold', label: 'Shift End Threshold', default: true, render: (r, th) => `<span class="font-mono" style="color:var(--text-muted);">${th || '17:00'}</span>`, getValue: (r, th) => th || '17:00' },
      { id: 'overtime_duration', label: 'Overtime Duration', default: true, render: r => `<span class="report-status-badge overtime">+${r.overtime_duration}</span>`, getValue: r => r.overtime_duration },
      { id: 'status', label: 'Status', default: true, render: () => `<span class="report-status-badge overtime">OVERTIME</span>`, getValue: () => 'OVERTIME' }
    ],
    device: [
      { id: 'sn', label: 'Device SN', default: true, render: r => `<span class="badge-number font-mono">${escapeHtml(r.sn)}</span>`, getValue: r => r.sn },
      { id: 'alias', label: 'Device Name / Alias', default: true, render: r => `<strong>${escapeHtml(r.alias || r.device_alias || '—')}</strong>`, getValue: r => r.alias || r.device_alias || '' },
      { id: 'ip_address', label: 'IP Address', default: true, render: r => `<span class="font-mono">${escapeHtml(r.ip_address || '—')}</span>`, getValue: r => r.ip_address || '' },
      { id: 'location', label: 'Location', default: true, render: r => escapeHtml(r.location || '—'), getValue: r => r.location || '' },
      { id: 'status', label: 'Device Status', default: true, render: r => `<span class="device-status-badge ${r.status || r.device_status || 'active'}">${r.status || r.device_status || 'active'}</span>`, getValue: r => r.status || r.device_status || 'active' },
      { id: 'total_punches', label: 'Total Punches', default: true, render: r => `<span class="punch-count-pill">${Number(r.total_punches || 0).toLocaleString()}</span>`, getValue: r => r.total_punches || 0 },
      { id: 'unique_employees', label: 'Unique Personnel', default: true, render: r => `<strong>${r.unique_employees || r.unique_users || 0}</strong>`, getValue: r => r.unique_employees || r.unique_users || 0 },
      { id: 'last_punch', label: 'Last Punch Time', default: true, render: r => `<span class="font-mono" style="font-size:0.85rem">${r.last_punch ? formatDateTime(r.last_punch) : 'None'}</span>`, getValue: r => r.last_punch || '' }
    ]
  };

  const ReportsStudio = {
    currentMode: 'daily',
    visibleColumns: new Set(),
    reportData: [],
    filteredData: [],
    sortCol: null,
    sortAsc: true,

    getStorageKey() {
      const user = (currentUser && currentUser.username) ? currentUser.username : 'viewer';
      return `tp_reports_presets_${user}`;
    },

    loadCustomPresets() {
      try {
        const raw = localStorage.getItem(this.getStorageKey());
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    },

    saveCustomPresets(presets) {
      try {
        localStorage.setItem(this.getStorageKey(), JSON.stringify(presets));
      } catch (e) {
        console.error('Failed to save preset to localStorage', e);
      }
    },

    renderPresetDropdown() {
      const optGroup = document.getElementById('reports-custom-presets-group');
      if (!optGroup) return;
      optGroup.innerHTML = '';
      const presets = this.loadCustomPresets();
      const keys = Object.keys(presets);
      if (keys.length === 0) {
        optGroup.innerHTML = '<option disabled>No custom presets saved</option>';
      } else {
        keys.forEach(k => {
          const opt = document.createElement('option');
          opt.value = `custom_${k}`;
          opt.textContent = `★ ${presets[k].name}`;
          optGroup.appendChild(opt);
        });
      }
    },

    setMode(mode) {
      this.currentMode = mode;
      activeSmartReport = mode;

      // Update pills
      document.querySelectorAll('#report-type-pills .report-pill').forEach(pill => {
        pill.classList.toggle('active', pill.dataset.reportType === mode);
      });

      // Update threshold & single/double date UI
      const thresholdContainer = document.getElementById('container-report-threshold');
      const thresholdLabel = document.getElementById('label-report-threshold');
      const thresholdInput = document.getElementById('report-threshold-input');
      const toContainer = document.getElementById('container-report-to');
      const fromLabel = document.getElementById('label-report-from');
      const reportTitle = document.getElementById('results-report-title');

      if (mode === 'late') {
        if (thresholdContainer) thresholdContainer.style.display = 'flex';
        if (thresholdLabel) thresholdLabel.textContent = 'Late Threshold:';
        if (thresholdInput) thresholdInput.value = '08:15';
        if (toContainer) toContainer.style.display = 'flex';
        if (fromLabel) fromLabel.textContent = 'From:';
        if (reportTitle) reportTitle.textContent = 'Tardiness & Late Arrivals Audit';
      } else if (mode === 'overtime') {
        if (thresholdContainer) thresholdContainer.style.display = 'flex';
        if (thresholdLabel) thresholdLabel.textContent = 'Overtime Threshold:';
        if (thresholdInput) thresholdInput.value = '17:00';
        if (toContainer) toContainer.style.display = 'flex';
        if (fromLabel) fromLabel.textContent = 'From:';
        if (reportTitle) reportTitle.textContent = 'Overtime & Extended Hours Audit';
      } else if (mode === 'absent') {
        if (thresholdContainer) thresholdContainer.style.display = 'none';
        if (toContainer) toContainer.style.display = 'none';
        if (fromLabel) fromLabel.textContent = 'Target Date:';
        if (reportTitle) reportTitle.textContent = 'Daily Absentees & Missing Punches';
      } else if (mode === 'summary') {
        if (thresholdContainer) thresholdContainer.style.display = 'none';
        if (toContainer) toContainer.style.display = 'flex';
        if (fromLabel) fromLabel.textContent = 'From:';
        if (reportTitle) reportTitle.textContent = 'Attendance & Days Present Summary';
      } else if (mode === 'device') {
        if (thresholdContainer) thresholdContainer.style.display = 'none';
        if (toContainer) toContainer.style.display = 'flex';
        if (fromLabel) fromLabel.textContent = 'From:';
        if (reportTitle) reportTitle.textContent = 'Hardware Clock Device Activity';
      } else {
        // daily
        if (thresholdContainer) thresholdContainer.style.display = 'none';
        if (toContainer) toContainer.style.display = 'flex';
        if (fromLabel) fromLabel.textContent = 'From:';
        if (reportTitle) reportTitle.textContent = 'Daily Paired Shifts Report';
      }

      // Reset visible columns to mode defaults
      this.resetDefaultColumns();
      this.renderColumnChips();
    },

    resetDefaultColumns() {
      const defs = COLUMN_DEFS[this.currentMode] || [];
      this.visibleColumns = new Set(defs.filter(d => d.default).map(d => d.id));
    },

    renderColumnChips() {
      const container = document.getElementById('columns-chips-container');
      if (!container) return;
      container.innerHTML = '';
      const defs = COLUMN_DEFS[this.currentMode] || [];

      defs.forEach(col => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `col-chip ${this.visibleColumns.has(col.id) ? 'active' : ''}`;
        chip.innerHTML = `<span class="col-chip-indicator"></span><span>${escapeHtml(col.label)}</span>`;
        chip.addEventListener('click', () => {
          if (this.visibleColumns.has(col.id)) {
            if (this.visibleColumns.size <= 1) {
              showToast('At least one column must remain visible', 'warning');
              return;
            }
            this.visibleColumns.delete(col.id);
            chip.classList.remove('active');
          } else {
            this.visibleColumns.add(col.id);
            chip.classList.add('active');
          }
          this.renderReportTable();
        });
        container.appendChild(chip);
      });
    },

    setDateRangePreset(preset) {
      const fromInput = document.getElementById('report-from');
      const toInput = document.getElementById('report-to');
      if (!fromInput || !toInput) return;

      const now = new Date();
      const formatLocalDate = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      if (preset === 'today') {
        const todayStr = formatLocalDate(now);
        fromInput.value = todayStr;
        toInput.value = todayStr;
      } else if (preset === 'yesterday') {
        const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const yStr = formatLocalDate(y);
        fromInput.value = yStr;
        toInput.value = yStr;
      } else if (preset === 'this_week') {
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(now.getFullYear(), now.getMonth(), diff);
        fromInput.value = formatLocalDate(monday);
        toInput.value = formatLocalDate(now);
      } else if (preset === 'last_week') {
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1) - 7;
        const monday = new Date(now.getFullYear(), now.getMonth(), diff);
        const sunday = new Date(now.getFullYear(), now.getMonth(), diff + 6);
        fromInput.value = formatLocalDate(monday);
        toInput.value = formatLocalDate(sunday);
      } else if (preset === 'this_month') {
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        fromInput.value = formatLocalDate(firstDay);
        toInput.value = formatLocalDate(now);
      } else if (preset === 'sep_2026') {
        fromInput.value = '2026-09-01';
        toInput.value = '2026-09-17';
      }

      // Update date chips UI
      document.querySelectorAll('#date-quick-presets .date-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.range === preset);
      });
    },

    async runReport() {
      const fromInput = document.getElementById('report-from');
      const toInput = document.getElementById('report-to');
      const deptFilter = document.getElementById('report-dept');
      const searchFilter = document.getElementById('report-search-input');
      const thresholdInput = document.getElementById('report-threshold-input');
      const tbody = document.getElementById('reports-tbody');
      const btnExport = document.getElementById('btn-export-csv');
      const btnPrint = document.getElementById('btn-print-report');
      const btnCopy = document.getElementById('btn-copy-report');
      const countBadge = document.getElementById('results-count-badge');

      if (!fromInput || !tbody) return;
      const from = fromInput.value;
      const to = toInput ? toInput.value : from;
      const deptId = deptFilter ? deptFilter.value : '';
      const search = searchFilter ? searchFilter.value.trim() : '';
      const threshold = thresholdInput ? thresholdInput.value : '08:15';

      if (!from || (this.currentMode !== 'absent' && !to)) {
        showToast('Please select valid date boundaries', 'warning');
        return;
      }

      tbody.innerHTML = `<tr><td colspan="${Math.max(this.visibleColumns.size, 1)}" class="table-empty"><div class="loading-spinner"></div> Querying attendance intelligence...</td></tr>`;
      if (btnExport) btnExport.disabled = true;
      if (btnPrint) btnPrint.disabled = true;
      if (btnCopy) btnCopy.disabled = true;
      if (countBadge) countBadge.textContent = 'Loading...';

      try {
        let endpoint = '';
        const params = new URLSearchParams();

        if (this.currentMode === 'daily') {
          endpoint = '/api/reports/daily';
          params.append('from', from);
          params.append('to', to);
          if (deptId) params.append('deptId', deptId);
          if (search) params.append('search', search);
        } else if (this.currentMode === 'summary') {
          endpoint = '/api/reports/attendance-summary';
          params.append('from', from);
          params.append('to', to);
          if (deptId) params.append('deptId', deptId);
          if (search) params.append('search', search);
        } else if (this.currentMode === 'late') {
          endpoint = '/api/reports/late-arrivals';
          params.append('from', from);
          params.append('to', to);
          params.append('threshold', threshold);
          if (deptId) params.append('deptId', deptId);
          if (search) params.append('search', search);
        } else if (this.currentMode === 'absent') {
          endpoint = '/api/reports/absent';
          params.append('date', from);
          if (deptId) params.append('dept_id', deptId);
          if (search) params.append('search', search);
        } else if (this.currentMode === 'overtime') {
          endpoint = '/api/reports/overtime';
          params.append('from', from);
          params.append('to', to);
          params.append('threshold', threshold);
          if (deptId) params.append('deptId', deptId);
          if (search) params.append('search', search);
        } else if (this.currentMode === 'device') {
          endpoint = '/api/reports/by-device';
          params.append('from', from);
          params.append('to', to);
        }

        const res = await apiFetch(`${endpoint}?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to generate report`);
        const json = await res.json();

        if (this.currentMode === 'absent') {
          this.reportData = json.employees || [];
        } else {
          this.reportData = Array.isArray(json) ? json : [];
        }

        this.updateKpis();
        this.renderReportTable();

        const hasRows = this.reportData.length > 0;
        if (btnExport) btnExport.disabled = !hasRows;
        if (btnPrint) btnPrint.disabled = !hasRows;
        if (btnCopy) btnCopy.disabled = !hasRows;
      } catch (e) {
        console.error('ReportsStudio Error:', e);
        tbody.innerHTML = `<tr><td colspan="${Math.max(this.visibleColumns.size, 1)}" class="table-empty" style="color:var(--accent-rose)">Failed to generate report: ${escapeHtml(e.message)}</td></tr>`;
        if (countBadge) countBadge.textContent = '0 rows';
      }
    },

    updateKpis(dataset) {
      const data = dataset || this.reportData || [];
      const grid = document.getElementById('reports-kpi-grid');
      const recs = document.getElementById('kpi-total-records');
      const hours = document.getElementById('kpi-total-hours');
      const m2Label = document.getElementById('kpi-metric2-label');
      const late = document.getElementById('kpi-late-count');
      const m3Label = document.getElementById('kpi-metric3-label');
      const absent = document.getElementById('kpi-absent-count');
      const m4Label = document.getElementById('kpi-metric4-label');

      if (!grid) return;
      grid.style.display = 'grid';

      const totalRows = data.length;
      if (recs) recs.textContent = totalRows.toLocaleString();

      if (this.currentMode === 'daily') {
        const totalHrs = data.reduce((acc, r) => acc + (Number(r.total_hours) || 0), 0);
        const avgHrs = totalRows > 0 ? (totalHrs / totalRows).toFixed(1) : '0.0';
        if (m2Label) m2Label.textContent = 'Total Hours Worked';
        if (hours) hours.textContent = `${totalHrs.toFixed(1)}h (avg ${avgHrs}h)`;

        const autoOutCount = data.filter(r => r.is_auto_out).length;
        if (m3Label) m3Label.textContent = 'Auto Punch-Outs';
        if (late) late.textContent = autoOutCount;

        const uniquePersonnel = new Set(data.map(r => r.user_id)).size;
        if (m4Label) m4Label.textContent = 'Active Personnel';
        if (absent) absent.textContent = uniquePersonnel;
      } else if (this.currentMode === 'summary') {
        const totalPunches = data.reduce((acc, r) => acc + (Number(r.total_punches) || 0), 0);
        if (m2Label) m2Label.textContent = 'Total Punch Swipes';
        if (hours) hours.textContent = totalPunches.toLocaleString();

        const totalLatePunches = data.reduce((acc, r) => acc + (Number(r.late_count) || 0), 0);
        if (m3Label) m3Label.textContent = 'Total Late Punches';
        if (late) late.textContent = totalLatePunches;

        const avgDays = totalRows > 0 ? (data.reduce((a, r) => a + (Number(r.days_present) || 0), 0) / totalRows).toFixed(1) : '0';
        if (m4Label) m4Label.textContent = 'Avg Days Present';
        if (absent) absent.textContent = `${avgDays} days`;
      } else if (this.currentMode === 'late') {
        if (m2Label) m2Label.textContent = 'Late Arrivals';
        if (hours) hours.textContent = totalRows;

        const uniqueEmps = new Set(data.map(r => r.user_id)).size;
        if (m3Label) m3Label.textContent = 'Tardy Employees';
        if (late) late.textContent = uniqueEmps;

        if (m4Label) m4Label.textContent = 'Status Target';
        if (absent) absent.textContent = 'Tardy';
      } else if (this.currentMode === 'absent') {
        if (m2Label) m2Label.textContent = 'Absentees Count';
        if (hours) hours.textContent = totalRows;

        if (m3Label) m3Label.textContent = 'Target Date';
        const fromInput = document.getElementById('report-from');
        if (late) late.textContent = fromInput ? fromInput.value : 'Today';

        if (m4Label) m4Label.textContent = 'Compliance Action';
        if (absent) absent.textContent = 'Follow-up';
      } else if (this.currentMode === 'overtime') {
        const parseDurationToHours = (dur) => {
          if (!dur) return 0;
          const clean = String(dur).replace('+', '').trim();
          const parts = clean.split(':').map(Number);
          if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return 0;
          return (parts[0] || 0) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
        };

        const totalOtHours = data.reduce((acc, r) => acc + parseDurationToHours(r.overtime_duration), 0);
        const avgOtHours = totalRows > 0 ? (totalOtHours / totalRows).toFixed(1) : '0.0';

        if (m2Label) m2Label.textContent = 'Total Overtime Hours';
        if (hours) hours.textContent = `${totalOtHours.toFixed(1)}h (avg ${avgOtHours}h)`;

        const uniqueEmps = new Set(data.map(r => r.user_id)).size;
        if (m3Label) m3Label.textContent = 'Personnel with OT';
        if (late) late.textContent = uniqueEmps;

        let maxDurationStr = '00:00:00';
        let maxSecs = 0;
        data.forEach(r => {
          if (!r.overtime_duration) return;
          const clean = String(r.overtime_duration).replace('+', '').trim();
          const parts = clean.split(':').map(Number);
          const secs = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
          if (secs > maxSecs) {
            maxSecs = secs;
            maxDurationStr = clean;
          }
        });

        if (m4Label) m4Label.textContent = 'Max Single OT';
        if (absent) absent.textContent = totalRows > 0 ? `+${maxDurationStr}` : '0h';
      } else if (this.currentMode === 'device') {
        const totalPunches = data.reduce((acc, r) => acc + (Number(r.total_punches) || 0), 0);
        if (m2Label) m2Label.textContent = 'Hardware Traffic';
        if (hours) hours.textContent = `${totalPunches.toLocaleString()} punches`;

        const activeDevices = data.filter(r => (r.status || r.device_status) === 'active').length;
        if (m3Label) m3Label.textContent = 'Active Hardware Clocks';
        if (late) late.textContent = `${activeDevices} / ${totalRows}`;

        const totalUnique = data.reduce((acc, r) => acc + (Number(r.unique_employees || r.unique_users) || 0), 0);
        if (m4Label) m4Label.textContent = 'Unique Users Seen';
        if (absent) absent.textContent = totalUnique;
      }
    },

    renderReportTable() {
      const thead = document.getElementById('reports-thead');
      const tbody = document.getElementById('reports-tbody');
      const countBadge = document.getElementById('results-count-badge');
      const searchBox = document.getElementById('report-table-instant-filter');
      const thresholdInput = document.getElementById('report-threshold-input');
      const fromInput = document.getElementById('report-from');

      if (!thead || !tbody) return;

      const defs = COLUMN_DEFS[this.currentMode] || [];
      const visibleDefs = defs.filter(d => this.visibleColumns.has(d.id));

      if (visibleDefs.length === 0) {
        thead.innerHTML = '';
        tbody.innerHTML = '<tr><td class="table-empty">No columns selected. Use section 4 above to enable visible columns.</td></tr>';
        if (countBadge) countBadge.textContent = '0 rows';
        return;
      }

      // 1. Instant client-side text filter
      const filterText = searchBox ? searchBox.value.trim().toLowerCase() : '';
      let rows = this.reportData;
      if (filterText) {
        rows = rows.filter(r => {
          return visibleDefs.some(col => {
            const val = String(col.getValue(r, thresholdInput?.value, fromInput?.value) || '').toLowerCase();
            return val.includes(filterText);
          });
        });
      }

      // 2. Sorting
      if (this.sortCol) {
        const colDef = visibleDefs.find(c => c.id === this.sortCol);
        if (colDef) {
          rows.sort((a, b) => {
            let valA = colDef.getValue(a, thresholdInput?.value, fromInput?.value);
            let valB = colDef.getValue(b, thresholdInput?.value, fromInput?.value);

            if (valA === undefined || valA === null) valA = '';
            if (valB === undefined || valB === null) valB = '';

            const numA = Number(valA);
            const numB = Number(valB);
            if (!isNaN(numA) && !isNaN(numB) && valA !== '' && valB !== '') {
              return this.sortAsc ? numA - numB : numB - numA;
            }
            return this.sortAsc
              ? String(valA).localeCompare(String(valB))
              : String(valB).localeCompare(String(valA));
          });
        }
      }

      this.filteredData = rows;

      // 3. Render thead
      thead.innerHTML = `
        <tr>
          ${visibleDefs.map(col => {
            const isSorted = this.sortCol === col.id;
            const arrow = isSorted ? (this.sortAsc ? ' ▲' : ' ▼') : ' ⇅';
            return `<th class="sortable-th ${isSorted ? 'sorted' : ''}" data-col-id="${col.id}">${escapeHtml(col.label)}<span class="th-sort-indicator">${arrow}</span></th>`;
          }).join('')}
        </tr>
      `;

      // Bind header sorting
      thead.querySelectorAll('.sortable-th').forEach(th => {
        th.addEventListener('click', () => {
          const colId = th.dataset.colId;
          if (this.sortCol === colId) {
            this.sortAsc = !this.sortAsc;
          } else {
            this.sortCol = colId;
            this.sortAsc = true;
          }
          this.renderReportTable();
        });
      });

      // 4. Render tbody
      if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${visibleDefs.length}" class="table-empty">${filterText ? 'No rows match filter criteria' : 'No attendance records found for criteria'}</td></tr>`;
      } else {
        const thVal = thresholdInput ? thresholdInput.value : '';
        const fromVal = fromInput ? fromInput.value : '';
        tbody.innerHTML = rows.map(r => `
          <tr>
            ${visibleDefs.map(col => `<td>${col.render(r, thVal, fromVal)}</td>`).join('')}
          </tr>
        `).join('');
      }

      // Update badge and KPIs dynamically
      this.updateKpis(rows);
      if (countBadge) {
        if (filterText) {
          countBadge.textContent = `${rows.length} / ${this.reportData.length} rows`;
        } else {
          countBadge.textContent = `${rows.length} rows`;
        }
      }
    },

    exportCsv() {
      if (!this.reportData || !this.reportData.length) {
        showToast('No data available to export', 'warning');
        return;
      }

      const fromInput = document.getElementById('report-from');
      const toInput = document.getElementById('report-to');
      const thresholdInput = document.getElementById('report-threshold-input');
      const from = fromInput ? fromInput.value : 'report';
      const to = toInput ? toInput.value : from;
      const thVal = thresholdInput ? thresholdInput.value : '';

      const defs = COLUMN_DEFS[this.currentMode] || [];
      const visibleDefs = defs.filter(d => this.visibleColumns.has(d.id));

      const headers = visibleDefs.map(d => `"${d.label.replace(/"/g, '""')}"`);
      const rowsToExport = this.filteredData.length ? this.filteredData : this.reportData;

      const csvRows = [headers.join(',')];
      rowsToExport.forEach(r => {
        const row = visibleDefs.map(d => {
          const val = d.getValue(r, thVal, from);
          return `"${String(val ?? '').replace(/"/g, '""')}"`;
        });
        csvRows.push(row.join(','));
      });

      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ReportsStudio_${this.currentMode}_${from}_to_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${rowsToExport.length} rows to CSV`, 'success');
    },

    copyTable() {
      const rowsToExport = this.filteredData.length ? this.filteredData : this.reportData;
      if (!rowsToExport.length) {
        showToast('No rows to copy', 'warning');
        return;
      }

      const thresholdInput = document.getElementById('report-threshold-input');
      const fromInput = document.getElementById('report-from');
      const thVal = thresholdInput ? thresholdInput.value : '';
      const fromVal = fromInput ? fromInput.value : '';

      const defs = COLUMN_DEFS[this.currentMode] || [];
      const visibleDefs = defs.filter(d => this.visibleColumns.has(d.id));

      const headers = visibleDefs.map(d => d.label);
      const tsvRows = [headers.join('\t')];

      rowsToExport.forEach(r => {
        const row = visibleDefs.map(d => String(d.getValue(r, thVal, fromVal) ?? '').replace(/\t|\n/g, ' '));
        tsvRows.push(row.join('\t'));
      });

      navigator.clipboard.writeText(tsvRows.join('\n'))
        .then(() => showToast(`Copied ${rowsToExport.length} rows to clipboard!`, 'success'))
        .catch(() => showToast('Failed to copy to clipboard', 'error'));
    },

    saveCurrentAsPreset() {
      const name = prompt('Enter a name for this customized report preset:');
      if (!name || !name.trim()) return;

      const trimmedName = name.trim();
      const presets = this.loadCustomPresets();
      const key = `preset_${Date.now()}`;

      const fromInput = document.getElementById('report-from');
      const toInput = document.getElementById('report-to');
      const deptFilter = document.getElementById('report-dept');
      const searchFilter = document.getElementById('report-search-input');
      const thresholdInput = document.getElementById('report-threshold-input');

      presets[key] = {
        name: trimmedName,
        mode: this.currentMode,
        from: fromInput?.value || '2026-09-01',
        to: toInput?.value || '2026-09-17',
        deptId: deptFilter?.value || '',
        search: searchFilter?.value || '',
        threshold: thresholdInput?.value || '08:15',
        columns: Array.from(this.visibleColumns)
      };

      this.saveCustomPresets(presets);
      this.renderPresetDropdown();

      const presetSelect = document.getElementById('reports-preset-select');
      if (presetSelect) presetSelect.value = `custom_${key}`;

      const btnDelete = document.getElementById('btn-delete-custom-preset');
      if (btnDelete) btnDelete.style.display = 'inline-flex';

      showToast(`Custom preset "${trimmedName}" saved successfully!`, 'success');
    },

    deleteCurrentPreset() {
      const presetSelect = document.getElementById('reports-preset-select');
      if (!presetSelect || !presetSelect.value.startsWith('custom_')) return;

      const key = presetSelect.value.replace('custom_', '');
      const presets = this.loadCustomPresets();
      if (!presets[key]) return;

      const name = presets[key].name;
      if (!confirm(`Delete custom report preset "${name}"?`)) return;

      delete presets[key];
      this.saveCustomPresets(presets);
      this.renderPresetDropdown();

      presetSelect.value = 'sys_daily';
      const btnDelete = document.getElementById('btn-delete-custom-preset');
      if (btnDelete) btnDelete.style.display = 'none';

      this.setMode('daily');
      showToast(`Preset "${name}" removed`, 'info');
    },

    applyPreset(presetValue) {
      const btnDelete = document.getElementById('btn-delete-custom-preset');
      if (presetValue.startsWith('sys_')) {
        if (btnDelete) btnDelete.style.display = 'none';
        const modeMap = {
          sys_daily: 'daily',
          sys_summary: 'summary',
          sys_late: 'late',
          sys_absent: 'absent',
          sys_overtime: 'overtime',
          sys_device: 'device'
        };
        const mode = modeMap[presetValue] || 'daily';
        this.setMode(mode);
        this.runReport();
      } else if (presetValue.startsWith('custom_')) {
        if (btnDelete) btnDelete.style.display = 'inline-flex';
        const key = presetValue.replace('custom_', '');
        const presets = this.loadCustomPresets();
        const p = presets[key];
        if (!p) return;

        this.currentMode = p.mode || 'daily';
        activeSmartReport = this.currentMode;

        const fromInput = document.getElementById('report-from');
        const toInput = document.getElementById('report-to');
        const deptFilter = document.getElementById('report-dept');
        const searchFilter = document.getElementById('report-search-input');
        const thresholdInput = document.getElementById('report-threshold-input');

        if (fromInput && p.from) fromInput.value = p.from;
        if (toInput && p.to) toInput.value = p.to;
        if (deptFilter && p.deptId !== undefined) deptFilter.value = p.deptId;
        if (searchFilter && p.search !== undefined) searchFilter.value = p.search;
        if (thresholdInput && p.threshold) thresholdInput.value = p.threshold;

        // Apply mode UI adjustments
        this.setMode(this.currentMode);

        // Restore custom visible columns if saved
        if (Array.isArray(p.columns) && p.columns.length > 0) {
          this.visibleColumns = new Set(p.columns);
          this.renderColumnChips();
        }

        this.runReport();
      }
    }
  };

  function initReportsStudio() {
    // 1. Initialize default dates if blank
    const fromInput = document.getElementById('report-from');
    const toInput = document.getElementById('report-to');
    if (fromInput && !fromInput.value) fromInput.value = '2026-09-01';
    if (toInput && !toInput.value) toInput.value = '2026-09-17';

    // 2. Load custom presets in dropdown
    ReportsStudio.renderPresetDropdown();

    // 3. Render initial column chips
    if (ReportsStudio.visibleColumns.size === 0) {
      ReportsStudio.resetDefaultColumns();
    }
    ReportsStudio.renderColumnChips();

    // 4. One-time event listeners setup
    if (!reportsStudioInitialized) {
      reportsStudioInitialized = true;

      // Presets dropdown
      document.getElementById('reports-preset-select')?.addEventListener('change', (e) => {
        ReportsStudio.applyPreset(e.target.value);
      });

      // Save custom preset
      document.getElementById('btn-save-custom-preset')?.addEventListener('click', () => {
        ReportsStudio.saveCurrentAsPreset();
      });

      // Delete custom preset
      document.getElementById('btn-delete-custom-preset')?.addEventListener('click', () => {
        ReportsStudio.deleteCurrentPreset();
      });

      // Mode pills
      document.querySelectorAll('#report-type-pills .report-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          ReportsStudio.setMode(pill.dataset.reportType);
          ReportsStudio.runReport();
        });
      });

      // Date quick presets
      document.querySelectorAll('#date-quick-presets .date-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          ReportsStudio.setDateRangePreset(chip.dataset.range);
          ReportsStudio.runReport();
        });
      });

      // Column Select All / Reset Default
      document.getElementById('btn-cols-select-all')?.addEventListener('click', () => {
        const defs = COLUMN_DEFS[ReportsStudio.currentMode] || [];
        ReportsStudio.visibleColumns = new Set(defs.map(d => d.id));
        ReportsStudio.renderColumnChips();
        ReportsStudio.renderReportTable();
      });

      document.getElementById('btn-cols-reset-default')?.addEventListener('click', () => {
        ReportsStudio.resetDefaultColumns();
        ReportsStudio.renderColumnChips();
        ReportsStudio.renderReportTable();
      });

      // Generate Report button
      document.getElementById('btn-generate-report')?.addEventListener('click', () => {
        ReportsStudio.runReport();
      });

      // Reset Filters button
      document.getElementById('btn-reset-report-filters')?.addEventListener('click', () => {
        if (fromInput) fromInput.value = '2026-09-01';
        if (toInput) toInput.value = '2026-09-17';
        const deptFilter = document.getElementById('report-dept');
        if (deptFilter) deptFilter.value = '';
        const searchFilter = document.getElementById('report-search-input');
        if (searchFilter) searchFilter.value = '';
        const thInput = document.getElementById('report-threshold-input');
        if (thInput) thInput.value = ReportsStudio.currentMode === 'overtime' ? '17:00' : '08:15';
        ReportsStudio.resetDefaultColumns();
        ReportsStudio.renderColumnChips();
        ReportsStudio.runReport();
      });

      // Export actions
      document.getElementById('btn-export-csv')?.addEventListener('click', () => {
        ReportsStudio.exportCsv();
      });

      document.getElementById('btn-print-report')?.addEventListener('click', () => {
        window.print();
      });

      document.getElementById('btn-copy-report')?.addEventListener('click', () => {
        ReportsStudio.copyTable();
      });

      // Real-time instant table filter (filters rows & KPIs in memory on keystroke)
      document.getElementById('report-table-instant-filter')?.addEventListener('input', () => {
        ReportsStudio.renderReportTable();
      });

      // Dynamic automatic reload on filter or date change
      ['report-dept', 'report-from', 'report-to', 'report-threshold-input'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
          ReportsStudio.runReport();
        });
      });

      // Debounced scope search input (queries server dynamically 350ms after typing stops)
      let searchDebounceTimer = null;
      document.getElementById('report-search-input')?.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          ReportsStudio.runReport();
        }, 350);
      });

      // Enter key on filters triggers immediate run
      ['report-search-input', 'report-threshold-input', 'report-from', 'report-to', 'report-dept'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            clearTimeout(searchDebounceTimer);
            ReportsStudio.runReport();
          }
        });
      });
    }

    // Run report if table is currently empty
    if (ReportsStudio.reportData.length === 0) {
      ReportsStudio.runReport();
    }
  }

  // Backward compatibility alias for any legacy callers
  function runSmartReport() {
    initReportsStudio();
  }

  // ─── 9. MODULE: SHIFTS & SCHEDULES ─────────────────────────────────────────
  let cachedShifts = [];
  let cachedSchedules = [];
  let currentScheduleForAssignments = null;
  let cachedAssignmentsList = [];

  const shiftModal = document.getElementById('shift-modal');
  const shiftModalTitle = document.getElementById('shift-modal-title');
  const btnCloseShiftModal = document.getElementById('btn-close-shift-modal');
  const btnCancelShift = document.getElementById('btn-cancel-shift');
  const btnSaveShift = document.getElementById('btn-save-shift');
  const btnOpenShiftModal = document.getElementById('btn-open-shift-modal');

  const shiftFormId = document.getElementById('shift-form-id');
  const shiftFormName = document.getElementById('shift-form-name');
  const shiftFormStartTime = document.getElementById('shift-form-start-time');
  const shiftFormEndTime = document.getElementById('shift-form-end-time');
  const shiftFormCheckin1 = document.getElementById('shift-form-checkin1');
  const shiftFormCheckin2 = document.getElementById('shift-form-checkin2');
  const shiftFormCheckout1 = document.getElementById('shift-form-checkout1');
  const shiftFormCheckout2 = document.getElementById('shift-form-checkout2');
  const shiftFormLateMins = document.getElementById('shift-form-late-mins');
  const shiftFormEarlyMins = document.getElementById('shift-form-early-mins');
  const shiftFormWorkday = document.getElementById('shift-form-workday');

  const scheduleModal = document.getElementById('schedule-modal');
  const scheduleModalTitle = document.getElementById('schedule-modal-title');
  const btnCloseScheduleModal = document.getElementById('btn-close-schedule-modal');
  const btnCancelSched = document.getElementById('btn-cancel-sched');
  const btnSaveSched = document.getElementById('btn-save-sched');
  const btnOpenScheduleModal = document.getElementById('btn-open-schedule-modal');

  const schedFormId = document.getElementById('sched-form-id');
  const schedFormName = document.getElementById('sched-form-name');
  const schedFormStartDate = document.getElementById('sched-form-start-date');
  const schedFormEndDate = document.getElementById('sched-form-end-date');
  const scheduleDaysContainer = document.getElementById('schedule-days-container');

  const scheduleAssignmentsModal = document.getElementById('schedule-assignments-modal');
  const btnCloseSchedAssignModal = document.getElementById('btn-close-sched-assign-modal');
  const btnCloseSchedAssignFooter = document.getElementById('btn-close-sched-assign-footer');
  const schedAssignModalTitle = document.getElementById('sched-assign-modal-title');
  const schedAssignModalSubtext = document.getElementById('sched-assign-modal-subtext');
  const schedAssignEmpSelect = document.getElementById('sched-assign-emp-select');
  const schedAssignStart = document.getElementById('sched-assign-start');
  const schedAssignEnd = document.getElementById('sched-assign-end');
  const btnSubmitSchedAssign = document.getElementById('btn-submit-sched-assign');
  const schedAssignSearch = document.getElementById('sched-assign-search');
  const schedAssignTbody = document.getElementById('sched-assign-tbody');
  const schedAssignCount = document.getElementById('sched-assign-count');

  const DAY_NAMES = [
    { day: 1, name: 'Monday' },
    { day: 2, name: 'Tuesday' },
    { day: 3, name: 'Wednesday' },
    { day: 4, name: 'Thursday' },
    { day: 5, name: 'Friday' },
    { day: 6, name: 'Saturday' },
    { day: 7, name: 'Sunday' },
  ];

  async function loadShifts() {
    const shiftsGrid = document.getElementById('shifts-grid');
    const schedulesGrid = document.getElementById('schedules-grid');
    if (!shiftsGrid || !schedulesGrid) return;

    shiftsGrid.innerHTML = '<div class="grid-loading">Loading shift classes...</div>';
    schedulesGrid.innerHTML = '<div class="grid-loading">Loading assigned schedules...</div>';

    try {
      const [shiftsRes, schedRes] = await Promise.all([
        apiFetch('/api/shifts'),
        apiFetch('/api/schedules')
      ]);

      cachedShifts = await shiftsRes.json();
      cachedSchedules = await schedRes.json();

      const isAdmin = currentUser && currentUser.role === 'admin';

      if (cachedShifts.length === 0) {
        shiftsGrid.innerHTML = '<div class="table-empty">No shift classes found</div>';
      } else {
        shiftsGrid.innerHTML = cachedShifts.map(s => {
          const shiftName = s.name || s.SchName || ('Shift #' + s.id);
          const startTime = s.start_time ? String(s.start_time).substring(0, 5) : '08:00';
          const endTime = s.end_time ? String(s.end_time).substring(0, 5) : '17:00';
          const checkIn1 = s.check_in_time1 ? String(s.check_in_time1).substring(0, 5) : '--';
          const checkIn2 = s.check_in_time2 ? String(s.check_in_time2).substring(0, 5) : '--';
          const checkOut1 = s.check_out_time1 ? String(s.check_out_time1).substring(0, 5) : '--';
          const checkOut2 = s.check_out_time2 ? String(s.check_out_time2).substring(0, 5) : '--';
          const lateMin = s.late_grace_minutes != null ? s.late_grace_minutes : s.LateMinutes;

          return `
            <div class="shift-card">
              <div class="shift-card-header">
                <span class="shift-name">${escapeHtml(shiftName)}</span>
                <span class="shift-time-badge">${startTime} – ${endTime}</span>
              </div>
              <div class="shift-detail-row">
                <span>Check-in Window:</span>
                <span class="font-mono">${checkIn1} – ${checkIn2}</span>
              </div>
              <div class="shift-detail-row">
                <span>Check-out Window:</span>
                <span class="font-mono">${checkOut1} – ${checkOut2}</span>
              </div>
              <div class="shift-detail-row">
                <span>Grace / Auto Deduct:</span>
                <span>${lateMin ? lateMin + ' min' : 'Standard'}</span>
              </div>
              ${isAdmin ? `
                <div class="card-actions-row">
                  <button class="btn-card-action btn-edit-shift" data-id="${s.id}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit Shift
                  </button>
                  <button class="btn-card-action btn-action-danger btn-delete-shift" data-id="${s.id}" data-name="${escapeHtml(shiftName)}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    Delete
                  </button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('');

        shiftsGrid.querySelectorAll('.btn-edit-shift').forEach(b => {
          b.addEventListener('click', () => {
            const shift = cachedShifts.find(s => s.id === parseInt(b.dataset.id, 10));
            if (shift) openShiftModal(shift);
          });
        });
        shiftsGrid.querySelectorAll('.btn-delete-shift').forEach(b => {
          b.addEventListener('click', () => {
            openDeleteConfirm('Delete Shift Class', `Are you sure you want to delete shift <strong>${b.dataset.name}</strong>?`, () => {
              deleteShift(parseInt(b.dataset.id, 10));
            });
          });
        });
      }

      if (cachedSchedules.length === 0) {
        schedulesGrid.innerHTML = '<div class="table-empty">No active schedules configured</div>';
      } else {
        schedulesGrid.innerHTML = cachedSchedules.map(sc => `
          <div class="schedule-card">
            <div class="shift-card-header">
              <span class="shift-name">${escapeHtml(sc.name)}</span>
              <span class="status-pill status-in">${sc.active_user_count || 0} Assigned</span>
            </div>
            <div class="shift-detail-row">
              <span>Schedule ID:</span>
              <span class="font-mono">#${sc.id}</span>
            </div>
            <div class="shift-detail-row">
              <span>Cycle / Rotation:</span>
              <span>${sc.cycle_units || 'Weekly Cycle'}</span>
            </div>
            <div class="shift-detail-row">
              <span>Valid Period:</span>
              <span class="font-mono">${sc.start_date ? String(sc.start_date).slice(0, 10) : '2013-01-01'} → ${sc.end_date ? String(sc.end_date).slice(0, 10) : 'Ongoing'}</span>
            </div>
            <div style="margin-top: 4px;">
              <small style="color:var(--text-muted);">Weekly Rotation (${(sc.details && sc.details.length) || 0} active day rules configured)</small>
            </div>
            ${isAdmin ? `
              <div class="card-actions-row">
                <button class="btn-card-action btn-action-primary btn-manage-assignments" data-id="${sc.id}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>
                  Personnel (${sc.active_user_count || 0})
                </button>
                <button class="btn-card-action btn-edit-schedule" data-id="${sc.id}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  Edit
                </button>
                <button class="btn-card-action btn-action-danger btn-delete-schedule" data-id="${sc.id}" data-name="${escapeHtml(sc.name)}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                  Delete
                </button>
              </div>
            ` : ''}
          </div>
        `).join('');

        schedulesGrid.querySelectorAll('.btn-manage-assignments').forEach(b => {
          b.addEventListener('click', () => {
            const sched = cachedSchedules.find(s => s.id === parseInt(b.dataset.id, 10));
            if (sched) openScheduleAssignmentsModal(sched);
          });
        });
        schedulesGrid.querySelectorAll('.btn-edit-schedule').forEach(b => {
          b.addEventListener('click', () => {
            const sched = cachedSchedules.find(s => s.id === parseInt(b.dataset.id, 10));
            if (sched) openScheduleModal(sched);
          });
        });
        schedulesGrid.querySelectorAll('.btn-delete-schedule').forEach(b => {
          b.addEventListener('click', () => {
            openDeleteConfirm('Delete Schedule', `Are you sure you want to delete schedule <strong>${b.dataset.name}</strong>? Assigned employees will be unassigned.`, () => {
              deleteSchedule(parseInt(b.dataset.id, 10));
            });
          });
        });
      }
    } catch (e) {
      shiftsGrid.innerHTML = `<div class="table-empty" style="color:var(--accent-rose)">Error loading shifts: ${escapeHtml(e.message)}</div>`;
    }
  }

  // Shift Modal
  function openShiftModal(shift = null) {
    if (!shiftModal) return;
    if (shift) {
      shiftModalTitle.textContent = 'Edit Shift Class';
      shiftFormId.value = shift.id;
      shiftFormName.value = shift.name || shift.SchName || '';
      shiftFormStartTime.value = shift.start_time ? String(shift.start_time).substring(0, 5) : '08:00';
      shiftFormEndTime.value = shift.end_time ? String(shift.end_time).substring(0, 5) : '17:00';
      shiftFormCheckin1.value = shift.check_in_time1 ? String(shift.check_in_time1).substring(0, 5) : '07:30';
      shiftFormCheckin2.value = shift.check_in_time2 ? String(shift.check_in_time2).substring(0, 5) : '09:00';
      shiftFormCheckout1.value = shift.check_out_time1 ? String(shift.check_out_time1).substring(0, 5) : '16:45';
      shiftFormCheckout2.value = shift.check_out_time2 ? String(shift.check_out_time2).substring(0, 5) : '19:00';
      shiftFormLateMins.value = shift.late_grace_minutes != null ? shift.late_grace_minutes : 15;
      shiftFormEarlyMins.value = shift.early_grace_minutes != null ? shift.early_grace_minutes : 5;
      shiftFormWorkday.value = shift.work_day_fraction != null ? shift.work_day_fraction : 1.0;
    } else {
      shiftModalTitle.textContent = 'Add Shift Class';
      shiftFormId.value = '';
      shiftFormName.value = '';
      shiftFormStartTime.value = '08:00';
      shiftFormEndTime.value = '17:00';
      shiftFormCheckin1.value = '07:30';
      shiftFormCheckin2.value = '09:00';
      shiftFormCheckout1.value = '16:45';
      shiftFormCheckout2.value = '19:00';
      shiftFormLateMins.value = '15';
      shiftFormEarlyMins.value = '5';
      shiftFormWorkday.value = '1.0';
    }
    shiftModal.style.display = 'flex';
  }

  async function saveShift() {
    const name = shiftFormName.value.trim();
    const start_time = shiftFormStartTime.value;
    const end_time = shiftFormEndTime.value;
    if (!name || !start_time || !end_time) {
      showToast('Shift Name, Start Time, and End Time are required', 'error');
      return;
    }

    const payload = {
      name,
      start_time,
      end_time,
      check_in_time1: shiftFormCheckin1.value || null,
      check_in_time2: shiftFormCheckin2.value || null,
      check_out_time1: shiftFormCheckout1.value || null,
      check_out_time2: shiftFormCheckout2.value || null,
      late_grace_minutes: parseInt(shiftFormLateMins.value, 10) || 0,
      early_grace_minutes: parseInt(shiftFormEarlyMins.value, 10) || 0,
      work_day_fraction: parseFloat(shiftFormWorkday.value) || 1.0
    };

    const editId = shiftFormId.value;
    try {
      const url = editId ? `/api/shifts/${editId}` : '/api/shifts';
      const method = editId ? 'PUT' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save shift');
      }
      showToast(editId ? 'Shift class updated' : 'Shift class created', 'success');
      shiftModal.style.display = 'none';
      loadShifts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteShift(id) {
    try {
      const res = await apiFetch(`/api/shifts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete shift');
      }
      showToast('Shift class deleted', 'success');
      loadShifts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // Schedule Modal
  function openScheduleModal(schedule = null) {
    if (!scheduleModal) return;
    if (schedule) {
      scheduleModalTitle.textContent = 'Edit Schedule';
      schedFormId.value = schedule.id;
      schedFormName.value = schedule.name || '';
      schedFormStartDate.value = schedule.start_date ? String(schedule.start_date).slice(0, 10) : '2026-01-01';
      schedFormEndDate.value = schedule.end_date ? String(schedule.end_date).slice(0, 10) : '2200-12-31';
    } else {
      scheduleModalTitle.textContent = 'Add Schedule';
      schedFormId.value = '';
      schedFormName.value = '';
      schedFormStartDate.value = new Date().toISOString().slice(0, 10);
      schedFormEndDate.value = '2200-12-31';
    }

    // Build day-by-day mapping rows
    const shiftOptions = cachedShifts.map(s => {
      const sName = s.name || s.SchName || ('Shift #' + s.id);
      const st = s.start_time ? String(s.start_time).substring(0, 5) : '';
      const et = s.end_time ? String(s.end_time).substring(0, 5) : '';
      return `<option value="${s.id}">${escapeHtml(sName)} (${st} - ${et})</option>`;
    }).join('');

    const detailsMap = {};
    if (schedule && Array.isArray(schedule.details)) {
      schedule.details.forEach(d => {
        detailsMap[d.start_day] = d.shift_class_id;
      });
    }

    scheduleDaysContainer.innerHTML = DAY_NAMES.map(d => {
      return `
        <div class="schedule-day-row">
          <span class="schedule-day-label">${d.name}</span>
          <select class="schedule-day-select" data-day="${d.day}">
            <option value="">Off / Rest Day</option>
            ${shiftOptions}
          </select>
        </div>
      `;
    }).join('');

    // Pre-select saved shift classes
    scheduleDaysContainer.querySelectorAll('.schedule-day-select').forEach(sel => {
      const day = parseInt(sel.dataset.day, 10);
      if (detailsMap[day]) {
        sel.value = detailsMap[day];
      }
    });

    scheduleModal.style.display = 'flex';
  }

  async function saveSchedule() {
    const name = schedFormName.value.trim();
    if (!name) {
      showToast('Schedule name is required', 'error');
      return;
    }

    const details = [];
    scheduleDaysContainer.querySelectorAll('.schedule-day-select').forEach(sel => {
      const shiftId = sel.value;
      if (shiftId) {
        const day = parseInt(sel.dataset.day, 10);
        details.push({
          start_day: day,
          end_day: day,
          shift_class_id: parseInt(shiftId, 10)
        });
      }
    });

    const payload = {
      name,
      start_date: schedFormStartDate.value || '2026-01-01',
      end_date: schedFormEndDate.value || '2200-12-31',
      cycle: 1,
      units: 1,
      details
    };

    const editId = schedFormId.value;
    try {
      const url = editId ? `/api/schedules/${editId}` : '/api/schedules';
      const method = editId ? 'PUT' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save schedule');
      }
      showToast(editId ? 'Schedule updated' : 'Schedule created', 'success');
      scheduleModal.style.display = 'none';
      loadShifts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteSchedule(id) {
    try {
      const res = await apiFetch(`/api/schedules/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete schedule');
      }
      showToast('Schedule deleted', 'success');
      loadShifts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // Schedule Assignments Modal
  async function openScheduleAssignmentsModal(schedule) {
    if (!scheduleAssignmentsModal) return;
    currentScheduleForAssignments = schedule;
    schedAssignModalTitle.textContent = `Assigned Personnel: ${schedule.name}`;
    schedAssignModalSubtext.textContent = `Schedule #${schedule.id} · ${schedule.cycle_units || 'Weekly Cycle'}`;
    schedAssignStart.value = new Date().toISOString().slice(0, 10);
    schedAssignEnd.value = '2200-12-31';
    if (schedAssignSearch) schedAssignSearch.value = '';

    scheduleAssignmentsModal.style.display = 'flex';
    populateAssignEmployeeSelect();
    loadScheduleRoster(schedule.id);
  }

  async function populateAssignEmployeeSelect() {
    try {
      const res = await apiFetch('/api/employees');
      const emps = await res.json();
      schedAssignEmpSelect.innerHTML = '<option value="">-- Choose Employee --</option>' + emps.map(e => `
        <option value="${e.user_id}">
          ${escapeHtml(e.name)} (Badge: ${escapeHtml(e.badge_number || '—')}${e.dept_name ? ' · ' + escapeHtml(e.dept_name) : ''})
        </option>
      `).join('');
    } catch (e) {
      schedAssignEmpSelect.innerHTML = '<option value="">Failed to load employees</option>';
    }
  }

  async function loadScheduleRoster(scheduleId) {
    if (!schedAssignTbody) return;
    schedAssignTbody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading roster...</td></tr>';
    try {
      const res = await apiFetch(`/api/schedules/${scheduleId}/assignments`);
      cachedAssignmentsList = await res.json();
      renderScheduleRoster();
    } catch (e) {
      schedAssignTbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color:var(--accent-rose)">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function renderScheduleRoster() {
    if (!schedAssignTbody) return;
    const filter = (schedAssignSearch?.value || '').toLowerCase().trim();
    const filtered = cachedAssignmentsList.filter(u => {
      if (!filter) return true;
      return (u.name && u.name.toLowerCase().includes(filter)) ||
             (u.badge_number && String(u.badge_number).toLowerCase().includes(filter)) ||
             (u.dept_name && u.dept_name.toLowerCase().includes(filter));
    });

    if (schedAssignCount) schedAssignCount.textContent = filtered.length;

    if (filtered.length === 0) {
      schedAssignTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No employees currently assigned</td></tr>';
      return;
    }

    schedAssignTbody.innerHTML = filtered.map(u => {
      const sDate = u.start_date ? String(u.start_date).slice(0, 10) : 'Ongoing';
      const eDate = u.end_date ? String(u.end_date).slice(0, 10) : 'Ongoing';
      return `
        <tr>
          <td>
            <strong>${escapeHtml(u.name)}</strong>
          </td>
          <td><span class="badge-number font-mono">${escapeHtml(u.badge_number || '—')}</span></td>
          <td>${escapeHtml(u.dept_name || 'General')}</td>
          <td class="font-mono" style="font-size:0.8rem;">${sDate} → ${eDate}</td>
          <td style="text-align: right;">
            <button class="btn-card-action btn-action-danger btn-unassign-emp" data-userid="${u.user_id}" data-name="${escapeHtml(u.name)}">
              Remove
            </button>
          </td>
        </tr>
      `;
    }).join('');

    schedAssignTbody.querySelectorAll('.btn-unassign-emp').forEach(b => {
      b.addEventListener('click', () => {
        openDeleteConfirm('Remove From Schedule', `Unassign <strong>${b.dataset.name}</strong> from ${currentScheduleForAssignments.name}?`, () => {
          unassignEmployeeFromSchedule(parseInt(b.dataset.userid, 10));
        });
      });
    });
  }

  async function unassignEmployeeFromSchedule(userId) {
    if (!currentScheduleForAssignments) return;
    try {
      const res = await apiFetch(`/api/schedules/${currentScheduleForAssignments.id}/assignments/${userId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to unassign employee');
      showToast('Employee unassigned from schedule', 'success');
      loadScheduleRoster(currentScheduleForAssignments.id);
      loadShifts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  btnSubmitSchedAssign?.addEventListener('click', async () => {
    if (!currentScheduleForAssignments) return;
    const userId = schedAssignEmpSelect.value;
    if (!userId) {
      showToast('Please select an employee to assign', 'error');
      return;
    }

    try {
      const res = await apiFetch(`/api/schedules/${currentScheduleForAssignments.id}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: parseInt(userId, 10),
          start_date: schedAssignStart.value || null,
          end_date: schedAssignEnd.value || null
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to assign employee');
      }
      showToast('Employee successfully assigned to schedule', 'success');
      schedAssignEmpSelect.value = '';
      loadScheduleRoster(currentScheduleForAssignments.id);
      loadShifts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  schedAssignSearch?.addEventListener('input', renderScheduleRoster);

  // Modal Triggers
  btnOpenShiftModal?.addEventListener('click', () => openShiftModal(null));
  btnCloseShiftModal?.addEventListener('click', () => { shiftModal.style.display = 'none'; });
  btnCancelShift?.addEventListener('click', () => { shiftModal.style.display = 'none'; });
  btnSaveShift?.addEventListener('click', saveShift);

  btnOpenScheduleModal?.addEventListener('click', () => openScheduleModal(null));
  btnCloseScheduleModal?.addEventListener('click', () => { scheduleModal.style.display = 'none'; });
  btnCancelSched?.addEventListener('click', () => { scheduleModal.style.display = 'none'; });
  btnSaveSched?.addEventListener('click', saveSchedule);

  btnCloseSchedAssignModal?.addEventListener('click', () => { scheduleAssignmentsModal.style.display = 'none'; });
  btnCloseSchedAssignFooter?.addEventListener('click', () => { scheduleAssignmentsModal.style.display = 'none'; });

  // ─── 10. MODULE: LEAVE REQUESTS & MANAGEMENT ──────────────────────────────
  const leavesTbody = document.getElementById('leaves-tbody');
  const leaveStatusFilter = document.getElementById('leave-status-filter');
  const leaveTypeFilter = document.getElementById('leave-type-filter');
  const btnOpenLeaveModal = document.getElementById('btn-open-leave-modal');
  const leaveModal = document.getElementById('leave-modal');
  const btnCloseLeaveModal = document.getElementById('btn-close-leave-modal');
  const btnCancelLeave = document.getElementById('btn-cancel-leave');
  const btnSaveLeave = document.getElementById('btn-save-leave');
  const leaveFormEmp = document.getElementById('leave-form-emp');
  const leaveFormType = document.getElementById('leave-form-type');
  const leaveFormStart = document.getElementById('leave-form-start');
  const leaveFormEnd = document.getElementById('leave-form-end');
  const leaveFormNotes = document.getElementById('leave-form-notes');
  const leaveFormStatus = document.getElementById('leave-form-status');
  const leaveStatusGroup = document.getElementById('leave-status-group');

  async function loadLeaveTypes() {
    try {
      const res = await apiFetch('/api/leave-types');
      leaveTypesList = await res.json();
      const options = leaveTypesList.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
      if (leaveTypeFilter) leaveTypeFilter.innerHTML = '<option value="">All Types</option>' + options;
      if (leaveFormType) leaveFormType.innerHTML = '<option value="">Select Type...</option>' + options;
    } catch (e) {
      console.warn('Could not load leave types:', e);
    }
  }

  async function loadLeaves() {
    if (!leavesTbody) return;
    leavesTbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading leaves...</td></tr>';
    try {
      const params = new URLSearchParams();
      if (leaveStatusFilter.value) params.append('status', leaveStatusFilter.value);
      if (leaveTypeFilter.value) params.append('leave_type_id', leaveTypeFilter.value);

      const res = await apiFetch(`/api/leaves?${params.toString()}`);
      const list = await res.json();

      if (!list.length) {
        leavesTbody.innerHTML = '<tr><td colspan="8" class="table-empty">No leave records found</td></tr>';
        return;
      }

      leavesTbody.innerHTML = list.map(l => {
        const statusClass = `status-${l.status}`;
        const days = l.duration_days ? `${l.duration_days} day(s)` : '--';
        const isAdmin = currentUser && currentUser.role === 'admin';
        const startDate = l.start_date ? String(l.start_date).slice(0, 10) : '--';
        const endDate = l.end_date ? String(l.end_date).slice(0, 10) : '--';

        return `
          <tr>
            <td>
              <strong>${escapeHtml(l.employee_name)}</strong>
              <div style="font-size:0.75rem; color:var(--text-muted)">Badge #${escapeHtml(l.badge_number || l.user_id)}</div>
            </td>
            <td>${escapeHtml(l.dept_name || 'General')}</td>
            <td><span class="badge-number">${escapeHtml(l.leave_type_name || 'Leave')}</span></td>
            <td class="font-mono">${startDate} → ${endDate}</td>
            <td><strong>${days}</strong></td>
            <td style="color:var(--text-secondary); max-width:200px;" title="${escapeHtml(l.notes || '')}">${escapeHtml(l.notes || '—')}</td>
            <td><span class="status-pill ${statusClass}">${l.status.toUpperCase()}</span></td>
            <td>
              <div class="table-actions">
                ${isAdmin && l.status === 'pending' ? `
                  <button class="btn-icon edit" data-action="approve" data-id="${l.id}" title="Approve Leave" style="color:var(--accent-emerald)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                  <button class="btn-icon delete" data-action="reject" data-id="${l.id}" title="Reject Leave" style="color:var(--accent-rose)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                ` : ''}
                ${isAdmin ? `
                  <button class="btn-icon delete" data-action="delete" data-id="${l.id}" title="Delete Record">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                  </button>
                ` : '<span style="color:var(--text-muted); font-size:0.8rem">—</span>'}
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Wire leave table action buttons
      leavesTbody.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = parseInt(btn.dataset.id, 10);
          const action = btn.dataset.action;
          if (action === 'approve') {
            await updateLeaveStatus(id, 'approved');
          } else if (action === 'reject') {
            await updateLeaveStatus(id, 'rejected');
          } else if (action === 'delete') {
            openDeleteConfirm('Delete Leave Record', 'Are you sure you want to permanently delete this leave entry?', async () => {
              await deleteLeave(id);
            });
          }
        });
      });
    } catch (e) {
      leavesTbody.innerHTML = `<tr><td colspan="8" class="table-empty" style="color:var(--accent-rose)">Error loading leaves: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function updateLeaveStatus(id, status) {
    try {
      const res = await apiFetch(`/api/leaves/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error('Failed to update status');
      showToast(`Leave status updated to ${status}`, 'success');
      loadLeaves();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteLeave(id) {
    try {
      const res = await apiFetch(`/api/leaves/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete leave');
      showToast('Leave entry deleted', 'success');
      loadLeaves();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // Modal open
  btnOpenLeaveModal?.addEventListener('click', () => {
    leaveFormEmp.value = '';
    leaveFormType.value = '';
    leaveFormStart.value = new Date().toISOString().split('T')[0];
    leaveFormEnd.value = new Date().toISOString().split('T')[0];
    leaveFormNotes.value = '';

    // Viewer role default behavior
    if (currentUser && currentUser.role === 'viewer') {
      leaveStatusGroup.style.display = 'none';
      leaveFormStatus.value = 'pending';
    } else {
      leaveStatusGroup.style.display = 'block';
      leaveFormStatus.value = 'approved';
    }

    leaveModal.style.display = 'flex';
  });

  btnCloseLeaveModal?.addEventListener('click', () => { leaveModal.style.display = 'none'; });
  btnCancelLeave?.addEventListener('click', () => { leaveModal.style.display = 'none'; });

  btnSaveLeave?.addEventListener('click', async () => {
    const user_id = leaveFormEmp.value;
    const leave_type_id = leaveFormType.value;
    const start_date = leaveFormStart.value;
    const end_date = leaveFormEnd.value;
    const notes = leaveFormNotes.value.trim();
    const status = leaveFormStatus.value || 'pending';

    if (!user_id || !leave_type_id || !start_date || !end_date) {
      showToast('Please fill all required fields', 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/leaves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: parseInt(user_id, 10),
          leave_type_id: parseInt(leave_type_id, 10),
          start_date,
          end_date,
          notes,
          status,
          submitted_by_self: currentUser.role === 'viewer' ? 1 : 0
        })
      });
      if (!res.ok) throw new Error('Failed to create leave request');
      showToast('Leave request saved successfully', 'success');
      leaveModal.style.display = 'none';
      loadLeaves();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  leaveStatusFilter?.addEventListener('change', loadLeaves);
  leaveTypeFilter?.addEventListener('change', loadLeaves);

  // ─── 11. MODULE: HOLIDAY CALENDAR ─────────────────────────────────────────
  const holidaysGrid = document.getElementById('holidays-grid');
  const holidayYearFilter = document.getElementById('holiday-year-filter');
  const btnOpenHolidayModal = document.getElementById('btn-open-holiday-modal');
  const holidayModal = document.getElementById('holiday-modal');
  const btnCloseHolidayModal = document.getElementById('btn-close-holiday-modal');
  const btnCancelHoliday = document.getElementById('btn-cancel-holiday');
  const btnSaveHoliday = document.getElementById('btn-save-holiday');
  const holidayFormName = document.getElementById('holiday-form-name');
  const holidayFormDate = document.getElementById('holiday-form-date');
  const holidayFormDuration = document.getElementById('holiday-form-duration');

  async function loadHolidays() {
    if (!holidaysGrid) return;
    holidaysGrid.innerHTML = '<div class="grid-loading">Loading holidays...</div>';
    try {
      const year = holidayYearFilter.value;
      const params = new URLSearchParams();
      if (year && year !== 'all') params.append('year', year);

      const res = await apiFetch(`/api/holidays?${params.toString()}`);
      const list = await res.json();

      if (!list.length) {
        holidaysGrid.innerHTML = '<div class="table-empty">No holidays recorded for this year</div>';
        return;
      }

      holidaysGrid.innerHTML = list.map(h => {
        const dateStr = h.date ? String(h.date).slice(0, 10) : '';
        const dateObj = new Date(dateStr + 'T12:00:00');
        const monthStr = dateObj.toLocaleDateString('en-US', { month: 'short' });
        const dayStr = dateObj.getDate();
        const weekdayStr = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
        const isAdmin = currentUser && currentUser.role === 'admin';

        return `
          <div class="holiday-card">
            <div style="display:flex; align-items:center; gap:14px;">
              <div class="holiday-date-badge">
                <span class="holiday-date-month">${monthStr}</span>
                <span class="holiday-date-day">${dayStr}</span>
              </div>
              <div style="flex:1;">
                <h3 style="font-size:1.05rem; font-weight:700;">${escapeHtml(h.name)}</h3>
                <span style="font-size:0.8rem; color:var(--text-muted);">${weekdayStr}, ${dateStr}</span>
              </div>
              ${isAdmin ? `
                <button class="btn-icon delete" data-id="${h.id}" data-name="${escapeHtml(h.name)}" title="Delete Holiday">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
              ` : ''}
            </div>
            <div class="shift-detail-row" style="margin-top:6px; border-top:1px solid rgba(255,255,255,0.05); padding-top:8px;">
              <span>Duration:</span>
              <span class="font-mono">${h.duration || h.duration_days || 1} day(s)</span>
            </div>
          </div>
        `;
      }).join('');

      holidaysGrid.querySelectorAll('.btn-icon.delete').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          const name = btn.dataset.name;
          openDeleteConfirm('Delete Holiday', `Are you sure you want to remove <strong>${name}</strong> from the official calendar?`, async () => {
            await deleteHoliday(id);
          });
        });
      });
    } catch (e) {
      holidaysGrid.innerHTML = `<div class="table-empty" style="color:var(--accent-rose)">Error loading holidays: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function deleteHoliday(id) {
    try {
      const res = await apiFetch(`/api/holidays/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete holiday');
      showToast('Holiday deleted', 'success');
      loadHolidays();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  btnOpenHolidayModal?.addEventListener('click', () => {
    holidayFormName.value = '';
    holidayFormDate.value = new Date().toISOString().split('T')[0];
    holidayFormDuration.value = '1';
    holidayModal.style.display = 'flex';
  });

  btnCloseHolidayModal?.addEventListener('click', () => { holidayModal.style.display = 'none'; });
  btnCancelHoliday?.addEventListener('click', () => { holidayModal.style.display = 'none'; });

  btnSaveHoliday?.addEventListener('click', async () => {
    const name = holidayFormName.value.trim();
    const date = holidayFormDate.value;
    const duration = parseInt(holidayFormDuration.value, 10) || 1;

    if (!name || !date) {
      showToast('Please provide a holiday name and date', 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/holidays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, date, duration })
      });
      if (!res.ok) throw new Error('Failed to add holiday');
      showToast('Holiday added successfully', 'success');
      holidayModal.style.display = 'none';
      loadHolidays();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  holidayYearFilter?.addEventListener('change', loadHolidays);

  // ─── 12. MODULE: PUNCH CORRECTIONS ────────────────────────────────────────
  const correctionsTbody = document.getElementById('corrections-tbody');
  const corrFromDate = document.getElementById('corr-from-date');
  const corrToDate = document.getElementById('corr-to-date');
  const btnFilterCorrections = document.getElementById('btn-filter-corrections');
  const btnOpenCorrModal = document.getElementById('btn-open-correction-modal');
  const corrModal = document.getElementById('correction-modal');
  const btnCloseCorrModal = document.getElementById('btn-close-corr-modal');
  const btnCancelCorr = document.getElementById('btn-cancel-corr');
  const btnSaveCorr = document.getElementById('btn-save-corr');
  const corrFormEmp = document.getElementById('corr-form-emp');
  const corrFormTime = document.getElementById('corr-form-time');
  const corrFormType = document.getElementById('corr-form-type');
  const corrFormReason = document.getElementById('corr-form-reason');

  if (corrFromDate && !corrFromDate.value) corrFromDate.value = '';
  if (corrToDate && !corrToDate.value) corrToDate.value = '';

  async function loadCorrections() {
    if (!correctionsTbody) return;
    correctionsTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading punch corrections...</td></tr>';
    try {
      const params = new URLSearchParams();
      if (corrFromDate.value) params.append('from', corrFromDate.value);
      if (corrToDate.value) params.append('to', corrToDate.value);

      const res = await apiFetch(`/api/punch-corrections?${params.toString()}`);
      const list = await res.json();

      if (!list.length) {
        correctionsTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No punch corrections found for period</td></tr>';
        return;
      }

      correctionsTbody.innerHTML = list.map(c => {
        const isAdmin = currentUser && currentUser.role === 'admin';
        const isDeleted = c.is_deleted === 1;
        return `
          <tr>
            <td class="font-mono" style="color:var(--accent-cyan);">${formatTime(c.check_time)}</td>
            <td>
              <strong>${escapeHtml(c.employee_name)}</strong>
              <div style="font-size:0.75rem; color:var(--text-muted)">Badge #${escapeHtml(c.badge_number || c.user_id)}</div>
            </td>
            <td><span class="status-pill status-${(c.check_type || 'i').toLowerCase()}">${(c.check_type || 'I').toUpperCase()}</span></td>
            <td>${escapeHtml(c.reason || '—')}</td>
            <td><span class="badge-number">${escapeHtml(c.operator || c.modified_by || 'SYSTEM')}</span></td>
            <td><span class="status-pill ${isDeleted ? 'status-rejected' : 'status-approved'}">${isDeleted ? 'VOIDED' : 'VERIFIED'}</span></td>
            <td>
              ${isAdmin && !isDeleted ? `
                <button class="btn-icon delete" data-id="${c.id}" data-user="${escapeHtml(c.employee_name)}" title="Void Correction">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              ` : (isDeleted ? '<span style="color:var(--text-muted); font-size:0.75rem;">Voided</span>' : '—')}
            </td>
          </tr>
        `;
      }).join('');

      correctionsTbody.querySelectorAll('.btn-icon.delete').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          openDeleteConfirm('Void Punch Correction', `Are you sure you want to void this corrected punch for <strong>${btn.dataset.user}</strong>?`, async () => {
            await voidCorrection(id);
          });
        });
      });
    } catch (e) {
      correctionsTbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--accent-rose)">Error loading corrections: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function voidCorrection(id) {
    try {
      const res = await apiFetch(`/api/punch-corrections/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to void correction');
      showToast('Correction voided successfully', 'success');
      loadCorrections();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  btnOpenCorrModal?.addEventListener('click', () => {
    corrFormEmp.value = '';
    const nowIso = new Date().toISOString().substring(0, 16);
    corrFormTime.value = nowIso;
    corrFormType.value = 'in';
    corrFormReason.value = '';
    corrModal.style.display = 'flex';
  });

  btnCloseCorrModal?.addEventListener('click', () => { corrModal.style.display = 'none'; });
  btnCancelCorr?.addEventListener('click', () => { corrModal.style.display = 'none'; });

  btnSaveCorr?.addEventListener('click', async () => {
    const user_id = corrFormEmp.value;
    const check_time = corrFormTime.value;
    const check_type = corrFormType.value;
    const reason = corrFormReason.value.trim();

    if (!user_id || !check_time || !reason) {
      showToast('Please specify employee, timestamp, and justification reason', 'error');
      return;
    }

    try {
      const res = await apiFetch('/api/punch-corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: parseInt(user_id, 10),
          check_time,
          check_type,
          reason
        })
      });
      if (!res.ok) throw new Error('Failed to record punch correction');
      showToast('Punch correction recorded into audit trail', 'success');
      corrModal.style.display = 'none';
      loadCorrections();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  const btnClearCorrections = document.getElementById('btn-clear-corrections');
  btnFilterCorrections?.addEventListener('click', loadCorrections);
  btnClearCorrections?.addEventListener('click', () => {
    if (corrFromDate) corrFromDate.value = '';
    if (corrToDate) corrToDate.value = '';
    loadCorrections();
  });

  // ─── 13. MODULE: SYSTEM USERS ADMIN (APP USERS) ───────────────────────────
  const appUsersTbody = document.getElementById('app-users-tbody');
  const appuserSearchInput = document.getElementById('appuser-search-input');
  const btnOpenAppUserModal = document.getElementById('btn-open-appuser-modal');
  const appUserModal = document.getElementById('appuser-modal');
  const appUserModalTitle = document.getElementById('appuser-modal-title');
  const btnCloseAppUserModal = document.getElementById('btn-close-appuser-modal');
  const btnCancelAppUser = document.getElementById('btn-cancel-appuser');
  const btnSaveAppUser = document.getElementById('btn-save-appuser');
  const appUserFormUsername = document.getElementById('appuser-form-username');
  const appUserFormFullname = document.getElementById('appuser-form-fullname');
  const appUserFormPassword = document.getElementById('appuser-form-password');
  const appUserPwReq = document.getElementById('appuser-pw-req');
  const appUserPwHint = document.getElementById('appuser-pw-hint');
  const appUserFormRole = document.getElementById('appuser-form-role');
  const appUserFormActive = document.getElementById('appuser-form-active');

  async function loadAppUsers() {
    if (!appUsersTbody) return;
    appUsersTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading system users...</td></tr>';
    try {
      const res = await apiFetch('/api/admin/app-users');
      const list = await res.json();

      const q = (appuserSearchInput.value || '').trim().toLowerCase();
      const filtered = q
        ? list.filter(u => u.username.toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q))
        : list;

      if (!filtered.length) {
        appUsersTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No user accounts found</td></tr>';
        return;
      }

      appUsersTbody.innerHTML = filtered.map(u => `
        <tr>
          <td class="font-mono">#${u.id}</td>
          <td><strong style="color:var(--accent-cyan); font-family:var(--font-mono);">${escapeHtml(u.username)}</strong></td>
          <td>${escapeHtml(u.full_name || '—')}</td>
          <td><span class="status-pill ${u.role === 'admin' ? 'status-in' : 'status-out'}">${u.role.toUpperCase()}</span></td>
          <td><span class="device-status-badge ${u.is_active ? 'active' : 'inactive'}">${u.is_active ? '● Active' : '○ Inactive'}</span></td>
          <td style="color:var(--text-muted); font-size:0.8rem">${u.created_at ? u.created_at.substring(0, 10) : '—'}</td>
          <td>
            <div class="table-actions">
              <button class="btn-icon edit" data-id="${u.id}" title="Edit User">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              ${u.id !== (currentUser && currentUser.id) ? `
                <button class="btn-icon delete" data-id="${u.id}" data-user="${escapeHtml(u.username)}" title="Delete User">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `).join('');

      appUsersTbody.querySelectorAll('.btn-icon.edit').forEach(btn => {
        btn.addEventListener('click', () => openAppUserModal(parseInt(btn.dataset.id, 10)));
      });

      appUsersTbody.querySelectorAll('.btn-icon.delete').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          openDeleteConfirm('Delete System User', `Are you sure you want to permanently remove user account <strong>${btn.dataset.user}</strong>?`, async () => {
            await deleteAppUser(id);
          });
        });
      });
    } catch (e) {
      appUsersTbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--accent-rose)">Error loading system users: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function openAppUserModal(id = null) {
    appUserEditId = id;
    if (id) {
      appUserModalTitle.textContent = 'Edit System User';
      appUserPwReq.style.display = 'none';
      appUserPwHint.style.display = 'block';
      try {
        const res = await apiFetch('/api/admin/app-users');
        const list = await res.json();
        const user = list.find(u => u.id === id);
        if (user) {
          appUserFormUsername.value = user.username;
          appUserFormFullname.value = user.full_name || '';
          appUserFormPassword.value = '';
          appUserFormRole.value = user.role;
          appUserFormActive.checked = !!user.is_active;
        }
      } catch (e) {
        showToast('Error loading user details', 'error');
      }
    } else {
      appUserModalTitle.textContent = 'Add System User';
      appUserPwReq.style.display = 'inline';
      appUserPwHint.style.display = 'none';
      appUserFormUsername.value = '';
      appUserFormFullname.value = '';
      appUserFormPassword.value = '';
      appUserFormRole.value = 'viewer';
      appUserFormActive.checked = true;
    }
    appUserModal.style.display = 'flex';
  }

  async function deleteAppUser(id) {
    try {
      const res = await apiFetch(`/api/admin/app-users/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete user');
      showToast('User account deleted', 'success');
      loadAppUsers();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  btnOpenAppUserModal?.addEventListener('click', () => openAppUserModal(null));
  btnCloseAppUserModal?.addEventListener('click', () => { appUserModal.style.display = 'none'; });
  btnCancelAppUser?.addEventListener('click', () => { appUserModal.style.display = 'none'; });

  btnSaveAppUser?.addEventListener('click', async () => {
    const username = appUserFormUsername.value.trim();
    const full_name = appUserFormFullname.value.trim();
    const password = appUserFormPassword.value;
    const role = appUserFormRole.value;
    const is_active = appUserFormActive.checked ? 1 : 0;

    if (!username || !full_name) {
      showToast('Please enter both username and full name', 'error');
      return;
    }

    if (!appUserEditId && (!password || password.length < 6)) {
      showToast('Password must be at least 6 characters', 'error');
      return;
    }

    try {
      const payload = { username, full_name, role, is_active };
      if (password) payload.password = password;

      const url = appUserEditId ? `/api/admin/app-users/${appUserEditId}` : '/api/admin/app-users';
      const method = appUserEditId ? 'PUT' : 'POST';

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to save user account');
      }

      showToast(appUserEditId ? 'User updated successfully' : 'User created successfully', 'success');
      appUserModal.style.display = 'none';
      loadAppUsers();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  appuserSearchInput?.addEventListener('input', loadAppUsers);

  // ─── 14. MODULE: DASHBOARD ────────────────────────────────────────────────
  async function loadDashboard() {
    try {
      const res = await apiFetch('/api/dashboard');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const kpiTotalEmployees = document.getElementById('kpi-total-employees');
      const kpiActiveToday = document.getElementById('kpi-active-today');
      const kpiPunchesToday = document.getElementById('kpi-punches-today');
      const kpiTotalPunches = document.getElementById('kpi-total-punches');

      const stats = data.stats || data.summary || {};
      if (kpiTotalEmployees) kpiTotalEmployees.textContent = Number(stats.totalEmployees || 0).toLocaleString();
      if (kpiActiveToday) kpiActiveToday.textContent = Number(stats.activeToday || 0).toLocaleString();
      if (kpiPunchesToday) kpiPunchesToday.textContent = Number(stats.punchesToday || 0).toLocaleString();
      if (kpiTotalPunches) kpiTotalPunches.textContent = Number(stats.totalPunches || 0).toLocaleString();

      const recentPunchesStream = document.getElementById('recent-punches-stream');
      if (recentPunchesStream) {
        if (data.recentPunches.length === 0) {
          recentPunchesStream.innerHTML = '<div class="table-empty">No recent punches found</div>';
        } else {
          recentPunchesStream.innerHTML = data.recentPunches.map(p => `
            <div class="stream-item">
              <div class="stream-badge ${p.normalized_type}">${p.normalized_type.toUpperCase()}</div>
              <div class="stream-info">
                <span class="stream-name">${escapeHtml(p.name)}</span>
                <span class="stream-details">${escapeHtml(p.dept_name || 'General')} • Badge #${escapeHtml(p.badge_number || p.user_id)}</span>
              </div>
              <div class="stream-time font-mono">${formatTime(p.check_time)}</div>
            </div>
          `).join('');
        }
      }

      const deptBreakdownList = document.getElementById('dept-breakdown-list');
      if (deptBreakdownList) {
        const maxEmployees = Math.max(...data.deptBreakdown.map(d => d.employee_count), 1);
        deptBreakdownList.innerHTML = data.deptBreakdown.map(d => {
          const pct = Math.round((d.employee_count / maxEmployees) * 100);
          return `
            <div class="dept-stat-row">
              <span class="dept-stat-name">${escapeHtml(d.dept_name)}</span>
              <div class="dept-stat-bar-wrapper">
                <div class="dept-stat-bar" style="width: ${pct}%"></div>
              </div>
              <span class="dept-stat-count">${d.employee_count}</span>
            </div>
          `;
        }).join('');
      }
    } catch (e) {
      console.warn('Dashboard load failed:', e);
    }
  }

  // ─── 15. MODULE: PERSONNEL DIRECTORY ──────────────────────────────────────
  const empSearchInput = document.getElementById('emp-search-input');
  const empDeptFilter = document.getElementById('emp-dept-filter');
  const employeesGrid = document.getElementById('employees-grid');

  async function loadEmployees() {
    if (!employeesGrid) return;
    employeesGrid.innerHTML = '<div class="table-empty" style="grid-column:1/-1;">Loading personnel...</div>';
    try {
      const params = new URLSearchParams();
      if (empSearchInput?.value.trim()) params.append('search', empSearchInput.value.trim());
      if (empDeptFilter?.value) params.append('dept_id', empDeptFilter.value);
      params.append('limit', '50');

      const res = await apiFetch(`/api/employees?${params.toString()}`);
      const data = await res.json();
      const employees = Array.isArray(data) ? data : (data.employees || []);

      if (!employees.length) {
        employeesGrid.innerHTML = '<div class="table-empty" style="grid-column:1/-1;">No personnel found</div>';
        return;
      }

      employeesGrid.innerHTML = employees.map(e => `
        <div class="emp-card" data-id="${e.user_id}">
          <div class="emp-card-header">
            <div class="avatar">${(e.name || '?').charAt(0)}</div>
            <div class="emp-meta">
              <span class="emp-name">${escapeHtml(e.name)}</span>
              <span class="emp-badge font-mono">Badge #${escapeHtml(e.badge_number || e.user_id)}</span>
            </div>
          </div>
          <div class="emp-card-body">
            <div class="emp-field">
              <span class="emp-label">Department</span>
              <span class="emp-value">${escapeHtml(e.dept_name || 'General')}</span>
            </div>
            <div class="emp-field">
              <span class="emp-label">Gender</span>
              <span class="emp-value">${escapeHtml(e.gender || '—')}</span>
            </div>
            <div class="emp-field">
              <span class="emp-label">Latest Activity</span>
              <span class="emp-value font-mono" style="font-size:0.8rem">${e.last_punch_time ? formatTime(e.last_punch_time) : (e.last_punch ? formatTime(e.last_punch) : 'Never')}</span>
            </div>
          </div>
        </div>
      `).join('');

      employeesGrid.querySelectorAll('.emp-card').forEach(card => {
        card.addEventListener('click', () => openEmployeeModal(parseInt(card.dataset.id, 10)));
      });
    } catch (e) {
      employeesGrid.innerHTML = `<div class="table-empty" style="grid-column:1/-1;color:var(--accent-rose)">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  empSearchInput?.addEventListener('input', () => {
    clearTimeout(window.empSearchTimeout);
    window.empSearchTimeout = setTimeout(loadEmployees, 300);
  });
  empDeptFilter?.addEventListener('change', loadEmployees);

  // ─── 16. MODULE: PUNCH LOG AUDIT TRAIL ────────────────────────────────────
  const punchDateFrom = document.getElementById('punch-date-from');
  const punchDateTo = document.getElementById('punch-date-to');
  const punchTypeFilter = document.getElementById('punch-type-filter');
  const btnApplyPunchFilters = document.getElementById('btn-apply-punch-filters');
  const btnResetPunchFilters = document.getElementById('btn-reset-punch-filters');
  const punchesTbody = document.getElementById('punches-tbody');
  const punchPageInfo = document.getElementById('punch-page-info');
  const btnPunchPrev = document.getElementById('btn-punch-prev');
  const btnPunchNext = document.getElementById('btn-punch-next');

  async function loadPunches() {
    if (!punchesTbody) return;
    punchesTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading punches...</td></tr>';
    try {
      const params = new URLSearchParams({
        page: punchPage,
        limit: punchLimit
      });
      if (punchDateFrom?.value) params.append('from', punchDateFrom.value);
      if (punchDateTo?.value) params.append('to', punchDateTo.value);
      if (punchTypeFilter?.value) params.append('type', punchTypeFilter.value);

      const res = await apiFetch(`/api/punches?${params.toString()}`);
      const data = await res.json();

      const punches = data.punches || data.data || (Array.isArray(data) ? data : []);
      const pagination = data.pagination || {
        page: data.page || 1,
        pages: data.totalPages || 1,
        total: data.total || punches.length
      };

      if (!punches.length) {
        punchesTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No punch activity found</td></tr>';
        if (punchPageInfo) punchPageInfo.textContent = 'Page 1 of 1';
        return;
      }

      if (punchPageInfo) {
        punchPageInfo.textContent = `Page ${pagination.page} of ${pagination.pages} (${(pagination.total || 0).toLocaleString()} records)`;
      }
      if (btnPunchPrev) btnPunchPrev.disabled = pagination.page <= 1;
      if (btnPunchNext) btnPunchNext.disabled = pagination.page >= pagination.pages;

      punchesTbody.innerHTML = punches.map(p => `
        <tr>
          <td class="font-mono"><strong>${formatTime(p.check_time)}</strong></td>
          <td><span class="badge-number font-mono">${escapeHtml(p.badge_number || p.user_id)}</span></td>
          <td><strong>${escapeHtml(p.name || p.employee_name)}</strong></td>
          <td>${escapeHtml(p.dept_name || 'General')}</td>
          <td><span class="status-pill status-${(p.normalized_type || 'in').toLowerCase()}">${(p.normalized_type || 'IN').toUpperCase()}</span></td>
          <td class="font-mono" style="color:var(--text-muted); font-size:0.8rem">${escapeHtml(p.sn || p.sensor_id || '—')}</td>
          <td><span class="badge-number">${escapeHtml(p.device_alias || p.sensor_id || 'Main Reader')}</span></td>
        </tr>
      `).join('');
    } catch (e) {
      punchesTbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--accent-rose)">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  btnApplyPunchFilters?.addEventListener('click', () => { punchPage = 1; loadPunches(); });
  btnResetPunchFilters?.addEventListener('click', () => {
    punchDateFrom.value = '';
    punchDateTo.value = '';
    punchTypeFilter.value = '';
    punchPage = 1;
    loadPunches();
  });
  btnPunchPrev?.addEventListener('click', () => { if (punchPage > 1) { punchPage--; loadPunches(); } });
  btnPunchNext?.addEventListener('click', () => { punchPage++; loadPunches(); });

  // ─── 17. MODULE: REPORTS STUDIO (DELEGATED TO MODULE 8) ───────────────────
  // All report generation, column customization, export, and presets are unified in ReportsStudio (Module 8).


  // ─── 18. MODULE: CLOCK DEVICES ────────────────────────────────────────────
  const devicesTbody = document.getElementById('devices-tbody');
  const deviceSearchInput = document.getElementById('device-search-input');
  const deviceModal = document.getElementById('device-modal');
  const deviceModalTitle = document.getElementById('device-modal-title');
  const btnCloseDeviceModal = document.getElementById('btn-close-device-modal');
  const btnCancelDevice = document.getElementById('btn-cancel-device');
  const btnSaveDevice = document.getElementById('btn-save-device');
  const btnOpenDeviceModal = document.getElementById('btn-add-device') || document.getElementById('btn-open-device-modal');
  const btnImportDevices = document.getElementById('btn-import-devices');
  const deviceFormSn = document.getElementById('device-form-sn');
  const deviceFormAlias = document.getElementById('device-form-alias');
  const deviceFormIp = document.getElementById('device-form-ip');
  const deviceFormModel = document.getElementById('device-form-model');
  const deviceFormLocation = document.getElementById('device-form-location');
  const deviceFormStatus = document.getElementById('device-form-status');

  const btnTestAllDevices = document.getElementById('btn-test-all-devices');
  let deviceConnectionStatuses = {};
  let isProbingDevices = false;

  function getConnectionBadgeHtml(d) {
    if (!d.ip_address) {
      return `<span class="device-conn-badge no-ip" title="No IP address configured">— No IP</span>`;
    }
    const status = deviceConnectionStatuses[d.id];
    if (!status) {
      return `<span class="device-conn-badge checking" id="device-conn-${d.id}"><span class="conn-dot checking"></span>Checking...</span>`;
    }
    if (status.checking) {
      return `<span class="device-conn-badge checking" id="device-conn-${d.id}"><span class="conn-dot checking"></span>Testing...</span>`;
    }
    if (status.connected) {
      return `<span class="device-conn-badge connected" id="device-conn-${d.id}" title="Reachable on port 4370 (${status.latencyMs}ms)"><span class="conn-dot connected"></span>Connected <small class="conn-latency">${status.latencyMs}ms</small></span>`;
    }
    return `<span class="device-conn-badge disconnected" id="device-conn-${d.id}" title="${escapeHtml(status.error || 'Connection timed out')}"><span class="conn-dot disconnected"></span>Disconnected</span>`;
  }

  async function checkSingleDeviceConnection(id) {
    const badgeEl = document.getElementById(`device-conn-${id}`);
    if (badgeEl) {
      badgeEl.className = 'device-conn-badge checking';
      badgeEl.innerHTML = '<span class="conn-dot checking"></span>Testing...';
    }
    deviceConnectionStatuses[id] = { checking: true };

    try {
      const res = await apiFetch(`/api/devices/${id}/ping`);
      const data = await res.json();
      deviceConnectionStatuses[id] = data;
      const target = allDevices.find(x => x.id === id);
      if (badgeEl && target) {
        badgeEl.outerHTML = getConnectionBadgeHtml(target);
      }
      if (data.connected) {
        showToast(`Clock ${data.alias || data.sn} is connected (${data.latencyMs}ms)`, 'success');
      } else {
        showToast(`Clock ${data.alias || data.sn} is unreachable: ${data.error || 'Timeout'}`, 'error');
      }
    } catch (e) {
      deviceConnectionStatuses[id] = { connected: false, error: e.message };
      const target = allDevices.find(x => x.id === id);
      if (badgeEl && target) {
        badgeEl.outerHTML = getConnectionBadgeHtml(target);
      }
      showToast(`Ping failed: ${e.message}`, 'error');
    }
  }

  async function checkAllDeviceConnections() {
    if (isProbingDevices) return;
    isProbingDevices = true;
    if (btnTestAllDevices) btnTestAllDevices.classList.add('loading');

    // Show checking state on badges
    allDevices.forEach(d => {
      if (d.ip_address) {
        const el = document.getElementById(`device-conn-${d.id}`);
        if (el) {
          el.className = 'device-conn-badge checking';
          el.innerHTML = '<span class="conn-dot checking"></span>Checking...';
        }
      }
    });

    try {
      const res = await apiFetch('/api/devices/live-status');
      const data = await res.json();
      if (data.statuses) {
        deviceConnectionStatuses = { ...deviceConnectionStatuses, ...data.statuses };
        // Update DOM badges
        allDevices.forEach(d => {
          const el = document.getElementById(`device-conn-${d.id}`);
          if (el) {
            el.outerHTML = getConnectionBadgeHtml(d);
          }
        });
      }
    } catch (e) {
      console.warn('[Devices] Failed to probe connections:', e.message);
    } finally {
      isProbingDevices = false;
      if (btnTestAllDevices) btnTestAllDevices.classList.remove('loading');
    }
  }

  async function loadDevices() {
    if (!devicesTbody) return;
    devicesTbody.innerHTML = '<tr><td colspan="9" class="table-empty">Loading devices...</td></tr>';
    try {
      const res = await apiFetch('/api/devices');
      allDevices = await res.json();
      renderDevices(allDevices);
      checkAllDeviceConnections();
    } catch (e) {
      devicesTbody.innerHTML = `<tr><td colspan="9" class="table-empty">Error loading devices: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function renderDevices(list) {
    const q = (deviceSearchInput?.value || '').trim().toLowerCase();
    const filtered = q
      ? list.filter(d =>
          (d.sn || '').toLowerCase().includes(q) ||
          (d.alias || '').toLowerCase().includes(q) ||
          (d.ip_address || '').toLowerCase().includes(q)
        )
      : list;

    if (!filtered.length) {
      devicesTbody.innerHTML = '<tr><td colspan="9" class="table-empty">No devices found</td></tr>';
      return;
    }

    devicesTbody.innerHTML = filtered.map(d => `
      <tr>
        <td><span class="badge-number font-mono">${escapeHtml(d.sn)}</span></td>
        <td><strong>${escapeHtml(d.alias || '—')}</strong></td>
        <td><span class="font-mono" style="color:var(--accent-cyan);">${escapeHtml(d.ip_address || '—')}</span></td>
        <td style="color:var(--text-secondary);">${escapeHtml(d.location || '—')}</td>
        <td style="color:var(--text-muted); font-size:0.82rem;">${escapeHtml(d.model || '—')}</td>
        <td>${getConnectionBadgeHtml(d)}</td>
        <td><span class="device-status-badge ${d.status}">${d.status === 'active' ? '● Active' : '○ Inactive'}</span></td>
        <td><span class="punch-count-pill">${Number(d.punch_count).toLocaleString()}</span></td>
        <td>
          <div class="table-actions">
            <button class="btn-icon sync-device" data-id="${d.id}" data-alias="${escapeHtml(d.alias || d.sn)}" title="Direct Sync users & punches (port 4370)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6"/><path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            </button>
            <button class="btn-icon ping" data-id="${d.id}" data-alias="${escapeHtml(d.alias || d.sn)}" title="Test connection (port 4370)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
            </button>
            <button class="btn-icon edit" data-id="${d.id}" title="Edit device">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon delete" data-id="${d.id}" data-sn="${escapeHtml(d.sn)}" data-alias="${escapeHtml(d.alias || d.sn)}" title="Delete device">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('');

    devicesTbody.querySelectorAll('.btn-icon.sync-device').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.add('spinning');
        syncSingleDeviceAction(parseInt(btn.dataset.id, 10), btn.dataset.alias).finally(() => {
          btn.classList.remove('spinning');
        });
      });
    });

    devicesTbody.querySelectorAll('.btn-icon.ping').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.add('spinning');
        checkSingleDeviceConnection(parseInt(btn.dataset.id, 10)).finally(() => {
          btn.classList.remove('spinning');
        });
      });
    });
    devicesTbody.querySelectorAll('.btn-icon.edit').forEach(btn => {
      btn.addEventListener('click', () => openDeviceModal(parseInt(btn.dataset.id, 10)));
    });
    devicesTbody.querySelectorAll('.btn-icon.delete').forEach(btn => {
      btn.addEventListener('click', () => {
        openDeleteConfirm(
          'Delete Device',
          `Are you sure you want to remove device <strong>${escapeHtml(btn.dataset.alias)}</strong> (${btn.dataset.sn})?`,
          () => deleteDevice(parseInt(btn.dataset.id, 10))
        );
      });
    });
  }

  async function openDeviceModal(id = null) {
    deviceEditId = id;
    if (id) {
      deviceModalTitle.textContent = 'Edit Clock Device';
      deviceFormSn.disabled = true;
      try {
        const res = await apiFetch(`/api/devices/${id}`);
        const d = await res.json();
        deviceFormSn.value = d.sn || '';
        deviceFormAlias.value = d.alias || '';
        deviceFormIp.value = d.ip_address || '';
        deviceFormModel.value = d.model || '';
        deviceFormLocation.value = d.location || '';
        deviceFormStatus.value = d.status || 'active';
      } catch (e) {
        showToast('Error loading device details', 'error');
      }
    } else {
      deviceModalTitle.textContent = 'Add Clock Device';
      deviceFormSn.disabled = false;
      deviceFormSn.value = '';
      deviceFormAlias.value = '';
      deviceFormIp.value = '';
      deviceFormModel.value = '';
      deviceFormLocation.value = '';
      deviceFormStatus.value = 'active';
    }
    deviceModal.style.display = 'flex';
  }

  async function deleteDevice(id) {
    try {
      const res = await apiFetch(`/api/devices/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete device');
      showToast('Device removed from registry', 'success');
      loadDevices();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  btnOpenDeviceModal?.addEventListener('click', () => openDeviceModal(null));
  btnCloseDeviceModal?.addEventListener('click', () => { deviceModal.style.display = 'none'; });
  btnCancelDevice?.addEventListener('click', () => { deviceModal.style.display = 'none'; });
  deviceModal?.addEventListener('click', (e) => { if (e.target === deviceModal) deviceModal.style.display = 'none'; });

  btnSaveDevice?.addEventListener('click', async () => {
    const sn = deviceFormSn.value.trim();
    const alias = deviceFormAlias.value.trim();
    const ip_address = deviceFormIp.value.trim();
    const model = deviceFormModel.value.trim();
    const location = deviceFormLocation.value.trim();
    const status = deviceFormStatus.value;

    if (!sn) {
      showToast('Serial number is required', 'error');
      return;
    }

    try {
      const url = deviceEditId ? `/api/devices/${deviceEditId}` : '/api/devices';
      const method = deviceEditId ? 'PUT' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sn, alias, ip_address, model, location, status })
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to save device');
      }
      showToast(deviceEditId ? 'Device updated' : 'Device registered', 'success');
      deviceModal.style.display = 'none';
      loadDevices();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  btnImportDevices?.addEventListener('click', async () => {
    showToast('Scanning punch logs for clock devices...', 'info');
    try {
      const res = await apiFetch('/api/devices/import-from-punches', { method: 'POST' });
      const data = await res.json();
      showToast(data.message, 'success');
      loadDevices();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  btnTestAllDevices?.addEventListener('click', () => {
    showToast('Probing all clock connections (port 4370)...', 'info');
    checkAllDeviceConnections();
  });

  async function syncSingleDeviceAction(id, alias) {
    showToast(`Syncing with clock "${alias}" over network (port 4370)...`, 'info');
    try {
      const res = await apiFetch(`/api/devices/${id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Device sync failed');
      const r = data.result;
      showToast(`Synced "${alias}": ${r.usersRead} users (${r.usersUpserted} updated), ${r.punchesInserted} new punches in ${r.durationMs}ms.`, 'success');
      loadDevices();
      loadEmployees();
    } catch (e) {
      showToast(`Sync failed for "${alias}": ${e.message}`, 'error');
    }
  }

  const btnSyncAllDevices = document.getElementById('btn-sync-all-devices');
  btnSyncAllDevices?.addEventListener('click', async () => {
    btnSyncAllDevices.disabled = true;
    btnSyncAllDevices.classList.add('loading');
    showToast('Directly syncing with all active biometric clocks...', 'info');
    try {
      const res = await apiFetch('/api/devices/sync-all', { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Batch device sync failed');
      const r = data.result;
      showToast(`Device sync completed: ${r.successfulDevices}/${r.totalDevices} active clocks synced in ${(r.durationMs/1000).toFixed(1)}s.`, 'success');
      loadDevices();
      loadEmployees();
    } catch (e) {
      showToast(`Batch device sync failed: ${e.message}`, 'error');
    } finally {
      btnSyncAllDevices.disabled = false;
      btnSyncAllDevices.classList.remove('loading');
    }
  });

  deviceSearchInput?.addEventListener('input', () => renderDevices(allDevices));

  // ─── 19. MODULE: USERS ADMINISTRATION (PERSONNEL) ─────────────────────────
  const usersAdminTbody = document.getElementById('users-admin-tbody');
  const useradminSearchInput = document.getElementById('useradmin-search-input');
  const useradminDeptFilter = document.getElementById('useradmin-dept-filter');
  const userModal = document.getElementById('user-modal');
  const userModalTitle = document.getElementById('user-modal-title');
  const btnCloseUserModal = document.getElementById('btn-close-user-modal');
  const btnCancelUser = document.getElementById('btn-cancel-user');
  const btnSaveUser = document.getElementById('btn-save-user');
  const btnOpenUserModal = document.getElementById('btn-add-user') || document.getElementById('btn-open-user-modal');
  const userFormId = document.getElementById('user-form-id');
  const userFormBadge = document.getElementById('user-form-badge');
  const userFormName = document.getElementById('user-form-name');
  const userFormDept = document.getElementById('user-form-dept');
  const userFormGender = document.getElementById('user-form-gender');
  const userFormSchedule = document.getElementById('user-form-schedule');

  async function populateUserFormSchedules(selectedId = null) {
    if (!userFormSchedule) return;
    try {
      if (!cachedSchedules || cachedSchedules.length === 0) {
        const res = await apiFetch('/api/schedules');
        cachedSchedules = await res.json();
      }
      userFormSchedule.innerHTML = '<option value="">No Schedule (Unassigned)</option>' + cachedSchedules.map(s => `
        <option value="${s.id}">${escapeHtml(s.name)} (#${s.id})</option>
      `).join('');
      if (selectedId) {
        userFormSchedule.value = selectedId;
      } else {
        userFormSchedule.value = '';
      }
    } catch (e) {
      console.warn('Failed to load schedules for user form', e);
    }
  }

  async function loadUsersAdmin() {
    if (!usersAdminTbody) return;
    usersAdminTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading personnel...</td></tr>';
    try {
      const params = new URLSearchParams();
      if (useradminSearchInput?.value.trim()) params.append('search', useradminSearchInput.value.trim());
      if (useradminDeptFilter?.value) params.append('dept_id', useradminDeptFilter.value);

      const res = await apiFetch(`/api/admin/users?${params.toString()}`);
      allUsersAdmin = await res.json();

      if (!allUsersAdmin.length) {
        usersAdminTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No personnel found</td></tr>';
        return;
      }

      usersAdminTbody.innerHTML = allUsersAdmin.map(u => `
        <tr>
          <td><span class="badge-number font-mono">${u.user_id}</span></td>
          <td><span class="badge-number font-mono">${escapeHtml(u.badge_number || '—')}</span></td>
          <td>
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="avatar avatar-sm">${(u.name || '?').charAt(0)}</div>
              <strong>${escapeHtml(u.name)}</strong>
            </div>
          </td>
          <td>${escapeHtml(u.dept_name || 'General')}</td>
          <td>${escapeHtml(u.gender || '—')}</td>
          <td><span class="punch-count-pill">${Number(u.punch_count).toLocaleString()}</span></td>
          <td>
            <div class="table-actions">
              <button class="btn-icon edit" data-id="${u.user_id}" title="Edit User">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="btn-icon delete" data-id="${u.user_id}" data-name="${escapeHtml(u.name)}" title="Delete User">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `).join('');

      usersAdminTbody.querySelectorAll('.btn-icon.edit').forEach(btn => {
        btn.addEventListener('click', () => openUserModal(parseInt(btn.dataset.id, 10)));
      });
      usersAdminTbody.querySelectorAll('.btn-icon.delete').forEach(btn => {
        btn.addEventListener('click', () => {
          openDeleteConfirm('Delete Staff Member', `Are you sure you want to remove <strong>${btn.dataset.name}</strong> from personnel?`, () => {
            deleteUserAdmin(parseInt(btn.dataset.id, 10));
          });
        });
      });
    } catch (e) {
      usersAdminTbody.innerHTML = `<tr><td colspan="7" class="table-empty">Error loading personnel: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function openUserModal(id = null) {
    userEditId = id;
    if (id) {
      userModalTitle.textContent = 'Edit Staff Member';
      userFormId.disabled = true;
      try {
        const res = await apiFetch(`/api/employees/${id}`);
        const data = await res.json();
        const u = data.employee || data;
        userFormId.value = u.user_id;
        userFormBadge.value = u.badge_number || '';
        userFormName.value = u.name || '';
        userFormDept.value = u.dept_id || '';
        userFormGender.value = u.gender || '';
        await populateUserFormSchedules(u.schedule_id || null);
      } catch (e) {
        showToast('Error loading user details', 'error');
      }
    } else {
      userModalTitle.textContent = 'Add Staff Member';
      userFormId.disabled = false;
      userFormId.value = '';
      userFormBadge.value = '';
      userFormName.value = '';
      userFormDept.value = '';
      userFormGender.value = '';
      await populateUserFormSchedules(null);
    }
    userModal.style.display = 'flex';
  }

  async function deleteUserAdmin(id) {
    try {
      const res = await apiFetch(`/api/employees/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete staff member');
      showToast('Staff member deleted', 'success');
      loadUsersAdmin();
      loadEmployeesForSelects();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  btnOpenUserModal?.addEventListener('click', () => openUserModal(null));
  btnCloseUserModal?.addEventListener('click', () => { userModal.style.display = 'none'; });
  btnCancelUser?.addEventListener('click', () => { userModal.style.display = 'none'; });
  userModal?.addEventListener('click', (e) => { if (e.target === userModal) userModal.style.display = 'none'; });

  btnSaveUser?.addEventListener('click', async () => {
    const user_id = userFormId.value.trim();
    const badge_number = userFormBadge.value.trim();
    const name = userFormName.value.trim();
    const dept_id = userFormDept.value ? parseInt(userFormDept.value, 10) : null;
    const gender = userFormGender.value || null;
    const schedule_id = userFormSchedule && userFormSchedule.value ? parseInt(userFormSchedule.value, 10) : null;

    if (!user_id || !name) {
      showToast('User ID and Full Name are required', 'error');
      return;
    }

    try {
      const url = userEditId ? `/api/employees/${userEditId}` : '/api/employees';
      const method = userEditId ? 'PUT' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: parseInt(user_id, 10), badge_number, name, dept_id, gender, schedule_id })
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to save staff member');
      }
      showToast(userEditId ? 'Staff member updated' : 'Staff member created', 'success');
      userModal.style.display = 'none';
      loadUsersAdmin();
      loadEmployeesForSelects();
      loadShifts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  useradminSearchInput?.addEventListener('input', () => {
    clearTimeout(window.userAdminTimeout);
    window.userAdminTimeout = setTimeout(loadUsersAdmin, 300);
  });
  useradminDeptFilter?.addEventListener('change', loadUsersAdmin);

  // ─── 20. EMPLOYEE AUDIT DETAILS MODAL ──────────────────────────────────────
  const empModal = document.getElementById('employee-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const modalEmpAvatar = document.getElementById('modal-emp-avatar');
  const modalEmpName = document.getElementById('modal-emp-name');
  const modalEmpDetails = document.getElementById('modal-emp-details');
  const modalSummaryTbody = document.getElementById('modal-summary-tbody');
  const modalPunchesTbody = document.getElementById('modal-punches-tbody');
  const modalTabs = document.querySelectorAll('.modal-tab');

  async function openEmployeeModal(userId) {
    empModal.style.display = 'flex';
    modalEmpAvatar.textContent = '--';
    modalEmpName.textContent = 'Loading...';
    modalEmpDetails.textContent = 'Fetching profile...';
    modalSummaryTbody.innerHTML = '<tr><td colspan="5">Loading history...</td></tr>';
    modalPunchesTbody.innerHTML = '<tr><td colspan="3">Loading raw punches...</td></tr>';

    try {
      const res = await apiFetch(`/api/employees/${userId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const emp = data.employee || data;
      const dailySummary = data.dailySummary || data.dailyAttendance || [];
      const rawPunches = data.rawPunches || data.punches || [];

      modalEmpAvatar.textContent = (emp.name || '?').charAt(0).toUpperCase();
      modalEmpName.textContent = emp.name || `Employee ${userId}`;
      modalEmpDetails.textContent = `Badge #${emp.badge_number || emp.user_id || userId} • ${emp.dept_name || 'General'}`;

      if (!dailySummary.length) {
        modalSummaryTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No paired shift summary available</td></tr>';
      } else {
        modalSummaryTbody.innerHTML = dailySummary.map(d => {
          const hours = d.hours_worked !== undefined && d.hours_worked !== null 
            ? d.hours_worked 
            : (d.total_hours !== undefined && d.total_hours !== null ? d.total_hours : null);
          return `
            <tr>
              <td><strong>${d.date}</strong></td>
              <td class="font-mono">${formatTime(d.first_in)}</td>
              <td class="font-mono">${d.last_out ? (formatTime(d.last_out) + (d.is_auto_out ? ' <span style="font-size:0.7rem; padding:1px 6px; border-radius:4px; background:rgba(245,158,11,0.15); color:var(--accent-amber); font-weight:600; border:1px solid rgba(245,158,11,0.3);" title="Auto-completed to shift end (no extra time)">Auto-End</span>' : '')) : '—'}</td>
              <td>${d.punch_count}</td>
              <td><strong style="color:var(--accent-cyan);">${hours !== null ? hours + 'h' : '--'}</strong></td>
            </tr>
          `;
        }).join('');
      }

      if (!rawPunches.length) {
        modalPunchesTbody.innerHTML = '<tr><td colspan="3" class="table-empty">No punch activity recorded</td></tr>';
      } else {
        modalPunchesTbody.innerHTML = rawPunches.map(p => {
          const normType = (p.normalized_type || (p.check_type === 'O' ? 'out' : 'in')).toLowerCase();
          return `
            <tr>
              <td class="font-mono">${formatTime(p.check_time)}</td>
              <td><span class="status-pill status-${normType}">${normType.toUpperCase()}</span></td>
              <td class="font-mono" style="color:var(--text-muted);">${escapeHtml(p.sn || p.sensor_id || '—')}</td>
            </tr>
          `;
        }).join('');
      }
    } catch (e) {
      modalEmpDetails.textContent = 'Error loading employee details';
    }
  }

  btnCloseModal?.addEventListener('click', () => { empModal.style.display = 'none'; });
  empModal?.addEventListener('click', e => { if (e.target === empModal) empModal.style.display = 'none'; });

  modalTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modalTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const subtab = tab.dataset.subtab;
      document.getElementById('modal-subview-summary').style.display = subtab === 'summary' ? 'block' : 'none';
      document.getElementById('modal-subview-punches').style.display = subtab === 'punches' ? 'block' : 'none';
    });
  });

  // ─── 21. SHARED DELETE CONFIRMATION MODAL ─────────────────────────────────
  function openDeleteConfirm(title, messageHtml, onConfirm) {
    confirmDeleteTitle.textContent = title;
    confirmDeleteMessage.innerHTML = messageHtml;
    deletePendingFn = onConfirm;
    confirmDeleteModal.style.display = 'flex';
  }

  function closeDeleteConfirm() {
    confirmDeleteModal.style.display = 'none';
    deletePendingFn = null;
  }

  document.getElementById('btn-close-confirm')?.addEventListener('click', closeDeleteConfirm);
  document.getElementById('btn-cancel-delete')?.addEventListener('click', closeDeleteConfirm);
  confirmDeleteModal?.addEventListener('click', e => { if (e.target === confirmDeleteModal) closeDeleteConfirm(); });
  document.getElementById('btn-confirm-delete')?.addEventListener('click', async () => {
    if (deletePendingFn) {
      const fn = deletePendingFn;
      closeDeleteConfirm();
      await fn();
    }
  });

  // ─── 22. UTILITIES ────────────────────────────────────────────────────────
  function formatTime(isoStr) {
    if (!isoStr) return '--';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour12: false });
    } catch (e) {
      return isoStr;
    }
  }

  function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─── 23. BOOTSTRAPPING ────────────────────────────────────────────────────
  async function bootstrapApp() {
    await loadDepartments();
    await loadEmployeesForSelects();
    await loadLeaveTypes();
    checkBridgeStatus();
    loadLiveBoard();
  }

  // Check auth immediately on load
  checkAuth().then(isAuth => {
    if (isAuth) {
      bootstrapApp();
    }
  });

  // Periodic status poll (every 30s)
  setInterval(() => {
    if (authToken) checkBridgeStatus();
  }, 30000);
});

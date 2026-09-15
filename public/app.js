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
    'smart-reports': { title: 'Smart Reports Hub',    subtitle: 'Late arrivals, absentees, overtime & device metrics with CSV' },
    reports:        { title: 'Paired Shifts Report',  subtitle: 'Calculated first-in/last-out paired durations and export' },
    devices:        { title: 'Clock Devices',         subtitle: 'Manage biometric readers (ZKTeco/standalone readers)' },
    'users-admin':  { title: 'Personnel Admin',       subtitle: 'Create, update and delete staff members in database' },
    'app-users':    { title: 'System User Accounts',  subtitle: 'Configure platform access logins and roles (Admin/Viewer)' }
  };

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
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
    if (target === 'smart-reports') runSmartReport();
    if (target === 'devices')      loadDevices();
    if (target === 'users-admin')  loadUsersAdmin();
    if (target === 'app-users')    loadAppUsers();
  }

  // ─── 5. STATUS & ACCESS BRIDGE ─────────────────────────────────────────────
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
          bridgeLastSyncEl.textContent = 'Bridge connected';
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
    bridgeLastSyncEl.textContent = 'Syncing data...';
    showToast('Triggering sync from Access to MySQL...', 'info');

    try {
      const res = await apiFetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(`Sync complete! ${data.result.punchesCount.toLocaleString()} punches verified.`, 'success');
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
            <div class="card-dept">${escapeHtml(emp.dept_name || 'General')}</div>
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

  // ─── 8. MODULE: SMART REPORTS ──────────────────────────────────────────────
  const smartReportSubtabs = document.querySelectorAll('#view-smart-reports .subtab-btn');
  const smartFromDate = document.getElementById('smart-from-date');
  const smartToDate = document.getElementById('smart-to-date');
  const smartDeptFilter = document.getElementById('smart-dept-filter');
  const smartThresholdContainer = document.getElementById('smart-threshold-container');
  const smartThresholdInput = document.getElementById('smart-threshold-input');
  const smartThresholdLabel = document.getElementById('smart-threshold-label');
  const smartToContainer = document.getElementById('smart-to-container');
  const btnRunSmartReport = document.getElementById('btn-run-smart-report');
  const btnExportSmartCsv = document.getElementById('btn-export-smart-csv');
  const smartReportThead = document.getElementById('smart-report-thead');
  const smartReportTbody = document.getElementById('smart-report-tbody');

  // Default dates
  if (smartFromDate && !smartFromDate.value) {
    smartFromDate.value = '2026-09-01';
  }
  if (smartToDate && !smartToDate.value) {
    smartToDate.value = '2026-09-15';
  }

  smartReportSubtabs.forEach(btn => {
    btn.addEventListener('click', () => {
      smartReportSubtabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSmartReport = btn.dataset.reportType;

      // Adjust UI for specific report requirements
      if (activeSmartReport === 'late') {
        smartThresholdContainer.style.display = 'flex';
        smartThresholdLabel.textContent = 'Late Threshold:';
        smartThresholdInput.value = '08:15';
        smartToContainer.style.display = 'flex';
      } else if (activeSmartReport === 'overtime') {
        smartThresholdContainer.style.display = 'flex';
        smartThresholdLabel.textContent = 'Overtime Threshold:';
        smartThresholdInput.value = '17:00';
        smartToContainer.style.display = 'flex';
      } else if (activeSmartReport === 'absent') {
        smartThresholdContainer.style.display = 'none';
        smartToContainer.style.display = 'none'; // single date
      } else {
        smartThresholdContainer.style.display = 'none';
        smartToContainer.style.display = 'flex';
      }

      runSmartReport();
    });
  });

  async function runSmartReport() {
    if (!smartReportTbody) return;
    const from = smartFromDate.value;
    const to = smartToDate.value;
    const deptId = smartDeptFilter.value;
    const threshold = smartThresholdInput.value;

    smartReportTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Running report query...</td></tr>';

    try {
      if (activeSmartReport === 'summary') {
        const params = new URLSearchParams({ from, to });
        if (deptId) params.append('deptId', deptId);
        const res = await apiFetch(`/api/reports/attendance-summary?${params.toString()}`);
        const rows = await res.json();

        smartReportThead.innerHTML = `
          <tr>
            <th>Badge #</th>
            <th>Employee</th>
            <th>Department</th>
            <th>Days Present</th>
            <th>Total Punches</th>
            <th>Avg First In</th>
            <th>Avg Last Out</th>
          </tr>
        `;

        if (!rows.length) {
          smartReportTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No records found for period</td></tr>';
          return;
        }

        smartReportTbody.innerHTML = rows.map(r => `
          <tr>
            <td><span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span></td>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td>${escapeHtml(r.dept_name || 'General')}</td>
            <td><span class="punch-count-pill">${r.days_present} days</span></td>
            <td>${r.total_punches}</td>
            <td class="font-mono">${r.avg_first_in || '--'}</td>
            <td class="font-mono">${r.avg_last_out || '--'}</td>
          </tr>
        `).join('');

      } else if (activeSmartReport === 'late') {
        const params = new URLSearchParams({ from, to, threshold });
        if (deptId) params.append('deptId', deptId);
        const res = await apiFetch(`/api/reports/late-arrivals?${params.toString()}`);
        const rows = await res.json();

        smartReportThead.innerHTML = `
          <tr>
            <th>Date</th>
            <th>Badge #</th>
            <th>Employee</th>
            <th>Department</th>
            <th>Check In Time</th>
            <th>Threshold</th>
            <th>Minutes Late</th>
          </tr>
        `;

        if (!rows.length) {
          smartReportTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No late arrivals detected!</td></tr>';
          return;
        }

        smartReportTbody.innerHTML = rows.map(r => `
          <tr>
            <td><strong>${r.date}</strong></td>
            <td><span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span></td>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.dept_name || 'General')}</td>
            <td class="font-mono" style="color:var(--accent-amber);">${r.check_in_time}</td>
            <td class="font-mono" style="color:var(--text-muted);">${threshold}</td>
            <td><span class="status-pill status-out">${r.minutes_late}</span></td>
          </tr>
        `).join('');

      } else if (activeSmartReport === 'absent') {
        const params = new URLSearchParams({ date: from });
        if (deptId) params.append('dept_id', deptId);
        const res = await apiFetch(`/api/reports/absent?${params.toString()}`);
        const data = await res.json();
        const rows = data.employees || [];

        smartReportThead.innerHTML = `
          <tr>
            <th>Badge #</th>
            <th>Employee</th>
            <th>Department</th>
            <th>Target Date</th>
            <th>Last Known Punch</th>
            <th>Status</th>
          </tr>
        `;

        if (!rows.length) {
          smartReportTbody.innerHTML = '<tr><td colspan="6" class="table-empty">No absentees recorded! All rostered staff present.</td></tr>';
          return;
        }

        smartReportTbody.innerHTML = rows.map(r => `
          <tr>
            <td><span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span></td>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td>${escapeHtml(r.dept_name || 'General')}</td>
            <td>${from}</td>
            <td style="color:var(--text-muted); font-size:0.85rem">${r.last_known_punch ? formatTime(r.last_known_punch) : 'Never recorded'}</td>
            <td><span class="status-pill status-absent">ABSENT</span></td>
          </tr>
        `).join('');

      } else if (activeSmartReport === 'overtime') {
        const params = new URLSearchParams({ from, to, threshold });
        if (deptId) params.append('deptId', deptId);
        const res = await apiFetch(`/api/reports/overtime?${params.toString()}`);
        const rows = await res.json();

        smartReportThead.innerHTML = `
          <tr>
            <th>Date</th>
            <th>Badge #</th>
            <th>Employee</th>
            <th>Department</th>
            <th>Last Punch Out</th>
            <th>Overtime Duration</th>
          </tr>
        `;

        if (!rows.length) {
          smartReportTbody.innerHTML = '<tr><td colspan="6" class="table-empty">No overtime punches recorded past threshold</td></tr>';
          return;
        }

        smartReportTbody.innerHTML = rows.map(r => `
          <tr>
            <td><strong>${r.date}</strong></td>
            <td><span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span></td>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.dept_name || 'General')}</td>
            <td class="font-mono" style="color:var(--accent-cyan)">${r.last_punch_out}</td>
            <td><span class="status-pill status-in">+${r.overtime_duration}</span></td>
          </tr>
        `).join('');

      } else if (activeSmartReport === 'device') {
        const params = new URLSearchParams({ from, to });
        const res = await apiFetch(`/api/reports/by-device?${params.toString()}`);
        const rows = await res.json();

        smartReportThead.innerHTML = `
          <tr>
            <th>Device Serial (SN)</th>
            <th>Device Name / Alias</th>
            <th>IP Address</th>
            <th>Location</th>
            <th>Status</th>
            <th>Punches in Period</th>
            <th>Unique Personnel</th>
          </tr>
        `;

        if (!rows.length) {
          smartReportTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No device punch logs found</td></tr>';
          return;
        }

        smartReportTbody.innerHTML = rows.map(r => `
          <tr>
            <td><span class="badge-number font-mono">${escapeHtml(r.sn)}</span></td>
            <td><strong>${escapeHtml(r.alias || '—')}</strong></td>
            <td class="font-mono">${escapeHtml(r.ip_address || '—')}</td>
            <td style="color:var(--text-secondary)">${escapeHtml(r.location || '—')}</td>
            <td><span class="device-status-badge ${r.status || 'active'}">${r.status || 'active'}</span></td>
            <td><span class="punch-count-pill">${Number(r.total_punches).toLocaleString()}</span></td>
            <td><strong>${r.unique_users}</strong></td>
          </tr>
        `).join('');
      }
    } catch (e) {
      smartReportTbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--accent-rose)">Error generating report: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  btnRunSmartReport?.addEventListener('click', runSmartReport);

  // CSV Export handler (using token param)
  btnExportSmartCsv?.addEventListener('click', () => {
    const from = smartFromDate.value;
    const to = smartToDate.value;
    const deptId = smartDeptFilter.value;
    const params = new URLSearchParams({ type: activeSmartReport, from, to, _token: authToken });
    if (deptId) params.append('deptId', deptId);
    window.location.href = `/api/reports/export/csv?${params.toString()}`;
  });

  // ─── 9. MODULE: SHIFTS & SCHEDULES ─────────────────────────────────────────
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

      const shifts = await shiftsRes.json();
      const schedules = await schedRes.json();

      if (shifts.length === 0) {
        shiftsGrid.innerHTML = '<div class="table-empty">No shift classes found</div>';
      } else {
        shiftsGrid.innerHTML = shifts.map(s => {
          const shiftName = s.name || s.SchName || ('Shift #' + s.id);
          const startTime = s.start_time || (s.StartTime ? String(s.StartTime).substring(11, 16) : '08:00');
          const endTime = s.end_time || (s.EndTime ? String(s.EndTime).substring(11, 16) : '17:00');
          const checkIn1 = s.check_in_time1 || (s.CheckInTime1 ? String(s.CheckInTime1).substring(11, 16) : '--');
          const checkIn2 = s.check_in_time2 || (s.CheckInTime2 ? String(s.CheckInTime2).substring(11, 16) : '--');
          const checkOut1 = s.check_out_time1 || (s.CheckOutTime1 ? String(s.CheckOutTime1).substring(11, 16) : '--');
          const checkOut2 = s.check_out_time2 || (s.CheckOutTime2 ? String(s.CheckOutTime2).substring(11, 16) : '--');
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
            </div>
          `;
        }).join('');
      }

      if (schedules.length === 0) {
        schedulesGrid.innerHTML = '<div class="table-empty">No active schedules configured</div>';
      } else {
        schedulesGrid.innerHTML = schedules.map(sc => `
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
            <div style="margin-top: 8px;">
              <small style="color:var(--text-muted);">Active Personnel Rotation (${sc.active_user_count || 0} employees assigned)</small>
            </div>
          </div>
        `).join('');
      }
    } catch (e) {
      shiftsGrid.innerHTML = `<div class="table-empty" style="color:var(--accent-rose)">Error loading shifts: ${escapeHtml(e.message)}</div>`;
    }
  }

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

  // ─── 17. MODULE: PAIRED SHIFTS REPORT ─────────────────────────────────────
  const reportFrom = document.getElementById('report-from');
  const reportTo = document.getElementById('report-to');
  const reportDept = document.getElementById('report-dept');
  const btnGenerateReport = document.getElementById('btn-generate-report');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const reportsTbody = document.getElementById('reports-tbody');

  btnGenerateReport?.addEventListener('click', async () => {
    const from = reportFrom.value;
    const to = reportTo.value;
    if (!from || !to) {
      showToast('Please select both From and To dates', 'error');
      return;
    }

    reportsTbody.innerHTML = '<tr><td colspan="8" class="table-empty">Generating report...</td></tr>';
    btnExportCsv.disabled = true;

    try {
      const params = new URLSearchParams({ from, to });
      if (reportDept.value) params.append('deptId', reportDept.value);

      const res = await apiFetch(`/api/reports/daily?${params.toString()}`);
      reportData = await res.json();

      if (!reportData.length) {
        reportsTbody.innerHTML = '<tr><td colspan="8" class="table-empty">No records found for period</td></tr>';
        return;
      }

      btnExportCsv.disabled = false;
      reportsTbody.innerHTML = reportData.map(r => `
        <tr>
          <td><strong>${r.date}</strong></td>
          <td><span class="badge-number font-mono">${escapeHtml(r.badge_number || r.user_id)}</span></td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.dept_name || 'General')}</td>
          <td class="font-mono">${formatTime(r.first_in)}</td>
          <td class="font-mono">${formatTime(r.last_out)}</td>
          <td>${r.punch_count}</td>
          <td><strong style="color:var(--accent-cyan);">${r.total_hours !== null ? r.total_hours + ' hrs' : '--'}</strong></td>
        </tr>
      `).join('');
    } catch (e) {
      reportsTbody.innerHTML = '<tr><td colspan="8" class="table-empty" style="color:var(--accent-rose)">Error generating report</td></tr>';
    }
  });

  btnExportCsv?.addEventListener('click', () => {
    if (!reportData || !reportData.length) return;
    const headers = ['Date', 'Badge #', 'Employee Name', 'Department', 'First In', 'Last Out', 'Total Punches', 'Total Hours'];
    const csvRows = [headers.join(',')];

    for (const r of reportData) {
      const row = [
        r.date,
        `"${r.badge_number || r.user_id}"`,
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${(r.dept_name || '').replace(/"/g, '""')}"`,
        r.first_in ? `"${new Date(r.first_in).toLocaleTimeString()}"` : '""',
        r.last_out ? `"${new Date(r.last_out).toLocaleTimeString()}"` : '""',
        r.punch_count,
        r.total_hours !== null ? r.total_hours : '""'
      ];
      csvRows.push(row.join(','));
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Attendance_Report_${reportFrom.value}_to_${reportTo.value}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ─── 18. MODULE: CLOCK DEVICES ────────────────────────────────────────────
  const devicesTbody = document.getElementById('devices-tbody');
  const deviceSearchInput = document.getElementById('device-search-input');
  const deviceModal = document.getElementById('device-modal');
  const deviceModalTitle = document.getElementById('device-modal-title');
  const btnCloseDeviceModal = document.getElementById('btn-close-device-modal');
  const btnCancelDevice = document.getElementById('btn-cancel-device');
  const btnSaveDevice = document.getElementById('btn-save-device');
  const btnOpenDeviceModal = document.getElementById('btn-open-device-modal');
  const btnImportDevices = document.getElementById('btn-import-devices');
  const deviceFormSn = document.getElementById('device-form-sn');
  const deviceFormAlias = document.getElementById('device-form-alias');
  const deviceFormIp = document.getElementById('device-form-ip');
  const deviceFormModel = document.getElementById('device-form-model');
  const deviceFormLocation = document.getElementById('device-form-location');
  const deviceFormStatus = document.getElementById('device-form-status');

  async function loadDevices() {
    if (!devicesTbody) return;
    devicesTbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading devices...</td></tr>';
    try {
      const res = await apiFetch('/api/devices');
      allDevices = await res.json();
      renderDevices(allDevices);
    } catch (e) {
      devicesTbody.innerHTML = `<tr><td colspan="8" class="table-empty">Error loading devices: ${escapeHtml(e.message)}</td></tr>`;
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
      devicesTbody.innerHTML = '<tr><td colspan="8" class="table-empty">No devices found</td></tr>';
      return;
    }

    devicesTbody.innerHTML = filtered.map(d => `
      <tr>
        <td><span class="badge-number font-mono">${escapeHtml(d.sn)}</span></td>
        <td><strong>${escapeHtml(d.alias || '—')}</strong></td>
        <td><span class="font-mono" style="color:var(--accent-cyan);">${escapeHtml(d.ip_address || '—')}</span></td>
        <td style="color:var(--text-secondary);">${escapeHtml(d.location || '—')}</td>
        <td style="color:var(--text-muted); font-size:0.82rem;">${escapeHtml(d.model || '—')}</td>
        <td><span class="device-status-badge ${d.status}">${d.status === 'active' ? '● Active' : '○ Inactive'}</span></td>
        <td><span class="punch-count-pill">${Number(d.punch_count).toLocaleString()}</span></td>
        <td>
          <div class="table-actions">
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
  const btnOpenUserModal = document.getElementById('btn-open-user-modal');
  const userFormId = document.getElementById('user-form-id');
  const userFormBadge = document.getElementById('user-form-badge');
  const userFormName = document.getElementById('user-form-name');
  const userFormDept = document.getElementById('user-form-dept');
  const userFormGender = document.getElementById('user-form-gender');

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
        const u = await res.json();
        userFormId.value = u.user_id;
        userFormBadge.value = u.badge_number || '';
        userFormName.value = u.name || '';
        userFormDept.value = u.dept_id || '';
        userFormGender.value = u.gender || '';
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

  btnSaveUser?.addEventListener('click', async () => {
    const user_id = userFormId.value.trim();
    const badge_number = userFormBadge.value.trim();
    const name = userFormName.value.trim();
    const dept_id = userFormDept.value ? parseInt(userFormDept.value, 10) : null;
    const gender = userFormGender.value || null;

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
        body: JSON.stringify({ user_id: parseInt(user_id, 10), badge_number, name, dept_id, gender })
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to save staff member');
      }
      showToast(userEditId ? 'Personnel updated' : 'Personnel added', 'success');
      userModal.style.display = 'none';
      loadUsersAdmin();
      loadEmployeesForSelects();
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
      const data = await res.json();
      modalEmpAvatar.textContent = (data.name || '?').charAt(0);
      modalEmpName.textContent = data.name;
      modalEmpDetails.textContent = `Badge #${data.badge_number || data.user_id} • ${data.dept_name || 'General'}`;

      if (!data.dailySummary.length) {
        modalSummaryTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No paired shift summary available</td></tr>';
      } else {
        modalSummaryTbody.innerHTML = data.dailySummary.map(d => `
          <tr>
            <td><strong>${d.date}</strong></td>
            <td class="font-mono">${formatTime(d.first_in)}</td>
            <td class="font-mono">${formatTime(d.last_out)}</td>
            <td>${d.punch_count}</td>
            <td><strong style="color:var(--accent-cyan);">${d.hours_worked !== null ? d.hours_worked + 'h' : '--'}</strong></td>
          </tr>
        `).join('');
      }

      if (!data.rawPunches.length) {
        modalPunchesTbody.innerHTML = '<tr><td colspan="3" class="table-empty">No punch activity recorded</td></tr>';
      } else {
        modalPunchesTbody.innerHTML = data.rawPunches.map(p => `
          <tr>
            <td class="font-mono">${formatTime(p.check_time)}</td>
            <td><span class="status-pill status-${p.normalized_type}">${p.normalized_type.toUpperCase()}</span></td>
            <td class="font-mono" style="color:var(--text-muted);">${escapeHtml(p.sn || '—')}</td>
          </tr>
        `).join('');
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

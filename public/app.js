/**
 * TimePulse Frontend Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let currentTab = 'dashboard';
  let departments = [];
  let punchPage = 1;
  const punchLimit = 25;
  let reportData = [];

  // Admin module state
  let deviceEditId = null;       // null = add mode, number = edit mode
  let userEditId = null;         // null = add mode, number = edit mode
  let deletePendingFn = null;    // function to call when delete confirmed
  let allDevices = [];           // cached for client-side search filter
  let allUsersAdmin = [];        // cached for client-side search filter

  // DOM Elements
  const liveClockEl = document.getElementById('live-clock');
  const bridgeIndicatorEl = document.getElementById('bridge-indicator');
  const bridgeLastSyncEl = document.getElementById('bridge-last-sync');
  const btnTriggerSync = document.getElementById('btn-trigger-sync');

  // Tab buttons
  const navButtons = document.querySelectorAll('.nav-item');
  const tabViews = document.querySelectorAll('.tab-view');
  const pageTitleEl = document.getElementById('page-title');
  const pageSubtitleEl = document.getElementById('page-subtitle');

  // Dashboard elements
  const kpiTotalEmployees = document.getElementById('kpi-total-employees');
  const kpiActiveToday = document.getElementById('kpi-active-today');
  const kpiPunchesToday = document.getElementById('kpi-punches-today');
  const kpiTotalPunches = document.getElementById('kpi-total-punches');
  const recentPunchesStream = document.getElementById('recent-punches-stream');
  const deptBreakdownList = document.getElementById('dept-breakdown-list');

  // Personnel elements
  const empSearchInput = document.getElementById('emp-search-input');
  const empDeptFilter = document.getElementById('emp-dept-filter');
  const employeesGrid = document.getElementById('employees-grid');

  // Punches elements
  const punchDateFrom = document.getElementById('punch-date-from');
  const punchDateTo = document.getElementById('punch-date-to');
  const punchTypeFilter = document.getElementById('punch-type-filter');
  const btnApplyPunchFilters = document.getElementById('btn-apply-punch-filters');
  const btnResetPunchFilters = document.getElementById('btn-reset-punch-filters');
  const punchesTbody = document.getElementById('punches-tbody');
  const punchPageInfo = document.getElementById('punch-page-info');
  const btnPunchPrev = document.getElementById('btn-punch-prev');
  const btnPunchNext = document.getElementById('btn-punch-next');

  // Reports elements
  const reportFrom = document.getElementById('report-from');
  const reportTo = document.getElementById('report-to');
  const reportDept = document.getElementById('report-dept');
  const btnGenerateReport = document.getElementById('btn-generate-report');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const reportsTbody = document.getElementById('reports-tbody');

  // Modal elements (employee detail)
  const empModal = document.getElementById('employee-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const modalEmpAvatar = document.getElementById('modal-emp-avatar');
  const modalEmpName = document.getElementById('modal-emp-name');
  const modalEmpDetails = document.getElementById('modal-emp-details');
  const modalSummaryTbody = document.getElementById('modal-summary-tbody');
  const modalPunchesTbody = document.getElementById('modal-punches-tbody');
  const modalTabs = document.querySelectorAll('.modal-tab');

  // Device admin elements
  const devicesTbody = document.getElementById('devices-tbody');
  const deviceSearchInput = document.getElementById('device-search-input');
  const deviceModal = document.getElementById('device-modal');
  const deviceModalTitle = document.getElementById('device-modal-title');
  const deviceFormSn = document.getElementById('device-form-sn');
  const deviceFormAlias = document.getElementById('device-form-alias');
  const deviceFormIp = document.getElementById('device-form-ip');
  const deviceFormModel = document.getElementById('device-form-model');
  const deviceFormLocation = document.getElementById('device-form-location');
  const deviceFormStatus = document.getElementById('device-form-status');

  // User admin elements
  const usersAdminTbody = document.getElementById('users-admin-tbody');
  const useradminSearchInput = document.getElementById('useradmin-search-input');
  const useradminDeptFilter = document.getElementById('useradmin-dept-filter');
  const userModal = document.getElementById('user-modal');
  const userModalTitle = document.getElementById('user-modal-title');
  const userFormId = document.getElementById('user-form-id');
  const userFormBadge = document.getElementById('user-form-badge');
  const userFormName = document.getElementById('user-form-name');
  const userFormDept = document.getElementById('user-form-dept');
  const userFormGender = document.getElementById('user-form-gender');

  // Shared delete confirm modal
  const confirmDeleteModal = document.getElementById('confirm-delete-modal');
  const confirmDeleteTitle = document.getElementById('confirm-delete-title');
  const confirmDeleteMessage = document.getElementById('confirm-delete-message');

  // 1. Live Clock
  function updateLiveClock() {
    const now = new Date();
    liveClockEl.textContent = now.toLocaleTimeString([], { hour12: false });
  }
  setInterval(updateLiveClock, 1000);
  updateLiveClock();

  // 2. Navigation Switching
  const titles = {
    dashboard:    { title: 'Attendance Dashboard',    subtitle: 'Real-time personnel clock-in/out overview' },
    employees:    { title: 'Personnel Directory',     subtitle: 'Search and inspect personnel attendance profiles' },
    punches:      { title: 'Punch Activity Log',      subtitle: 'Chronological raw audit trail of biometric logs' },
    reports:      { title: 'Attendance Reports',      subtitle: 'Daily paired shifts, hours worked, and CSV export' },
    devices:      { title: 'Clock Devices',           subtitle: 'Manage biometric clock readers — add, edit, remove devices' },
    'users-admin': { title: 'Users Administration', subtitle: 'Create, edit and remove personnel from the system' },
  };

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      navButtons.forEach(b => b.classList.remove('active'));
      tabViews.forEach(v => v.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`view-${target}`).classList.add('active');

      pageTitleEl.textContent = titles[target].title;
      pageSubtitleEl.textContent = titles[target].subtitle;
      currentTab = target;

      if (target === 'dashboard')    loadDashboard();
      if (target === 'employees')    loadEmployees();
      if (target === 'punches')      loadPunches();
      if (target === 'devices')      loadDevices();
      if (target === 'users-admin')  loadUsersAdmin();
    });
  });

  // 3. Toast Notifications
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

  // 4. Status and Bridge Check
  async function checkBridgeStatus() {
    try {
      const res = await fetch('/api/status');
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
          bridgeLastSyncEl.textContent = 'No sync recorded yet';
        }

        if (data.stats) {
          kpiTotalEmployees.textContent = data.stats.employeeCount.toLocaleString();
          kpiTotalPunches.textContent = data.stats.punchCount.toLocaleString();
        }
      }
    } catch (e) {
      bridgeIndicatorEl.className = 'status-indicator error';
      bridgeLastSyncEl.textContent = 'Database offline';
    }
  }

  // Manual Trigger Sync
  btnTriggerSync.addEventListener('click', async () => {
    btnTriggerSync.classList.add('spinning');
    bridgeIndicatorEl.className = 'status-indicator syncing';
    bridgeLastSyncEl.textContent = 'Syncing data...';
    showToast('Starting sync from Access database to MySQL...', 'info');

    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(`Sync complete! ${data.result.punchesCount.toLocaleString()} punches verified.`, 'success');
        checkBridgeStatus();
        if (currentTab === 'dashboard') loadDashboard();
        if (currentTab === 'employees') loadEmployees();
        if (currentTab === 'punches') loadPunches();
      } else {
        showToast(`Sync error: ${data.error || 'Unknown'}`, 'error');
      }
    } catch (e) {
      showToast('Sync request failed to connect to server', 'error');
    } finally {
      btnTriggerSync.classList.remove('spinning');
    }
  });

  // 5. Load Departments (also populates admin selects)
  async function loadDepartments() {
    try {
      const res = await fetch('/api/departments');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        departments = data;
        const options = departments.map(d => `<option value="${d.dept_id}">${escapeHtml(d.dept_name)}</option>`).join('');
        empDeptFilter.innerHTML = '<option value="">All Departments</option>' + options;
        reportDept.innerHTML = '<option value="">All Departments</option>' + options;
        useradminDeptFilter.innerHTML = '<option value="">All Departments</option>' + options;
        userFormDept.innerHTML = '<option value="">No Department</option>' + options;
      }
    } catch (e) {
      console.warn('Departments not available yet (database may need initialization):', e.message);
    }
  }

  // 6. Load Dashboard
  async function loadDashboard() {
    try {
      const res = await fetch('/api/dashboard');
      const data = await res.json();

      if (data.summary) {
        kpiTotalEmployees.textContent = data.summary.totalEmployees.toLocaleString();
        kpiActiveToday.textContent = (data.summary.activeToday || 0).toLocaleString();
        kpiPunchesToday.textContent = (data.summary.punchesToday || 0).toLocaleString();
      }

      // Recent Punches
      if (data.recentPunches && data.recentPunches.length > 0) {
        recentPunchesStream.innerHTML = data.recentPunches.map(p => {
          const d = new Date(p.check_time);
          const timeStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const isCheckIn = p.normalized_type === 'in';
          return `
            <div class="stream-item">
              <div class="stream-emp">
                <div class="avatar">${(p.employee_name || 'U').charAt(0)}</div>
                <div>
                  <div class="emp-name">${escapeHtml(p.employee_name || 'Unknown')}</div>
                  <div class="emp-dept">${escapeHtml(p.dept_name || 'General')}</div>
                </div>
              </div>
              <div class="stream-meta">
                <span class="punch-badge ${isCheckIn ? 'in' : 'out'}">${isCheckIn ? 'Clock In' : 'Clock Out'}</span>
                <span class="punch-time">${timeStr}</span>
              </div>
            </div>
          `;
        }).join('');
      } else {
        recentPunchesStream.innerHTML = '<div class="loading-spinner">No recent punches recorded</div>';
      }

      // Dept Breakdown
      if (data.deptBreakdown && data.deptBreakdown.length > 0) {
        deptBreakdownList.innerHTML = data.deptBreakdown.map(d => `
          <div class="dept-row">
            <span class="dept-title">${escapeHtml(d.dept_name)}</span>
            <span class="dept-count">${d.present_count} present</span>
          </div>
        `).join('');
      } else {
        deptBreakdownList.innerHTML = '<div class="loading-spinner">No department attendance today</div>';
      }
    } catch (e) {
      console.error('Failed to load dashboard', e);
    }
  }

  // 7. Load Personnel Directory
  async function loadEmployees() {
    employeesGrid.innerHTML = '<div class="loading-spinner">Loading personnel...</div>';
    try {
      const search = empSearchInput.value.trim();
      const deptId = empDeptFilter.value;
      const params = new URLSearchParams();
      if (search) params.append('search', search);
      if (deptId) params.append('dept_id', deptId);

      const res = await fetch(`/api/employees?${params.toString()}`);
      const employees = await res.json();

      if (employees.length === 0) {
        employeesGrid.innerHTML = '<div class="loading-spinner">No personnel found matching criteria</div>';
        return;
      }

      employeesGrid.innerHTML = employees.map(emp => {
        const lastPunch = emp.last_punch_time 
          ? new Date(emp.last_punch_time).toLocaleDateString() + ' ' + new Date(emp.last_punch_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'Never';
        const isCurrentlyIn = emp.last_punch_type === 'in';
        const badgeClass = emp.last_punch_type ? (isCurrentlyIn ? 'in' : 'out') : '';
        const badgeLabel = emp.last_punch_type ? (isCurrentlyIn ? 'Clocked In' : 'Clocked Out') : 'No Punch';

        return `
          <div class="employee-card" data-user-id="${emp.user_id}">
            <div class="emp-card-header">
              <div class="avatar">${emp.name.charAt(0)}</div>
              <div class="emp-card-details">
                <div class="emp-card-name">${escapeHtml(emp.name)}</div>
                <div class="emp-card-dept">${escapeHtml(emp.dept_name || 'General')}</div>
              </div>
            </div>
            <div class="emp-card-footer">
              <span class="badge-number">Badge #${escapeHtml(emp.badge_number || emp.user_id)}</span>
              ${badgeClass ? `<span class="punch-badge ${badgeClass}">${badgeLabel}</span>` : `<span class="badge-subtle">No punches</span>`}
            </div>
          </div>
        `;
      }).join('');

      // Attach click listeners to cards
      document.querySelectorAll('.employee-card').forEach(card => {
        card.addEventListener('click', () => openEmployeeModal(card.dataset.userId));
      });
    } catch (e) {
      employeesGrid.innerHTML = '<div class="loading-spinner">Error loading personnel</div>';
    }
  }

  // Employee search debounce
  let searchTimeout = null;
  empSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadEmployees, 300);
  });
  empDeptFilter.addEventListener('change', loadEmployees);

  // 8. Open Employee Modal
  async function openEmployeeModal(userId) {
    empModal.style.display = 'flex';
    modalSummaryTbody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading attendance...</td></tr>';
    modalPunchesTbody.innerHTML = '<tr><td colspan="3" class="table-empty">Loading records...</td></tr>';

    try {
      const res = await fetch(`/api/employees/${userId}`);
      const data = await res.json();
      const emp = data.employee;

      modalEmpAvatar.textContent = emp.name.charAt(0);
      modalEmpName.textContent = emp.name;
      modalEmpDetails.textContent = `Badge #${emp.badge_number || emp.user_id} • ${emp.dept_name || 'General'}`;

      // Daily Attendance
      if (data.dailyAttendance && data.dailyAttendance.length > 0) {
        modalSummaryTbody.innerHTML = data.dailyAttendance.map(day => `
          <tr>
            <td><strong>${day.date}</strong></td>
            <td>${formatTime(day.first_in)}</td>
            <td>${formatTime(day.last_out)}</td>
            <td>${day.punch_count}</td>
            <td><strong style="color: var(--accent-cyan)">${day.total_hours !== null ? day.total_hours + ' hrs' : '--'}</strong></td>
          </tr>
        `).join('');
      } else {
        modalSummaryTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No daily attendance recorded</td></tr>';
      }

      // Raw Punches
      if (data.punches && data.punches.length > 0) {
        modalPunchesTbody.innerHTML = data.punches.map(p => {
          const isIn = p.normalized_type === 'in';
          return `
            <tr>
              <td>${new Date(p.check_time).toLocaleString()}</td>
              <td><span class="punch-badge ${isIn ? 'in' : 'out'}">${isIn ? 'Clock In' : 'Clock Out'}</span></td>
              <td>${escapeHtml(p.sn || 'Device')}</td>
            </tr>
          `;
        }).join('');
      } else {
        modalPunchesTbody.innerHTML = '<tr><td colspan="3" class="table-empty">No raw punches recorded</td></tr>';
      }
    } catch (e) {
      modalSummaryTbody.innerHTML = '<tr><td colspan="5" class="table-empty">Error loading employee profile</td></tr>';
    }
  }

  btnCloseModal.addEventListener('click', () => { empModal.style.display = 'none'; });
  empModal.addEventListener('click', (e) => { if (e.target === empModal) empModal.style.display = 'none'; });

  modalTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modalTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const subtab = tab.dataset.subtab;
      document.getElementById('modal-subview-summary').style.display = subtab === 'summary' ? 'block' : 'none';
      document.getElementById('modal-subview-punches').style.display = subtab === 'punches' ? 'block' : 'none';
    });
  });

  // 9. Load Punches Log
  async function loadPunches() {
    punchesTbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading records...</td></tr>';
    const params = new URLSearchParams({
      page: punchPage,
      limit: punchLimit,
    });

    if (punchDateFrom.value) params.append('from', punchDateFrom.value);
    if (punchDateTo.value) params.append('to', punchDateTo.value);
    if (punchTypeFilter.value) params.append('type', punchTypeFilter.value);

    try {
      const res = await fetch(`/api/punches?${params.toString()}`);
      const result = await res.json();

      if (result.data.length === 0) {
        punchesTbody.innerHTML = '<tr><td colspan="6" class="table-empty">No punch records found</td></tr>';
        punchPageInfo.textContent = '0 records';
        btnPunchPrev.disabled = true;
        btnPunchNext.disabled = true;
        return;
      }

      punchesTbody.innerHTML = result.data.map(p => {
        const isIn = p.normalized_type === 'in';
        return `
          <tr>
            <td><strong>${new Date(p.check_time).toLocaleString()}</strong></td>
            <td><span class="badge-number">${escapeHtml(p.badge_number || p.user_id)}</span></td>
            <td>${escapeHtml(p.employee_name)}</td>
            <td>${escapeHtml(p.dept_name || 'General')}</td>
            <td><span class="punch-badge ${isIn ? 'in' : 'out'}">${isIn ? 'Clock In' : 'Clock Out'}</span></td>
            <td style="color: var(--text-muted); font-size: 0.8rem">${escapeHtml(p.sn || p.sensor_id || 'Reader')}</td>
          </tr>
        `;
      }).join('');

      punchPageInfo.textContent = `Page ${result.page} of ${result.totalPages} (${result.total.toLocaleString()} records)`;
      btnPunchPrev.disabled = result.page <= 1;
      btnPunchNext.disabled = result.page >= result.totalPages;
    } catch (e) {
      punchesTbody.innerHTML = '<tr><td colspan="6" class="table-empty">Error loading punches</td></tr>';
    }
  }

  btnApplyPunchFilters.addEventListener('click', () => { punchPage = 1; loadPunches(); });
  btnResetPunchFilters.addEventListener('click', () => {
    punchDateFrom.value = '';
    punchDateTo.value = '';
    punchTypeFilter.value = '';
    punchPage = 1;
    loadPunches();
  });
  btnPunchPrev.addEventListener('click', () => { if (punchPage > 1) { punchPage--; loadPunches(); } });
  btnPunchNext.addEventListener('click', () => { punchPage++; loadPunches(); });

  // 10. Attendance Reports
  btnGenerateReport.addEventListener('click', async () => {
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

      const res = await fetch(`/api/reports/daily?${params.toString()}`);
      reportData = await res.json();

      if (reportData.length === 0) {
        reportsTbody.innerHTML = '<tr><td colspan="8" class="table-empty">No attendance records found for selected period</td></tr>';
        return;
      }

      btnExportCsv.disabled = false;
      reportsTbody.innerHTML = reportData.map(r => `
        <tr>
          <td><strong>${r.date}</strong></td>
          <td><span class="badge-number">${escapeHtml(r.badge_number || r.user_id)}</span></td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.dept_name || 'General')}</td>
          <td>${formatTime(r.first_in)}</td>
          <td>${formatTime(r.last_out)}</td>
          <td>${r.punch_count}</td>
          <td><strong style="color: var(--accent-cyan)">${r.total_hours !== null ? r.total_hours + ' hrs' : '--'}</strong></td>
        </tr>
      `).join('');
    } catch (e) {
      reportsTbody.innerHTML = '<tr><td colspan="8" class="table-empty">Error generating report</td></tr>';
    }
  });

  // CSV Export
  btnExportCsv.addEventListener('click', () => {
    if (!reportData || reportData.length === 0) return;
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
        r.total_hours !== null ? r.total_hours : ''
      ];
      csvRows.push(row.join(','));
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `attendance_report_${reportFrom.value}_to_${reportTo.value}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Report exported successfully!', 'success');
  });

  // Helpers
  function formatTime(val) {
    if (!val) return '<span style="color: var(--text-muted)">--</span>';
    const d = new Date(val);
    if (isNaN(d.getTime())) return '<span style="color: var(--text-muted)">--</span>';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEVICE ADMINISTRATION
  // ─────────────────────────────────────────────────────────────────────────

  /** Fetch devices and render table; client-side filter applied on search */
  async function loadDevices() {
    devicesTbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading devices...</td></tr>';
    try {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      allDevices = await res.json();
      renderDevices(allDevices);
    } catch (e) {
      devicesTbody.innerHTML = `<tr><td colspan="8" class="table-empty">Error loading devices: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function renderDevices(list) {
    const q = deviceSearchInput.value.trim().toLowerCase();
    const filtered = q
      ? list.filter(d =>
          (d.sn || '').toLowerCase().includes(q) ||
          (d.alias || '').toLowerCase().includes(q) ||
          (d.ip_address || '').toLowerCase().includes(q) ||
          (d.location || '').toLowerCase().includes(q)
        )
      : list;

    if (filtered.length === 0) {
      devicesTbody.innerHTML = '<tr><td colspan="8" class="table-empty">No devices found</td></tr>';
      return;
    }

    devicesTbody.innerHTML = filtered.map(d => `
      <tr>
        <td><span class="badge-number font-mono">${escapeHtml(d.sn)}</span></td>
        <td><strong>${escapeHtml(d.alias || '—')}</strong></td>
        <td><span class="font-mono" style="color:var(--accent-cyan)">${escapeHtml(d.ip_address || '—')}</span></td>
        <td style="color:var(--text-secondary)">${escapeHtml(d.location || '—')}</td>
        <td style="color:var(--text-muted); font-size:0.82rem">${escapeHtml(d.model || '—')}</td>
        <td><span class="device-status-badge ${d.status}">${d.status === 'active' ? '● Active' : '○ Inactive'}</span></td>
        <td><span class="punch-count-pill">${Number(d.punch_count).toLocaleString()}</span></td>
        <td>
          <div class="table-actions">
            <button class="btn-icon edit" data-id="${d.id}" title="Edit device">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon delete" data-id="${d.id}" data-sn="${escapeHtml(d.sn)}" data-alias="${escapeHtml(d.alias || d.sn)}" title="Delete device">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('');

    // Wire action buttons
    devicesTbody.querySelectorAll('.btn-icon.edit').forEach(btn => {
      btn.addEventListener('click', () => openDeviceModal(parseInt(btn.dataset.id, 10)));
    });
    devicesTbody.querySelectorAll('.btn-icon.delete').forEach(btn => {
      btn.addEventListener('click', () => {
        openDeleteConfirm(
          'Delete Device',
          `Are you sure you want to remove device <strong>${escapeHtml(btn.dataset.alias)}</strong> (SN: <code>${escapeHtml(btn.dataset.sn)}</code>) from the registry?`,
          () => deleteDevice(parseInt(btn.dataset.id, 10))
        );
      });
    });
  }

  /** Opens the device modal in add (id=null) or edit (id=number) mode */
  async function openDeviceModal(id = null) {
    deviceEditId = id;
    deviceFormSn.value = '';
    deviceFormAlias.value = '';
    deviceFormIp.value = '';
    deviceFormModel.value = '';
    deviceFormLocation.value = '';
    deviceFormStatus.value = 'active';

    if (id !== null) {
      deviceModalTitle.textContent = 'Edit Device';
      document.getElementById('btn-save-device').textContent = 'Update Device';
      try {
        const res = await fetch(`/api/devices/${id}`);
        if (!res.ok) throw new Error('Device not found');
        const d = await res.json();
        deviceFormSn.value = d.sn || '';
        deviceFormAlias.value = d.alias || '';
        deviceFormIp.value = d.ip_address || '';
        deviceFormModel.value = d.model || '';
        deviceFormLocation.value = d.location || '';
        deviceFormStatus.value = d.status || 'active';
      } catch (e) {
        showToast(`Failed to load device: ${e.message}`, 'error');
        return;
      }
    } else {
      deviceModalTitle.textContent = 'Add Device';
      document.getElementById('btn-save-device').textContent = 'Save Device';
    }

    deviceModal.style.display = 'flex';
    deviceFormSn.focus();
  }

  function closeDeviceModal() { deviceModal.style.display = 'none'; }

  async function saveDevice() {
    const sn = deviceFormSn.value.trim();
    if (!sn) { showToast('Serial Number (SN) is required', 'error'); deviceFormSn.focus(); return; }

    const payload = {
      sn,
      alias: deviceFormAlias.value.trim() || null,
      ip_address: deviceFormIp.value.trim() || null,
      model: deviceFormModel.value.trim() || null,
      location: deviceFormLocation.value.trim() || null,
      status: deviceFormStatus.value,
    };

    const isEdit = deviceEditId !== null;
    const url = isEdit ? `/api/devices/${deviceEditId}` : '/api/devices';
    const method = isEdit ? 'PUT' : 'POST';

    const btn = document.getElementById('btn-save-device');
    btn.disabled = true;
    btn.textContent = isEdit ? 'Updating...' : 'Saving...';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');

      showToast(isEdit ? 'Device updated successfully' : 'Device added successfully', 'success');
      closeDeviceModal();
      loadDevices();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = isEdit ? 'Update Device' : 'Save Device';
    }
  }

  async function deleteDevice(id) {
    try {
      const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      showToast('Device deleted', 'success');
      loadDevices();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // Device event listeners
  document.getElementById('btn-add-device').addEventListener('click', () => openDeviceModal(null));
  document.getElementById('btn-close-device-modal').addEventListener('click', closeDeviceModal);
  document.getElementById('btn-cancel-device').addEventListener('click', closeDeviceModal);
  deviceModal.addEventListener('click', e => { if (e.target === deviceModal) closeDeviceModal(); });
  document.getElementById('btn-save-device').addEventListener('click', saveDevice);

  // Import devices from existing punch data
  document.getElementById('btn-import-devices').addEventListener('click', async () => {
    const btn = document.getElementById('btn-import-devices');
    btn.disabled = true;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Importing...`;
    try {
      const res = await fetch('/api/devices/import-from-punches', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      showToast(data.message, data.imported > 0 ? 'success' : 'info');
      loadDevices();
    } catch (e) {
      showToast(`Import error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Import from Punch Data`;
    }
  });

  // Device search (client-side, no extra fetch)
  let deviceSearchTimeout = null;
  deviceSearchInput.addEventListener('input', () => {
    clearTimeout(deviceSearchTimeout);
    deviceSearchTimeout = setTimeout(() => renderDevices(allDevices), 250);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // USERS ADMINISTRATION
  // ─────────────────────────────────────────────────────────────────────────

  async function loadUsersAdmin() {
    usersAdminTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Loading users...</td></tr>';
    try {
      const params = new URLSearchParams();
      const search = useradminSearchInput.value.trim();
      const deptId = useradminDeptFilter.value;
      if (search) params.append('search', search);
      if (deptId) params.append('dept_id', deptId);

      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      allUsersAdmin = await res.json();
      renderUsersAdmin(allUsersAdmin);
    } catch (e) {
      usersAdminTbody.innerHTML = `<tr><td colspan="7" class="table-empty">Error loading users: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function renderUsersAdmin(list) {
    if (list.length === 0) {
      usersAdminTbody.innerHTML = '<tr><td colspan="7" class="table-empty">No users found</td></tr>';
      return;
    }

    usersAdminTbody.innerHTML = list.map(u => `
      <tr>
        <td><span class="badge-number font-mono">${u.user_id}</span></td>
        <td><span class="badge-number font-mono">${escapeHtml(u.badge_number || '—')}</span></td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="avatar avatar-sm">${(u.name || '?').charAt(0)}</div>
            <strong>${escapeHtml(u.name)}</strong>
          </div>
        </td>
        <td style="color:var(--text-secondary)">${escapeHtml(u.dept_name || '—')}</td>
        <td style="color:var(--text-muted);font-size:0.82rem">${escapeHtml(u.gender || '—')}</td>
        <td><span class="punch-count-pill">${Number(u.punch_count).toLocaleString()}</span></td>
        <td>
          <div class="table-actions">
            <button class="btn-icon edit" data-id="${u.user_id}" title="Edit user">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon delete" data-id="${u.user_id}" data-name="${escapeHtml(u.name)}" title="Delete user">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
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
        openDeleteConfirm(
          'Delete User',
          `Are you sure you want to permanently delete <strong>${escapeHtml(btn.dataset.name)}</strong>?<br>All their punch records will also be deleted.`,
          () => deleteUser(parseInt(btn.dataset.id, 10))
        );
      });
    });
  }

  /** Opens user modal; id=null → add mode, id=number → edit mode */
  async function openUserModal(id = null) {
    userEditId = id;
    userFormId.value = '';
    userFormBadge.value = '';
    userFormName.value = '';
    userFormDept.value = '';
    userFormGender.value = '';

    if (id !== null) {
      userModalTitle.textContent = 'Edit User';
      document.getElementById('btn-save-user').textContent = 'Update User';
      userFormId.disabled = true; // can't change user_id (PK)
      const u = allUsersAdmin.find(x => x.user_id === id);
      if (u) {
        userFormId.value = u.user_id;
        userFormBadge.value = u.badge_number || '';
        userFormName.value = u.name || '';
        userFormDept.value = u.dept_id || '';
        userFormGender.value = u.gender || '';
      }
    } else {
      userModalTitle.textContent = 'Add User';
      document.getElementById('btn-save-user').textContent = 'Save User';
      userFormId.disabled = false;
    }

    userModal.style.display = 'flex';
    (id !== null ? userFormName : userFormId).focus();
  }

  function closeUserModal() { userModal.style.display = 'none'; }

  async function saveUser() {
    const name = userFormName.value.trim();
    if (!name) { showToast('Full name is required', 'error'); userFormName.focus(); return; }

    const isEdit = userEditId !== null;

    if (!isEdit) {
      const uid = parseInt(userFormId.value, 10);
      if (!userFormId.value || isNaN(uid) || uid <= 0) {
        showToast('A valid positive User ID is required', 'error'); userFormId.focus(); return;
      }
    }

    const payload = {
      badge_number: userFormBadge.value.trim() || null,
      name,
      gender: userFormGender.value || null,
      dept_id: userFormDept.value ? parseInt(userFormDept.value, 10) : null,
    };
    if (!isEdit) payload.user_id = parseInt(userFormId.value, 10);

    const url = isEdit ? `/api/employees/${userEditId}` : '/api/employees';
    const method = isEdit ? 'PUT' : 'POST';

    const btn = document.getElementById('btn-save-user');
    btn.disabled = true;
    btn.textContent = isEdit ? 'Updating...' : 'Saving...';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');

      showToast(isEdit ? 'User updated successfully' : 'User created successfully', 'success');
      closeUserModal();
      loadUsersAdmin();
      loadDepartments(); // refresh dept counts
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = isEdit ? 'Update User' : 'Save User';
    }
  }

  async function deleteUser(id) {
    try {
      const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      showToast('User deleted', 'success');
      loadUsersAdmin();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // User admin event listeners
  document.getElementById('btn-add-user').addEventListener('click', () => openUserModal(null));
  document.getElementById('btn-close-user-modal').addEventListener('click', closeUserModal);
  document.getElementById('btn-cancel-user').addEventListener('click', closeUserModal);
  userModal.addEventListener('click', e => { if (e.target === userModal) closeUserModal(); });
  document.getElementById('btn-save-user').addEventListener('click', saveUser);

  // User search/filter (server-side)
  let useradminSearchTimeout = null;
  useradminSearchInput.addEventListener('input', () => {
    clearTimeout(useradminSearchTimeout);
    useradminSearchTimeout = setTimeout(loadUsersAdmin, 300);
  });
  useradminDeptFilter.addEventListener('change', loadUsersAdmin);

  // ─────────────────────────────────────────────────────────────────────────
  // SHARED DELETE CONFIRM MODAL
  // ─────────────────────────────────────────────────────────────────────────

  function openDeleteConfirm(title, message, onConfirm) {
    confirmDeleteTitle.textContent = title;
    confirmDeleteMessage.innerHTML = message;
    deletePendingFn = onConfirm;
    confirmDeleteModal.style.display = 'flex';
  }

  function closeDeleteConfirm() {
    confirmDeleteModal.style.display = 'none';
    deletePendingFn = null;
  }

  document.getElementById('btn-close-confirm').addEventListener('click', closeDeleteConfirm);
  document.getElementById('btn-cancel-delete').addEventListener('click', closeDeleteConfirm);
  confirmDeleteModal.addEventListener('click', e => { if (e.target === confirmDeleteModal) closeDeleteConfirm(); });
  document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
    if (deletePendingFn) {
      closeDeleteConfirm();
      await deletePendingFn();
    }
  });

  // Initial Boot
  checkBridgeStatus();
  loadDepartments();
  loadDashboard();

  // Periodic status poll (every 30s)
  setInterval(checkBridgeStatus, 30000);
});

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

  // Modal elements
  const empModal = document.getElementById('employee-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const modalEmpAvatar = document.getElementById('modal-emp-avatar');
  const modalEmpName = document.getElementById('modal-emp-name');
  const modalEmpDetails = document.getElementById('modal-emp-details');
  const modalSummaryTbody = document.getElementById('modal-summary-tbody');
  const modalPunchesTbody = document.getElementById('modal-punches-tbody');
  const modalTabs = document.querySelectorAll('.modal-tab');

  // 1. Live Clock
  function updateLiveClock() {
    const now = new Date();
    liveClockEl.textContent = now.toLocaleTimeString([], { hour12: false });
  }
  setInterval(updateLiveClock, 1000);
  updateLiveClock();

  // 2. Navigation Switching
  const titles = {
    dashboard: { title: 'Attendance Dashboard', subtitle: 'Real-time personnel clock-in/out overview' },
    employees: { title: 'Personnel Directory', subtitle: 'Search and inspect personnel attendance profiles' },
    punches: { title: 'Punch Activity Log', subtitle: 'Chronological raw audit trail of biometric logs' },
    reports: { title: 'Attendance Reports', subtitle: 'Daily paired shifts, hours worked, and CSV export' }
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

      if (target === 'dashboard') loadDashboard();
      if (target === 'employees') loadEmployees();
      if (target === 'punches') loadPunches();
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

  // 5. Load Departments
  async function loadDepartments() {
    try {
      const res = await fetch('/api/departments');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (Array.isArray(data)) {
        departments = data;
        const options = departments.map(d => `<option value="${d.dept_id}">${escapeHtml(d.dept_name)}</option>`).join('');
        empDeptFilter.innerHTML = '<option value="">All Departments</option>' + options;
        reportDept.innerHTML = '<option value="">All Departments</option>' + options;
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

  // Initial Boot
  checkBridgeStatus();
  loadDepartments();
  loadDashboard();

  // Periodic status poll (every 30s)
  setInterval(checkBridgeStatus, 30000);
});

let allHistory = [];
let currentBookings = [];
let allBookings = [];
let bookingsHeaders = [];
let activeFilter = 'all';

// ── Trigger manual sheet check from dashboard ──
async function triggerManualCheck() {
  const btn = document.getElementById('trigger-btn');
  if (!btn) return;
  
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="refresh-icon spinning">⏱</span> Checking...';
  
  try {
    const res = await fetch('/api/check', { method: 'POST' });
    const data = await res.json();
    
    if (res.ok && data.success) {
      await loadData();
      showToast('✅ Sheet check completed successfully!');
    } else {
      showToast('❌ Error: ' + (data.error || 'Failed to complete check.'));
    }
  } catch (err) {
    console.error(err);
    showToast('❌ Network error while triggering check.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ── Acknowledge card from dashboard ──
async function acknowledgeCard(eventId, category, buttonEl, event) {
  if (event) event.stopPropagation();
  if (!eventId) return;
  
  // Retrieve the last used name, if any
  const savedName = localStorage.getItem('ack_username') || '';
  
  // Prompt the user for their name (pre-filled with the last used name)
  const username = prompt("Please enter your name for acknowledgment:", savedName);
  
  // If the user cancels the prompt, abort the acknowledgment
  if (username === null) return;
  
  const finalUsername = username.trim() || 'Dashboard User';
  
  // Save the name for future acknowledgments
  if (username.trim()) {
    localStorage.setItem('ack_username', finalUsername);
  }
  
  buttonEl.disabled = true;
  const originalText = buttonEl.textContent;
  buttonEl.textContent = 'Acknowledging...';
  
  try {
    const res = await fetch('/api/history/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: eventId, user: finalUsername, category })
    });
    
    if (res.ok) {
      await loadData();
    } else {
      showToast('❌ Failed to acknowledge event.');
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
    }
  } catch (err) {
    console.error(err);
    showToast('❌ Error connecting to server.');
    buttonEl.disabled = false;
    buttonEl.textContent = originalText;
  }
}

// Helper toast notification
function showToast(msg) {
  let toast = document.getElementById('dashboard-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dashboard-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.background = 'var(--bg-secondary)';
    toast.style.border = '1px solid var(--border)';
    toast.style.color = 'var(--text-primary)';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = 'var(--radius-sm)';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    toast.style.zIndex = '9999';
    toast.style.fontSize = '0.88rem';
    toast.style.transition = 'all 0.3s ease';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 4000);
}

let activeTab = 'changelog'; // 'changelog', 'bookings', or 'allbookings'
let displayLimit = 50; // Client-side pagination limit for rendering speed

// ── Load data from API ──────────────────────────────────────────────────────
async function loadData() {
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.classList.add('spinning');

  try {
    const [historyRes, statusRes, currentBookingsRes, allBookingsRes] = await Promise.all([
      fetch('/api/history'),
      fetch('/api/status'),
      fetch('/api/current-bookings'),
      fetch('/api/all-bookings'),
    ]);
    allHistory = await historyRes.json();
    const status = await statusRes.json();
    
    const currentBookingsData = await currentBookingsRes.json();
    currentBookings = currentBookingsData.bookings || [];
    bookingsHeaders = currentBookingsData.headers || [];

    const allBookingsData = await allBookingsRes.json();
    allBookings = allBookingsData.bookings || [];

    updateStats(status);
    renderContent();

    const lastCheck = status.lastCheck
      ? new Date(status.lastCheck).toLocaleString()
      : 'Never';
    const lastCheckEl = document.getElementById('last-check-time');
    if (lastCheckEl) lastCheckEl.textContent = lastCheck;

    // Update Database Status Badge
    const dbBadge = document.getElementById('db-status-badge');
    if (dbBadge && status.dbStatus) {
      if (status.dbStatus.connected) {
        dbBadge.style.backgroundColor = 'var(--green-bg)';
        dbBadge.style.color = 'var(--green)';
        dbBadge.style.borderColor = 'rgba(63,185,80,0.3)';
        dbBadge.style.borderStyle = 'solid';
        dbBadge.style.borderWidth = '1px';
        dbBadge.textContent = '🔌 DB: Connected';
        dbBadge.title = 'Successfully connected to MongoDB. Data is persistent across restarts.';
      } else {
        dbBadge.style.backgroundColor = 'var(--red-bg)';
        dbBadge.style.color = 'var(--red)';
        dbBadge.style.borderColor = 'rgba(248,81,73,0.3)';
        dbBadge.style.borderStyle = 'solid';
        dbBadge.style.borderWidth = '1px';
        dbBadge.textContent = '⚠️ DB: Local Fallback';
        dbBadge.title = 'Using ephemeral local fallback (WARNING: Data will be lost when Render restarts!).\nError: ' + (status.dbStatus.error || 'Unknown error');
      }
    }

  } catch (err) {
    console.error('Failed to load data:', err);
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

// ── Update stat cards ───────────────────────────────────────────────────────
function updateStats(status) {
  let newCount = 0, modCount = 0, errCount = 0;
  for (const event of allHistory) {
    if (event.error) { errCount++; continue; }
    newCount += (event.newRows || []).length;
    modCount += (event.modifiedRows || []).length;
  }
  const totalChecks = (status && typeof status.totalChecks !== 'undefined') ? status.totalChecks : allHistory.length;
  const statTotalEl = document.getElementById('stat-total');
  const statNewEl = document.getElementById('stat-new');
  const statModEl = document.getElementById('stat-modified');
  const statErrEl = document.getElementById('stat-errors');

  if (statTotalEl) statTotalEl.textContent = totalChecks;
  if (statNewEl) statNewEl.textContent = newCount;
  if (statModEl) statModEl.textContent = modCount;
  if (statErrEl) statErrEl.textContent = errCount;
}

// ── Tab switcher ────────────────────────────────────────────────────────────
function setTab(tabName) {
  activeTab = tabName;
  
  // Update active tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const targetTabBtn = document.getElementById('tab-' + tabName);
  if (targetTabBtn) targetTabBtn.classList.add('active');

  // Show/hide category filters (only for changelog)
  const filterBar = document.getElementById('category-filters');
  const monthFilterContainer = document.getElementById('month-filter-container');
  const viewTitleEl = document.getElementById('view-title');

  if (tabName === 'changelog') {
    if (filterBar) filterBar.style.display = 'flex';
    if (monthFilterContainer) monthFilterContainer.style.display = 'none';
    if (viewTitleEl) viewTitleEl.innerHTML = '📋 Change Log';
  } else if (tabName === 'bookings') {
    if (filterBar) filterBar.style.display = 'none';
    if (monthFilterContainer) monthFilterContainer.style.display = 'none';
    if (viewTitleEl) viewTitleEl.innerHTML = '📅 Current Month Bookings';
  } else {
    if (filterBar) filterBar.style.display = 'none';
    if (monthFilterContainer) monthFilterContainer.style.display = 'flex';
    if (viewTitleEl) viewTitleEl.innerHTML = '🌎 All Bookings';
  }

  // Reset month filter and display limit when switching tabs
  const monthFilterInput = document.getElementById('month-filter-input');
  if (monthFilterInput) monthFilterInput.value = '';
  displayLimit = 50;

  renderContent();
}

// ── Filter ──────────────────────────────────────────────────────────────────
function setFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.remove('active','active-green','active-yellow');
  });
  const btn = document.getElementById('filter-' + filter);
  if (btn) {
    if (filter === 'new')      btn.classList.add('active-green');
    else if (filter === 'modified') btn.classList.add('active-yellow');
    else btn.classList.add('active');
  }
  renderContent();
}

// Helper to parse dates client-side
function parseClientDate(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try standard parsing first
  const d = new Date(trimmed);
  if (!isNaN(d)) return d;

  // Try dd/mm/yyyy or dd-mm-yyyy
  const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    const parsed = new Date(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`);
    if (!isNaN(parsed)) return parsed;
  }

  // Handle formats like "30th May", "2nd June", "24thJuly"
  const dayMatch = trimmed.match(/^(\d+)/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    const rest = trimmed.toLowerCase();

    let month = -1;
    if (rest.includes('jan')) month = 0;
    else if (rest.includes('feb')) month = 1;
    else if (rest.includes('mar')) month = 2;
    else if (rest.includes('apr')) month = 3;
    else if (rest.includes('may')) month = 4;
    else if (rest.includes('jun')) month = 5;
    else if (rest.includes('jul')) month = 6;
    else if (rest.includes('aug')) month = 7;
    else if (rest.includes('sep')) month = 8;
    else if (rest.includes('oct')) month = 9;
    else if (rest.includes('nov')) month = 10;
    else if (rest.includes('dec')) month = 11;

    if (month !== -1) {
      // Assume current year 2026 for textual relative dates
      const year = 2026;
      return new Date(year, month, day);
    }
  }
  return null;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

// ── Theme Auto-Detection & Switching ─────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

// Initialize theme on script execution
initTheme();

function parsePaxString(str) {
  if (!str || typeof str !== 'string') return 0;
  // Ignore numbers inside parentheses (e.g. "(7 Dives)", "(5 Dives)")
  let s = str.replace(/\([^)]*\)/g, '').trim();
  if (!s) return 0;

  let total = 0;

  // 1. Match DM / Dive Master / Divemaster
  const dmRegex = /\+?\s*(\d*)\s*(?:dm|divemaster|dive\s*master)\b/gi;
  let dmMatch;
  while ((dmMatch = dmRegex.exec(s)) !== null) {
    const num = dmMatch[1] ? parseInt(dmMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(dmRegex, ' ').trim();

  // 2. Match Ins / Instructor / Instructors
  const insRegex = /\+?\s*(\d*)\s*(?:i[nst]+[ruoc]*t[oers]{0,4}|ins|inst|instructor|instructors)\b/gi;
  let insMatch;
  while ((insMatch = insRegex.exec(s)) !== null) {
    const num = insMatch[1] ? parseInt(insMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(insRegex, ' ').trim();

  // 3. Match remaining numbers
  const matches = s.matchAll(/(\d+)/g);
  for (const m of matches) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val)) total += val;
  }

  return total;
}

function parseSnorkPaxClient(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\([^)]*\)/, '').trim();
  if (!s) return 0;
  let total = 0;
  const numA = s.match(/(\d+)\s*A(?=\s|$|[^A-Za-z])/i);
  const numC = s.match(/(\d+)\s*C(?=\s|$|[^A-Za-z])/i);
  const numB = s.match(/(\d+)\s*Baby\b/i);
  if (numA) total += parseInt(numA[1], 10);
  if (numC) total += parseInt(numC[1], 10);
  if (numB) total += parseInt(numB[1], 10);
  return total;
}

function parseDivingPaxClient(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\([^)]*\)/g, '').trim();
  if (!s) return 0;
  let total = 0;

  // 1. Identify Dive Master / DM
  const dmRegex = /\+?\s*(\d*)\s*(?:dm|divemaster|dive\s*master)\b/gi;
  let dmMatch;
  while ((dmMatch = dmRegex.exec(s)) !== null) {
    const count = dmMatch[1] ? parseInt(dmMatch[1], 10) : 1;
    total += count;
  }
  s = s.replace(dmRegex, ' ').trim();

  // 2. Identify Instructor / Ins
  const insRegex = /\+?\s*(\d*)\s*(?:i[nst]+[ruoc]*t[oers]{0,4}|ins|inst|instructor|instructors)\b/gi;
  let insMatch;
  while ((insMatch = insRegex.exec(s)) !== null) {
    const count = insMatch[1] ? parseInt(insMatch[1], 10) : 1;
    total += count;
  }
  s = s.replace(insRegex, ' ').trim();

  // 3. Match all "NUMBER A" patterns (e.g. "7A", "1A")
  const matchesA = Array.from(s.matchAll(/(\d+)\s*A(?=\s|$|[^A-Za-z])/gi));
  if (matchesA.length > 0) {
    for (const m of matchesA) {
      total += parseInt(m[1], 10);
    }
  } else if (/\bA\b/i.test(s)) {
    total += 1;
  } else {
    const bareNum = s.match(/^(\d+)/);
    if (bareNum) total += parseInt(bareNum[1], 10);
  }

  // 4. Also check for C/B patterns
  const numC = s.match(/(\d+)\s*C\b/i);
  const numB = s.match(/(\d+)\s*Baby\b/i);
  if (numC) total += parseInt(numC[1], 10);
  if (numB) total += parseInt(numB[1], 10);

  return total;
}

function parseCoursePaxClient(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\+?\s*(?:free\s*)?\d+\s*(?:boat\s*)?dives?(?:\s*each)?/gi, '').trim();
  if (!s) return 0;
  let total = 0;
  const matches = s.match(/\d+\s*[A-Za-z][A-Za-z-]*/g);
  if (matches) {
    for (const m of matches) {
      const numMatch = m.match(/^(\d+)/);
      if (numMatch) total += parseInt(numMatch[1], 10);
    }
    return total;
  }
  const bareNum = s.match(/^(\d+)$/);
  if (bareNum) return parseInt(bareNum[1], 10);
  return 1;
}

function getRowActivityPaxClient(rowData) {
  const snork = (rowData[4] || '').toString();
  const dive = (rowData[5] || '').toString();
  const course = (rowData[6] || '').toString();
  return parseSnorkPaxClient(snork) + parseDivingPaxClient(dive) + parseCoursePaxClient(course);
}

// ── In-House Guests Calculation ──────────────────────────────────
function updateInHouseStats(targetDate) {
  const tDate = targetDate ? new Date(targetDate) : new Date();
  tDate.setHours(0, 0, 0, 0);

  const bookingsList = (allBookings && allBookings.length > 0) ? allBookings : currentBookings;
  const roomPaxIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');
  const remarkIdx = bookingsHeaders.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
  const codeIdx = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');

  const bookingsByCode = {};

  bookingsList.forEach((item, index) => {
    const rowData = item.row || [];
    const remarkVal = (remarkIdx !== -1 ? (rowData[remarkIdx] || '') : (rowData[22] || '')).toString().toLowerCase();

    // Exclude cancelled or postponed bookings
    if (remarkVal.includes('cancel') || remarkVal.includes('cancle') || remarkVal.includes('cancelled') || remarkVal.includes('postpone') || remarkVal.includes('postponed')) {
      return;
    }

    const checkIn = parseClientDate(rowData[7]);
    const checkOut = parseClientDate(rowData[8]);

    if (!checkIn) return;
    const cIn = new Date(checkIn);
    cIn.setHours(0, 0, 0, 0);

    let cOut = checkOut ? new Date(checkOut) : new Date(cIn);
    cOut.setHours(0, 0, 0, 0);

    let isInHouse = false;
    if (cOut > cIn) {
      isInHouse = (tDate >= cIn && tDate < cOut);
    } else {
      isInHouse = (tDate.getTime() === cIn.getTime());
    }

    if (isInHouse) {
      const rawCode = (codeIdx !== -1 && rowData[codeIdx]) ? rowData[codeIdx].toString().trim().toUpperCase() : '';
      const codeKey = rawCode || `ROW_${index}`;

      if (!bookingsByCode[codeKey]) {
        bookingsByCode[codeKey] = {
          code: rawCode,
          totalActivityPax: 0,
          roomPax: 0
        };
      }

      bookingsByCode[codeKey].totalActivityPax += getRowActivityPaxClient(rowData);

      if (roomPaxIdx !== -1 && rowData[roomPaxIdx] && rowData[roomPaxIdx] !== '—') {
        const parsedPax = parsePaxString(rowData[roomPaxIdx].toString());
        if (parsedPax > 0 && bookingsByCode[codeKey].roomPax === 0) {
          bookingsByCode[codeKey].roomPax = parsedPax;
        }
      }
    }
  });

  let totalPax = 0;
  let totalBookingsInHouse = 0;

  for (const key in bookingsByCode) {
    const group = bookingsByCode[key];
    totalBookingsInHouse++;

    let pax = 1;
    if (group.totalActivityPax > 0) {
      pax = group.totalActivityPax;
    } else if (group.roomPax > 0) {
      pax = group.roomPax;
    }

    totalPax += pax;
  }

  const statInhouseEl = document.getElementById('stat-inhouse');
  const statInhouseSubEl = document.getElementById('stat-inhouse-sub');
  const inHouseBadgeEl = document.getElementById('in-house-count-badge');

  const dateFormatted = tDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const isToday = isSameDay(tDate, new Date());
  const dateLabel = isToday ? `Today (${dateFormatted})` : dateFormatted;

  if (statInhouseEl) statInhouseEl.textContent = `${totalPax} Pax`;
  if (statInhouseSubEl) statInhouseSubEl.textContent = `${totalBookingsInHouse} booking${totalBookingsInHouse !== 1 ? 's' : ''} (${dateLabel})`;
  
  if (inHouseBadgeEl) {
    inHouseBadgeEl.textContent = `🏠 ${totalPax} In-House Guests (${dateLabel})`;
    inHouseBadgeEl.style.display = (activeTab === 'bookings' || activeTab === 'allbookings') ? 'inline-flex' : 'none';
  }
}

let searchTimeout = null;
function handleSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    renderContent();
  }, 200); // 200ms debounce to prevent freezing while typing
}

function handleDateSelect() {
  renderContent();
}

function handleMonthSelect() {
  renderContent();
}

function clearDateFilters() {
  const searchEl = document.getElementById('search-input');
  const checkinEl = document.getElementById('checkin-date-input');
  const checkoutEl = document.getElementById('checkout-date-input');
  const monthEl = document.getElementById('month-filter-input');
  if (searchEl) searchEl.value = '';
  if (checkinEl) checkinEl.value = '';
  if (checkoutEl) checkoutEl.value = '';
  if (monthEl) monthEl.value = '';
  displayLimit = 50; // Reset pagination limit
  renderContent();
}

function loadMoreBookings() {
  displayLimit += 100;
  renderContent();
}

// ── Render content ──────────────────────────────────────────────────────────
function renderContent() {
  const container = document.getElementById('changes-list');
  const badgeCountEl = document.getElementById('items-count-badge');

  if (!container) return;

  const searchQuery = document.getElementById('search-input')?.value.toLowerCase().trim() || '';
  const checkinDateVal = document.getElementById('checkin-date-input')?.value || '';
  const checkoutDateVal = document.getElementById('checkout-date-input')?.value || '';
  const monthFilterVal = document.getElementById('month-filter-input')?.value || '';

  let parsedCheckInDate = null;
  if (checkinDateVal) {
    parsedCheckInDate = new Date(checkinDateVal);
  }

  let parsedCheckOutDate = null;
  if (checkoutDateVal) {
    parsedCheckOutDate = new Date(checkoutDateVal);
  }

  // Update In-House Guests statistics for the target date
  updateInHouseStats(parsedCheckInDate);

  if (activeTab === 'changelog') {
    // --- Render Change Log ---
    const items = [];
    for (const event of allHistory) {
      if (event.error) {
        items.push({ type: 'error', event });
        continue;
      }
      for (const row of (event.newRows || [])) {
        items.push({ 
          type: 'new', 
          row, 
          checkedAt: event.checkedAt,
          eventId: event.id,
          acknowledgedReception: event.acknowledgedReception || false,
          acknowledgedReceptionBy: event.acknowledgedReceptionBy || null,
          acknowledgedReceptionAt: event.acknowledgedReceptionAt || null,
          acknowledgedDiveCenter: event.acknowledgedDiveCenter || false,
          acknowledgedDiveCenterBy: event.acknowledgedDiveCenterBy || null,
          acknowledgedDiveCenterAt: event.acknowledgedDiveCenterAt || null
        });
      }
      for (const row of (event.modifiedRows || [])) {
        items.push({ 
          type: 'modified', 
          row, 
          checkedAt: event.checkedAt,
          eventId: event.id,
          acknowledgedReception: event.acknowledgedReception || false,
          acknowledgedReceptionBy: event.acknowledgedReceptionBy || null,
          acknowledgedReceptionAt: event.acknowledgedReceptionAt || null,
          acknowledgedDiveCenter: event.acknowledgedDiveCenter || false,
          acknowledgedDiveCenterBy: event.acknowledgedDiveCenterBy || null,
          acknowledgedDiveCenterAt: event.acknowledgedDiveCenterAt || null
        });
      }
    }

    // Filter by category
    let filtered = activeFilter === 'all'
      ? items
      : items.filter(i => i.type === activeFilter);

    // Filter by search query / dates
    if (searchQuery || parsedCheckInDate || parsedCheckOutDate) {
      filtered = filtered.filter(item => {
        if (item.type === 'error') {
          return searchQuery ? item.event.error.toLowerCase().includes(searchQuery) : true;
        }

        const rowData = item.row.row || [];
        const code = (rowData[1] || '').toString().toLowerCase();
        const pic = (rowData[2] || '').toString().toLowerCase();
        const name = (rowData[3] || '').toString().toLowerCase();
        const checkInStr = (rowData[7] || '').toString();
        const checkOutStr = (rowData[8] || '').toString();

        if (searchQuery) {
          const matchesCode = code.includes(searchQuery);
          const matchesPic = pic.includes(searchQuery);
          const matchesName = name.includes(searchQuery);
          const matchesCheckIn = checkInStr.toLowerCase().includes(searchQuery);
          const matchesCheckOut = checkOutStr.toLowerCase().includes(searchQuery);
          if (!matchesCode && !matchesPic && !matchesName && !matchesCheckIn && !matchesCheckOut) return false;
        }

        if (parsedCheckInDate) {
          const checkInDate = parseClientDate(checkInStr);
          const checkInMatches = checkInDate && isSameDay(checkInDate, parsedCheckInDate);
          if (!checkInMatches) return false;
        }

        if (parsedCheckOutDate) {
          const checkOutDate = parseClientDate(checkOutStr);
          const checkOutMatches = checkOutDate && isSameDay(checkOutDate, parsedCheckOutDate);
          if (!checkOutMatches) return false;
        }

        return true;
      });
    }

    if (badgeCountEl) badgeCountEl.textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      if (!searchQuery && !parsedCheckInDate && !parsedCheckOutDate && items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">📋</div>
            <h3>No changes detected yet</h3>
            <p>The bot will notify you here and on Telegram<br>when it finds new or modified rows this month.</p>
          </div>`;
      } else {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">🔍</div>
            <h3>No matching changes found</h3>
            <p>Try adjusting your search query or filters.</p>
          </div>`;
      }
      return;
    }

    container.innerHTML = filtered.map((item, idx) => buildCard(item, idx)).join('');

  } else {
    // --- Render Bookings (Current or All) ---
    let filtered = activeTab === 'bookings' ? [...currentBookings] : [...allBookings];

    // Filter by search query / dates / month
    if (searchQuery || parsedCheckInDate || parsedCheckOutDate || monthFilterVal !== '') {
      filtered = filtered.filter(item => {
        const rowData = item.row || [];
        const code = (rowData[1] || '').toString().toLowerCase();
        const pic = (rowData[2] || '').toString().toLowerCase();
        const name = (rowData[3] || '').toString().toLowerCase();
        const checkInStr = (rowData[7] || '').toString();
        const checkOutStr = (rowData[8] || '').toString();

        if (searchQuery) {
          const matchesCode = code.includes(searchQuery);
          const matchesPic = pic.includes(searchQuery);
          const matchesName = name.includes(searchQuery);
          const matchesCheckIn = checkInStr.toLowerCase().includes(searchQuery);
          const matchesCheckOut = checkOutStr.toLowerCase().includes(searchQuery);
          if (!matchesCode && !matchesPic && !matchesName && !matchesCheckIn && !matchesCheckOut) return false;
        }

        if (parsedCheckInDate) {
          const checkInDate = parseClientDate(checkInStr);
          const checkInMatches = checkInDate && isSameDay(checkInDate, parsedCheckInDate);
          if (!checkInMatches) return false;
        }

        if (parsedCheckOutDate) {
          const checkOutDate = parseClientDate(checkOutStr);
          const checkOutMatches = checkOutDate && isSameDay(checkOutDate, parsedCheckOutDate);
          if (!checkOutMatches) return false;
        }

        if (monthFilterVal !== '') {
          const checkInDate = parseClientDate(checkInStr);
          const monthMatches = checkInDate && checkInDate.getMonth() === parseInt(monthFilterVal, 10);
          if (!monthMatches) return false;
        }

        return true;
      });
    }

    if (badgeCountEl) badgeCountEl.textContent = `${filtered.length} booking${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      const hasNoBookings = (activeTab === 'bookings' ? currentBookings.length : allBookings.length) === 0;
      if (!searchQuery && !parsedCheckInDate && !parsedCheckOutDate && monthFilterVal === '' && hasNoBookings) {
        const emptyText = activeTab === 'bookings' 
          ? 'No active bookings this month' 
          : 'No bookings found in the Google Sheet';
        const emptyDesc = activeTab === 'bookings'
          ? 'Bookings matching the current month will automatically load here.'
          : 'Check your Google Sheet data and ensure the service account has read access.';
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">📅</div>
            <h3>${emptyText}</h3>
            <p>${emptyDesc}</p>
          </div>`;
      } else {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">🔍</div>
            <h3>No matching bookings found</h3>
            <p>Try adjusting your search query or date filter.</p>
          </div>`;
      }
      return;
    }

    const sliced = filtered.slice(0, displayLimit);
    let html = sliced.map((booking, idx) => buildBookingCard(booking, idx)).join('');

    if (filtered.length > displayLimit) {
      html += `
        <div style="text-align: center; margin-top: 24px; margin-bottom: 24px;">
          <button class="refresh-btn" onclick="loadMoreBookings()" style="padding: 10px 24px; font-size: 0.88rem; border-radius: var(--radius-sm); margin: 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 8px;">
            ➕ Load More Bookings (${filtered.length - displayLimit} remaining)
          </button>
        </div>`;
    }
    container.innerHTML = html;
  }
}

// ── Build a single change card ──────────────────────────────────────────────
function buildCard(item, idx) {
  const id = `card-${idx}`;

  if (item.type === 'error') {
    return `
      <div class="change-card modified" id="${id}">
        <div class="card-header" onclick="toggleCard('${id}')">
          <div class="card-left">
            <span class="type-badge modified">ERROR</span>
            <span class="card-title">Bot Error</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="card-time">${formatTime(item.event.checkedAt)}</span>
            <span class="chevron">▼</span>
          </div>
        </div>
        <div class="card-body">
          <p style="color:var(--red);font-size:0.85rem;padding-top:12px">${escapeHtml(item.event.error)}</p>
        </div>
      </div>`;
  }

  const row = item.row;
  const headers = row.headers || [];
  const rowData = row.row || [];
  
  // Find customer name, booking code, and check-in date dynamically for a more descriptive card title
  const nameIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');
  const codeIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  const checkInIndex = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
  
  const name = nameIndex !== -1 ? (rowData[nameIndex] || '').toString().trim() : (rowData[3] || '').toString().trim();
  const code = codeIndex !== -1 ? (rowData[codeIndex] || '').toString().trim() : (rowData[1] || '').toString().trim();
  const checkIn = checkInIndex !== -1 ? (rowData[checkInIndex] || '').toString().trim() : (rowData[7] || '').toString().trim();
  const roomIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const room = roomIndex !== -1 ? rowData[roomIndex] : '';
  
  const colorIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROW_COLOR');
  const rowColor = colorIndex !== -1 ? (rowData[colorIndex] || 'WHITE') : 'WHITE';

  const remarkIndex = headers.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
  const remarkVal = remarkIndex !== -1 ? (rowData[remarkIndex] || '') : (rowData[22] || '');
  let remarkBadge = '';
  let titleRemarkInfo = '';

  const isRowWhite = (rowColor.toString().trim().toUpperCase() === 'WHITE');
  const lowerRemark = remarkVal.toLowerCase();

  // Special remark check (cancel, postpone, double code, duplicate, etc.)
  const isSpecialRemark = lowerRemark.includes('cancel') || lowerRemark.includes('cancle') || lowerRemark.includes('cancled') || lowerRemark.includes('cancelled') ||
                         lowerRemark.includes('postpone') || lowerRemark.includes('postponed') ||
                         lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged') ||
                         lowerRemark.includes('double') || lowerRemark.includes('dup');

  if (isRowWhite) {
    if (isSpecialRemark && remarkVal.toString().trim()) {
      let icon = '';
      let badgeText = '';
      let badgeBg = 'var(--red-bg)';
      let badgeColor = 'var(--red)';
      let badgeBorder = 'rgba(248,81,73,0.3)';

      if (lowerRemark.includes('cancel') || lowerRemark.includes('cancle') || lowerRemark.includes('cancled') || lowerRemark.includes('cancelled')) {
        icon = '❌ ';
        badgeText = '❌ Cancelled';
      } else if (lowerRemark.includes('postpone') || lowerRemark.includes('postponed')) {
        icon = '⏳ ';
        badgeText = '⏳ Postponed';
      } else if (lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged')) {
        icon = '🔄 ';
        badgeText = '🔄 Changed';
      } else if (lowerRemark.includes('double') || lowerRemark.includes('dup')) {
        icon = '⚠️ ';
        badgeText = '⚠️ Double Code';
      }

      if (badgeText) {
        remarkBadge = `<span class="type-badge" style="background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">${badgeText}</span>`;
      }
      titleRemarkInfo = ` • ${icon}${remarkVal.toString().trim()}`;
    }
  }

  const cardTitle = name 
    ? `${name}${code ? ` (${code})` : ''}${checkIn ? ` • In: ${checkIn}` : ''}${room && room !== '—' ? ` • 🚪 ${room}` : ''}${titleRemarkInfo}` 
    : (rowData[0] || '—');
  const typeLabel = item.type === 'new' ? 'NEW ROW' : 'MODIFIED';
  const cardClass = item.type === 'new' ? 'new-row' : 'modified';
  const badgeClass = item.type === 'new' ? 'new' : 'modified';

  let bodyHtml = '';

  if (item.type === 'new') {
    // Show all non-empty cells
    const rows = headers
      .map((h, i) => {
        const val = (rowData[i] || '').toString().trim();
        if (!val) return '';
        if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS', 'ROW_COLOR'].includes(h.toUpperCase().trim())) return '';
        return `<tr><td style="color:var(--text-secondary);width:35%">${escapeHtml(h)}</td><td>${escapeHtml(val)}</td></tr>`;
      })
      .filter(Boolean)
      .join('');

    bodyHtml = `
      <table class="row-table" style="margin-top:12px">
        <thead><tr><th>Column</th><th>Value</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="2" style="color:var(--text-muted)">No data</td></tr>'}</tbody>
      </table>`;

  } else {
    // Show only changed cells with before/after
    const changes = (row.changes || []);
    const changesRows = changes
      .map(c => {
        if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS', 'ROW_COLOR'].includes(c.column.toUpperCase().trim())) return '';
        return `
          <tr>
            <td style="color:var(--text-secondary);width:30%">${escapeHtml(c.column)}</td>
            <td>
              <span class="diff-before">${escapeHtml(c.before) || '(empty)'}</span>
              <span class="diff-arrow">→</span>
              <span class="diff-after">${escapeHtml(c.after) || '(empty)'}</span>
            </td>
          </tr>`;
      })
      .filter(Boolean)
      .join('');

    // Show full row data
    const fullRows = headers
      .map((h, i) => {
        const val = (rowData[i] || '').toString().trim();
        if (!val) return '';
        if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS', 'ROW_COLOR'].includes(h.toUpperCase().trim())) return '';
        return `<tr><td style="color:var(--text-secondary);width:35%">${escapeHtml(h)}</td><td>${escapeHtml(val)}</td></tr>`;
      })
      .filter(Boolean)
      .join('');

    bodyHtml = `
      <div style="margin-top: 12px; font-weight: 600; font-size: 0.85rem; color: var(--yellow);">⚡ Changes:</div>
      <table class="row-table" style="margin-top:6px; margin-bottom: 16px;">
        <thead><tr><th>Column</th><th>Change</th></tr></thead>
        <tbody>${changesRows}</tbody>
      </table>
      
      <div style="font-weight: 600; font-size: 0.85rem; color: var(--text-secondary);">📋 Full Row Data:</div>
      <table class="row-table" style="margin-top:6px;">
        <thead><tr><th>Column</th><th>Value</th></tr></thead>
        <tbody>${fullRows || '<tr><td colspan="2" style="color:var(--text-muted)">No data</td></tr>'}</tbody>
      </table>`;
  }

  let ackHtml = '';
  if (item.type !== 'error') {
    const ackRec = item.acknowledgedReception;
    const ackRecBy = item.acknowledgedReceptionBy;
    const ackRecAt = item.acknowledgedReceptionAt;

    const ackDiv = item.acknowledgedDiveCenter;
    const ackDivBy = item.acknowledgedDiveCenterBy;
    const ackDivAt = item.acknowledgedDiveCenterAt;

    let recPart = '';
    if (ackRec) {
      recPart = `
        <span class="ack-badge">
          🛎 Reception: Acknowledged by ${escapeHtml(ackRecBy)} ${ackRecAt ? `at ${new Date(ackRecAt).toLocaleTimeString()}` : ''}
        </span>`;
    } else if (item.eventId) {
      recPart = `
        <button class="ack-btn" onclick="acknowledgeCard('${item.eventId}', 'reception', this, event)">
          🛎 Acknowledge Reception
        </button>`;
    }

    let divPart = '';
    if (ackDiv) {
      divPart = `
        <span class="ack-badge" style="background:var(--accent-glow);color:var(--accent);border-color:rgba(88,166,255,0.3)">
          🤿 Dive Center: Acknowledged by ${escapeHtml(ackDivBy)} ${ackDivAt ? `at ${new Date(ackDivAt).toLocaleTimeString()}` : ''}
        </span>`;
    } else if (item.eventId) {
      divPart = `
        <button class="ack-btn" style="background:var(--accent-glow);color:var(--accent);border-color:rgba(88,166,255,0.3)" onclick="acknowledgeCard('${item.eventId}', 'dive_center', this, event)">
          🤿 Acknowledge Dive Center
        </button>`;
    }

    ackHtml = `
      <div class="ack-section" style="border-top: 1px dashed var(--border); margin-top: 16px; padding-top: 4px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        ${recPart}
        ${divPart}
      </div>`;
  }

  return `
    <div class="change-card ${cardClass}" id="${id}" style="${rowColor !== 'WHITE' ? `border-left: 3px solid ${rowColor} !important;` : ''}">
      <div class="card-header" onclick="toggleCard('${id}')">
        <div class="card-left">
          <span class="type-badge ${badgeClass}">${typeLabel}</span>
          <span class="card-title">${escapeHtml(String(cardTitle))}</span>
          ${remarkBadge}
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="card-time">${formatTime(item.checkedAt)}</span>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="card-body">
        ${bodyHtml}
        ${ackHtml}
      </div>
    </div>`;
}

// Helper to detect Room Change vs Group Booking
function parseRoomDetails(roomVal, actPax) {
  if (!roomVal || roomVal === '—') return { isRoomChange: false, displayRooms: '—', roomBadgeHtml: '' };

  const isTrueRoomChange = roomVal.includes('➔') || roomVal.toLowerCase().includes('changed on');

  if (isTrueRoomChange) {
    return {
      isRoomChange: true,
      displayRooms: roomVal,
      roomBadgeHtml: `<span class="type-badge" style="background:rgba(187,128,255,0.15);color:#d2a8ff;border:1px solid rgba(187,128,255,0.4);text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">🔄 Room Change: ${escapeHtml(roomVal)}</span>`
    };
  }

  return {
    isRoomChange: false,
    displayRooms: roomVal,
    roomBadgeHtml: `<span class="type-badge" style="background:var(--yellow-bg);color:var(--yellow);border:1px solid rgba(210,153,34,0.3);text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">🚪 Room: ${escapeHtml(String(roomVal))}</span>`
  };
}

// ── Build a single booking card ─────────────────────────────────────────────
function buildBookingCard(booking, idx) {
  const id = `booking-${idx}`;
  const rowData = booking.row || [];
  const name = rowData[3] || '—'; // Customer Name
  const code = rowData[1] || '—'; // CODE
  const pic = rowData[2] || '—'; // PIC
  const checkIn = rowData[7] || '—';
  const checkOut = rowData[8] || '—';

  // Find ROOM, ROOM_PAX, ROW_COLOR and REMARK indices dynamically from bookingsHeaders
  const roomIndex = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM');
  const roomPaxIndex = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');
  const colorIndex = bookingsHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROW_COLOR');
  const remarkIndex = bookingsHeaders.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
  
  const roomVal = roomIndex !== -1 ? (rowData[roomIndex] || '—') : '—';
  const rowColor = colorIndex !== -1 ? (rowData[colorIndex] || 'WHITE') : 'WHITE';
  const remarkVal = remarkIndex !== -1 ? (rowData[remarkIndex] || '') : (rowData[22] || '');

  // Smart Pax & Room Change Calculation
  const actPax = getRowActivityPaxClient(rowData);
  let cardPax = booking.pax;
  if (!cardPax) {
    if (actPax > 0) cardPax = actPax;
    else if (roomPaxIndex !== -1 && rowData[roomPaxIndex] && rowData[roomPaxIndex] !== '—') {
      const parsed = parsePaxString(rowData[roomPaxIndex].toString());
      cardPax = parsed > 0 ? parsed : 1;
    } else {
      cardPax = 1;
    }
  }

  const roomInfo = parseRoomDetails(roomVal, actPax || cardPax);

  // Determine status badge and border styling based on remark keywords and row color
  let remarkBadge = '';
  let cardLeftBorder = 'var(--accent)';
  let titleRemarkInfo = '';

  const isRowWhite = (rowColor.toString().trim().toUpperCase() === 'WHITE');
  const lowerRemark = remarkVal.toLowerCase();

  // Special remark check (cancel, postpone, double code, duplicate, etc.)
  const isSpecialRemark = lowerRemark.includes('cancel') || lowerRemark.includes('cancle') || lowerRemark.includes('cancled') || lowerRemark.includes('cancelled') ||
                         lowerRemark.includes('postpone') || lowerRemark.includes('postponed') ||
                         lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged') ||
                         lowerRemark.includes('double') || lowerRemark.includes('dup');

  if (isRowWhite) {
    if (isSpecialRemark && remarkVal.toString().trim()) {
      let icon = '';
      let badgeText = '';
      let badgeBg = 'var(--red-bg)';
      let badgeColor = 'var(--red)';
      let badgeBorder = 'rgba(248,81,73,0.3)';

      if (lowerRemark.includes('cancel') || lowerRemark.includes('cancle') || lowerRemark.includes('cancled') || lowerRemark.includes('cancelled')) {
        icon = '❌ ';
        badgeText = '❌ Cancelled';
      } else if (lowerRemark.includes('postpone') || lowerRemark.includes('postponed')) {
        icon = '⏳ ';
        badgeText = '⏳ Postponed';
      } else if (lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged')) {
        icon = '🔄 ';
        badgeText = '🔄 Changed';
      } else if (lowerRemark.includes('double') || lowerRemark.includes('dup')) {
        icon = '⚠️ ';
        badgeText = '⚠️ Double Code';
      }

      if (badgeText) {
        remarkBadge = `<span class="type-badge" style="background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};text-transform:none;margin-left:4px;display:inline-flex;align-items:center;gap:4px">${badgeText}</span>`;
      }
      titleRemarkInfo = `<span style="font-size:0.85rem;color:var(--text-secondary);font-weight:normal;margin-left:8px">${icon}• ${escapeHtml(remarkVal.toString().trim())}</span>`;
    }
  } else {
    // Row is colored. We ignore the remark and use the sheet color directly.
    cardLeftBorder = rowColor;
  }

  // Fields requested by user to display in detail table
  const fields = [
    { key: 'CODE', val: rowData[1] },
    { key: 'PIC', val: rowData[2] },
    { key: 'NAME', val: rowData[3] },
    { key: 'ROOM ASSIGNED', val: roomInfo.isRoomChange ? roomInfo.displayRooms : roomVal },
    { key: 'ROOM GUESTS (PAX)', val: cardPax },
    { key: 'SNORKELLING', val: rowData[4] },
    { key: 'DIVING', val: rowData[5] },
    { key: 'COURSE', val: rowData[6] },
    { key: 'CHECK IN', val: rowData[7] },
    { key: 'CHECK OUT', val: rowData[8] },
    { key: 'STAYING DAYS', val: rowData[9] },
    { key: 'ROOM TYPE', val: rowData[10] },
    { key: 'SHARING', val: rowData[11] },
    { key: 'BED', val: rowData[12] },
    { key: 'SPECIAL REQUEST', val: rowData[13] },
    { key: 'REMARK', val: remarkVal },
  ];

  const rows = fields
    .map(f => {
      const val = (f.val || '').toString().trim();
      if (!val) return '';
      return `<tr><td style="color:var(--text-secondary);width:35%">${escapeHtml(f.key)}</td><td>${escapeHtml(val)}</td></tr>`;
    })
    .filter(Boolean)
    .join('');

  return `
    <div class="change-card" id="${id}" style="border-left: 3px solid ${cardLeftBorder}">
      <div class="card-header" onclick="toggleCard('${id}')">
        <div class="card-left">
          <span class="type-badge" style="background:var(--accent-glow);color:var(--accent);border:1px solid rgba(88,166,255,0.3)">${escapeHtml(String(code))}</span>
          <span class="card-title">${escapeHtml(String(name))}${titleRemarkInfo}</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">(${escapeHtml(String(pic))})</span>
          ${roomVal && roomVal !== '—' ? roomInfo.roomBadgeHtml : ''}
          ${remarkBadge}
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="type-badge" style="background:var(--green-bg);color:var(--green);border:1px solid rgba(63,185,80,0.3);text-transform:none;display:inline-flex;align-items:center;gap:4px">👤 ${escapeHtml(String(cardPax))} Pax</span>
          <span class="card-time" style="color:var(--text-secondary)">${escapeHtml(String(checkIn))} → ${escapeHtml(String(checkOut))}</span>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="card-body">
        <table class="row-table" style="margin-top:12px">
          <thead><tr><th>Column</th><th>Value</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="2" style="color:var(--text-muted)">No data</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function toggleCard(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Scroll to Top ───────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
  const btn = document.getElementById('scroll-to-top-btn');
  if (btn) {
    if (window.scrollY > 300) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  }
});

function scrollToTop() {
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
}

// ── PWA Installation & Service Worker Registration ─────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('Service Worker registered successfully:', reg.scope))
      .catch((err) => console.error('Service Worker registration failed:', err));
  });
}

let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent the mini-infobar from appearing on mobile
  e.preventDefault();
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  // Update UI notify the user they can install the PWA
  if (installBtn) {
    installBtn.style.display = 'flex';
  }
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    // Show the install prompt
    deferredPrompt.prompt();
    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to the install prompt: ${outcome}`);
    // We've used the prompt, and can't use it again
    deferredPrompt = null;
    // Hide the install button
    installBtn.style.display = 'none';
  });
}

window.addEventListener('appinstalled', (evt) => {
  console.log('Sheets Monitor Bot app was successfully installed!');
  if (installBtn) {
    installBtn.style.display = 'none';
  }
  showToast('🎉 App installed successfully!');
});

// ── Privacy & Security Notice Modal Logic ─────────────────────────────
const AUTH_NOTICE_KEY = 'privacy_auth_notice_aug21';

function openAuthNoticeModal() {
  const backdrop = document.getElementById('auth-notice-backdrop');
  if (backdrop) {
    backdrop.classList.add('visible');
  }
}

function dismissAuthNoticeModal() {
  localStorage.setItem(AUTH_NOTICE_KEY, 'true');
  closeAuthNoticeModalTemporarily();
  if (typeof showToast === 'function') {
    showToast('👍 Notice acknowledged! You can re-open it anytime from the top header.');
  }
}

function closeAuthNoticeModalTemporarily() {
  const backdrop = document.getElementById('auth-notice-backdrop');
  if (backdrop) {
    backdrop.classList.remove('visible');
  }
}

function handleBackdropClick(event) {
  if (event.target.id === 'auth-notice-backdrop') {
    closeAuthNoticeModalTemporarily();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAuthNoticeModalTemporarily();
  }
});

// Automatically show popup on first visit if not dismissed yet
window.addEventListener('DOMContentLoaded', () => {
  const isDismissed = localStorage.getItem(AUTH_NOTICE_KEY);
  if (!isDismissed) {
    setTimeout(openAuthNoticeModal, 400);
  }
});

// ── Auto-refresh every 2 minutes & initial data load ─────────────────────────
loadData();
setInterval(loadData, 120_000);

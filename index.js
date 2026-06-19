/* ==========================================================================
   LENDER APP - CLIENT PORTAL ENGINE
   Firestore-based auth (ID + PIN document lookup — no Firebase Auth)
   All data sourced from Firestore; no localStorage data fallback.
   ========================================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ─── YOUR FIREBASE CONFIG ────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyC_H3OGktcvRhUsM2g7O_vf4WFQ5ucZ0xw",
  authDomain:        "lovelink-97087.firebaseapp.com",
  projectId:         "lovelink-97087",
  storageBucket:     "lovelink-97087.firebasestorage.app",
  messagingSenderId: "962378928673",
  appId:             "1:962378928673:web:aee8799e9f824afa2fc960"
};
// ─────────────────────────────────────────────────────────────────────────────

const firebaseApp = initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);

// ── Firestore collection references ──────────────────────────────────────────
const usersCol        = collection(db, 'users');
const loansCol        = collection(db, 'loans');
const repaymentsCol   = collection(db, 'repayments');
const loanTypesCol    = collection(db, 'loanTypes');
const loanAppsCol     = collection(db, 'loanApplications');

// ── In-memory cache refreshed by real-time listeners ─────────────────────────
const cache = {
  currentUser:      null,      // { id, name, phone, nationalId, pin, limit, dateAdded }
  loans:            [],
  repayments:       [],
  loanTypes:        [],
  loanApplications: [],
  settings: { theme: 'light', font: 'sans', scale: 'medium' }
};

// ── Session: stored in sessionStorage (tab-scoped, survives JS reloads, clears on tab close) ──
const SESSION_KEY = 'lender_client_session';

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; }
}
function saveSession(userId) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId }));
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ── Unsub handles ─────────────────────────────────────────────────────────────
let unsubLoans = null, unsubRepayments = null;
let unsubLoanTypes = null, unsubLoanApps = null;

// =============================================================================
// DOMContentLoaded
// =============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Load UI settings (localStorage — appearance prefs only)
  const savedSettings = localStorage.getItem('lender_client_ui_settings');
  if (savedSettings) {
    try { Object.assign(cache.settings, JSON.parse(savedSettings)); } catch (_) {}
  }

  applyTheme(cache.settings.theme || 'light', true);
  applyFont(cache.settings.font || 'sans');
  applyScale(cache.settings.scale || 'medium');

  // Wire appearance controls
  document.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyTheme(btn.getAttribute('data-set-theme'));
    });
  });

  const fontSelectEl = document.getElementById('font-select');
  if (fontSelectEl) fontSelectEl.addEventListener('change', e => applyFont(e.target.value));

  document.querySelectorAll('[data-scale]').forEach(btn => {
    btn.addEventListener('click', () => applyScale(btn.getAttribute('data-scale')));
  });

  document.getElementById('client-settings-trigger')?.addEventListener('click', openGlobalSettings);
  document.getElementById('btn-close-global-settings')?.addEventListener('click', () => {
    document.getElementById('global-settings-modal').style.display = 'none';
    showToast('Style changes applied successfully.', 'success');
  });

  // Toggle PIN eye
  document.querySelectorAll('.toggle-pin-visibility').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.parentNode.querySelector('input');
      const icon  = btn.querySelector('i');
      if (!input || !icon) return;
      const type = input.getAttribute('type') === 'password' ? 'text' : 'password';
      input.setAttribute('type', type);
      icon.setAttribute('data-lucide', type === 'password' ? 'eye' : 'eye-off');
      lucide.createIcons();
    });
  });

  // Nav
  document.querySelectorAll('#client-container .nav-link').forEach(link => {
    link.addEventListener('click', () => switchView(link.getAttribute('data-target-view')));
  });

  // Logout
  document.querySelectorAll('.quick-logout').forEach(btn => {
    btn.addEventListener('click', () => {
      teardownListeners();
      cache.currentUser      = null;
      cache.loans            = [];
      cache.repayments       = [];
      cache.loanApplications = [];
      clearSession();
      applyTheme('light', true);
      showLoginScreen();
      showToast('Successfully signed out.', 'info');
    });
  });

  // Repay type toggle
  document.querySelectorAll('input[name="client-repay-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (clientRepaySelect?.value) {
        const loan = cache.loans.find(l => l.id === clientRepaySelect.value);
        if (loan) togglePartialAmountField(loan.remainingAmount);
      }
    });
  });

  // Form wiring
  wireLoginForm();
  wireLoanApplicationForm();
  wireRepaymentForm();
  wireChangePinForm();
  wireSettingsToggles();

  // Check for an existing session
  const session = loadSession();
  if (session?.userId) {
    const userSnap = await getDoc(doc(db, 'users', session.userId));
    if (userSnap.exists()) {
      await resumeSession(userSnap.data());
    } else {
      clearSession();
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }

}); // end DOMContentLoaded


// =============================================================================
// AUTH HELPERS
// =============================================================================
function showLoginScreen() {
  document.getElementById('auth-container').classList.add('active');
  document.getElementById('client-container').classList.remove('active');
  document.getElementById('client-login-form')?.reset();
}

async function resumeSession(userData) {
  cache.currentUser = userData;
  saveSession(userData.id);
  await setupListeners(userData.id);
  showClientPortal(userData);
}

function showClientPortal(userData) {
  document.getElementById('auth-container').classList.remove('active');
  document.getElementById('client-container').classList.add('active');
  document.getElementById('client-display-name').textContent = userData.name || `ID ${userData.id}`;
  showToast(`Welcome back, ${userData.name || userData.id}.`, 'success');
  switchView('client-view-home');
}


// =============================================================================
// FIRESTORE LISTENERS (scoped to logged-in user's data)
// =============================================================================
async function setupListeners(userId) {
  teardownListeners();

  // Loan types (global — no userId filter)
  unsubLoanTypes = onSnapshot(loanTypesCol, snap => {
    cache.loanTypes = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
    refreshCurrentView();
  });

  // User's loans
  unsubLoans = onSnapshot(
    query(loansCol, where('customerId', '==', userId)),
    snap => {
      cache.loans = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
      runOverdueCheck(userId);
      refreshCurrentView();
    }
  );

  // User's repayments
  unsubRepayments = onSnapshot(
    query(repaymentsCol, where('customerId', '==', userId)),
    snap => {
      cache.repayments = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
      refreshCurrentView();
    }
  );

  // User's loan applications
  unsubLoanApps = onSnapshot(
    query(loanAppsCol, where('customerId', '==', userId)),
    snap => {
      cache.loanApplications = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
      refreshCurrentView();
    }
  );
}

function teardownListeners() {
  [unsubLoans, unsubRepayments, unsubLoanTypes, unsubLoanApps].forEach(fn => fn && fn());
  unsubLoans = unsubRepayments = unsubLoanTypes = unsubLoanApps = null;
}


// =============================================================================
// OVERDUE CHECK
// =============================================================================
async function runOverdueCheck(userId) {
  const now   = Date.now();
  const batch = writeBatch(db);
  let changed = false;

  cache.loans.forEach(loan => {
    if (loan.status === 'active' && loan.remainingAmount > 0 && loan.dueDate < now) {
      batch.update(doc(db, 'loans', loan.id), { status: 'overdue' });
      changed = true;
    }
  });

  if (changed) {
    try { await batch.commit(); } catch (_) {}
  }
}


// =============================================================================
// LOGIN FORM  (ID + PIN against Firestore users collection)
// =============================================================================
function wireLoginForm() {
  const form = document.getElementById('client-login-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const enteredId  = document.getElementById('login-id').value.trim();
    const enteredPin = document.getElementById('login-pin').value;

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Verifying…';

    try {
      const userSnap = await getDoc(doc(db, 'users', enteredId));

      if (!userSnap.exists()) {
        showToast('Invalid National ID or PIN. Please try again.', 'error');
        return;
      }

      const userData = userSnap.data();

      if (userData.pin !== enteredPin) {
        showToast('Invalid National ID or PIN. Please try again.', 'error');
        return;
      }

      // Check optional mock security (stored per-user in Firestore user doc or settings sub-collection)
      const isBio   = userData.settings?.biometrics === true;
      const isTwofa = userData.settings?.twofa === true;

      if (isBio && isTwofa) {
        runBiometricsSimulation(() => runTwoFactorSimulation(() => finishLogin(userData)));
      } else if (isBio) {
        runBiometricsSimulation(() => finishLogin(userData));
      } else if (isTwofa) {
        runTwoFactorSimulation(() => finishLogin(userData));
      } else {
        await finishLogin(userData);
      }

    } catch (err) {
      showToast('Login error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Sign In Securely';
    }
  });
}

async function finishLogin(userData) {
  cache.currentUser = userData;
  await resumeSession(userData);
}


// =============================================================================
// MOCK SECURITY SIMULATORS
// =============================================================================
function runBiometricsSimulation(onComplete) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">Simulating Biometric scan</div>
      <div class="modal-desc">Please look at your camera or place your fingerprint on the sensor.</div>
      <div class="biometric-scanner"><i data-lucide="scan-face"></i></div>
      <button class="btn btn-block btn-primary" id="btn-cancel-bio">Bypass / Match</button>
    </div>`;
  document.body.appendChild(overlay);
  if (typeof lucide !== 'undefined') lucide.createIcons();

  const scanBtn = document.getElementById('btn-cancel-bio');
  let timeout = setTimeout(() => {
    overlay.querySelector('.modal-title').textContent = 'Biometric Authenticated';
    overlay.querySelector('.biometric-scanner').style.color = 'var(--color-success)';
    overlay.querySelector('.biometric-scanner').innerHTML = '<i data-lucide="check"></i>';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(() => { overlay.remove(); onComplete(); }, 1000);
  }, 2000);

  scanBtn.addEventListener('click', () => { clearTimeout(timeout); overlay.remove(); onComplete(); });
}

function runTwoFactorSimulation(onComplete) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">Mock 2-Factor Authentication</div>
      <div class="modal-desc">We sent an SMS OTP code to your verification phone.</div>
      <div style="font-size:12px;color:var(--text-secondary);">Hint: Use simulator code <code>9944</code></div>
      <input type="text" class="otp-input-field" id="twofa-code-input" maxlength="4" placeholder="0000">
      <div class="modal-footer">
        <button class="btn btn-block" style="border:1px solid var(--border-color);" id="btn-cancel-2fa">Cancel</button>
        <button class="btn btn-block btn-primary" id="btn-verify-2fa">Verify OTP</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input     = document.getElementById('twofa-code-input');
  const verifyBtn = document.getElementById('btn-verify-2fa');
  const cancelBtn = document.getElementById('btn-cancel-2fa');

  input.focus();
  verifyBtn.addEventListener('click', () => {
    if (input.value === '9944') { overlay.remove(); onComplete(); }
    else showToast('Invalid OTP code. Use: 9944', 'error');
  });
  cancelBtn.addEventListener('click', () => { overlay.remove(); showToast('2FA cancelled', 'error'); });
  input.addEventListener('keyup', e => { if (e.key === 'Enter') verifyBtn.click(); });
}


// =============================================================================
// VIEW ROUTING
// =============================================================================
let currentViewId = 'client-view-home';

function switchView(targetViewId) {
  currentViewId = targetViewId;
  document.querySelectorAll('#client-container .app-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('#client-container .nav-link').forEach(l => l.classList.remove('active'));

  const target = document.getElementById(targetViewId);
  if (target) target.classList.add('active');

  const link = document.querySelector(`#client-container [data-target-view="${targetViewId}"]`);
  if (link) link.classList.add('active');

  renderClientView(targetViewId);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function refreshCurrentView() {
  if (document.getElementById('client-container')?.classList.contains('active') && cache.currentUser) {
    renderClientView(currentViewId);
  }
}

function renderClientView(viewId) {
  if (!cache.currentUser) return;
  const clientId = cache.currentUser.id;

  if (viewId === 'client-view-home') {
    renderClientHome(clientId);
  } else if (viewId === 'client-view-loans') {
    populateLoanTypeDropdown();
    renderClientLoansLedger(clientId);
    updateClientLoanEstimations();
  } else if (viewId === 'client-view-repayment') {
    renderClientRepaymentForm(clientId);
  } else if (viewId === 'client-view-settings') {
    renderClientSettingsView();
  }
}


// =============================================================================
// HOME VIEW
// =============================================================================
function renderClientHome(clientId) {
  const activeLoans = getClientActiveLoans(clientId);
  let totalDebt = 0;
  activeLoans.forEach(l => totalDebt += l.remainingAmount || 0);

  const limit          = cache.currentUser?.limit || 10000;
  const availableLimit = Math.max(0, limit - totalDebt);

  document.getElementById('client-metric-active-debt').textContent  = formatCurrency(totalDebt);
  document.getElementById('client-metric-loans-count').textContent  = `${activeLoans.length} Active Loan${activeLoans.length === 1 ? '' : 's'}`;
  document.getElementById('client-metric-loan-limit').textContent   = formatCurrency(availableLimit);

  const nextDueEl  = document.getElementById('client-metric-next-due');
  const dueDateEl  = document.getElementById('client-metric-due-date');

  if (activeLoans.length > 0) {
    const soonest = [...activeLoans].sort((a, b) => a.dueDate - b.dueDate)[0];
    nextDueEl.textContent = formatCurrency(soonest.remainingAmount);
    dueDateEl.textContent = `Due date: ${formatDate(soonest.dueDate)}`;
  } else {
    nextDueEl.textContent = formatCurrency(0);
    dueDateEl.textContent = 'No repayment pending';
  }

  renderClientProgressRing(clientId);
  renderClientTransactionsFeed(clientId);
}

function getClientActiveLoans(clientId) {
  return cache.loans.filter(l => l.customerId === clientId && (l.status === 'active' || l.status === 'overdue'));
}

function renderClientProgressRing(clientId) {
  const clientLoans = cache.loans.filter(l => l.customerId === clientId);
  let totalBilled = 0, totalUnpaid = 0;
  clientLoans.forEach(l => { totalBilled += l.totalRepayable || 0; totalUnpaid += l.remainingAmount || 0; });

  const totalPaid       = totalBilled - totalUnpaid;
  const progressPercent = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 100) : 0;

  document.getElementById('client-progress-percent').textContent    = `${progressPercent}%`;
  document.getElementById('client-progress-paid-amt').textContent   = formatCurrency(totalPaid);
  document.getElementById('client-progress-total-amt').textContent  = formatCurrency(totalBilled);

  const circle = document.getElementById('client-repayment-progress-ring');
  if (circle) {
    const r = circle.r.baseVal.value;
    const c = r * 2 * Math.PI;
    circle.style.strokeDasharray  = `${c} ${c}`;
    circle.style.strokeDashoffset = c - (progressPercent / 100) * c;
  }
}

function renderClientTransactionsFeed(clientId) {
  const list = document.getElementById('client-dashboard-transactions');
  if (!list) return;

  const loans      = cache.loans.filter(l => l.customerId === clientId);
  const repayments = cache.repayments.filter(r => r.customerId === clientId);

  const feed = [];
  loans.forEach(l => feed.push({
    type: 'disburse',
    title: `Loan Disbursed - ${(l.purpose || 'general').toUpperCase()}`,
    amount: l.amount, date: tsToMs(l.dateCreated), status: l.status
  }));
  repayments.forEach(r => feed.push({
    type: 'repay', title: 'Repayment Received',
    amount: r.amount, date: tsToMs(r.timestamp), status: 'settled'
  }));

  feed.sort((a, b) => b.date - a.date);

  if (feed.length === 0) {
    list.innerHTML = `<div class="empty-state"><i data-lucide="clipboard-list"></i><p>No recent activity detected.</p></div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  list.innerHTML = feed.slice(0, 5).map(tx => {
    const isDisburse = tx.type === 'disburse';
    const badgeClass = tx.status === 'paid' || tx.status === 'settled' ? 'settled' : (tx.status === 'overdue' ? 'text-danger' : 'active');
    const badgeText  = tx.status === 'active' ? 'Outstanding' : (tx.status === 'paid' ? 'Paid Off' : (tx.status === 'overdue' ? 'Overdue' : 'Received'));
    return `
      <div class="transaction-item">
        <div class="tx-left">
          <div class="tx-icon-badge ${isDisburse ? 'disburse' : 'repay'}">
            <i data-lucide="${isDisburse ? 'arrow-down-left' : 'arrow-up-right'}"></i>
          </div>
          <div class="tx-details">
            <span class="tx-purpose">${tx.title}</span>
            <span class="tx-date">${formatDate(tx.date)}</span>
          </div>
        </div>
        <div class="tx-right">
          <span class="tx-amount ${isDisburse ? 'add' : 'sub'}">${isDisburse ? '+' : '-'}${formatCurrency(tx.amount)}</span>
          <span class="tx-status-badge ${badgeClass}">${badgeText}</span>
        </div>
      </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}


// =============================================================================
// LOANS VIEW
// =============================================================================
function populateLoanTypeDropdown() {
  const select = document.getElementById('client-loan-type');
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '<option value="" disabled selected>Select a loan type…</option>';
  cache.loanTypes.forEach(lt => {
    const opt       = document.createElement('option');
    opt.value       = lt.id;
    opt.textContent = `${lt.name} — ${lt.term} mo. @ ${lt.interestRate}%`;
    select.appendChild(opt);
  });
  if (prev && cache.loanTypes.find(lt => lt.id === prev)) select.value = prev;
}

function updateClientLoanEstimations() {
  const slider = document.getElementById('client-loan-amount');
  const select = document.getElementById('client-loan-type');
  if (!slider) return;

  const clientId     = cache.currentUser?.id;
  const limit        = cache.currentUser?.limit || 10000;
  const activeLoans  = getClientActiveLoans(clientId);
  let   totalDebt    = 0;
  activeLoans.forEach(l => totalDebt += l.remainingAmount || 0);

  const availableLimit = Math.max(0, limit - totalDebt);
  slider.max = Math.max(500, availableLimit);

  const maxLimitEl = document.getElementById('client-apply-max-limit');
  if (maxLimitEl) maxLimitEl.textContent = formatCurrency(availableLimit);

  const sliderVal = document.getElementById('client-loan-amount-val');
  const amount    = parseFloat(slider.value);
  const lt        = select?.value ? cache.loanTypes.find(l => l.id === select.value) : null;

  if (!lt) {
    if (sliderVal) sliderVal.textContent = formatCurrency(amount);
    document.getElementById('client-sum-principal').textContent = formatCurrency(amount);
    document.getElementById('client-sum-rate').textContent      = '—';
    document.getElementById('client-sum-interest').textContent  = formatCurrency(0);
    document.getElementById('client-sum-total').textContent     = formatCurrency(amount);
    document.getElementById('client-sum-monthly').textContent   = formatCurrency(0);
    const helpEl = document.getElementById('client-loan-type-help');
    if (helpEl) helpEl.textContent = 'Select a loan type to see terms and interest rate.';
    return;
  }

  const rate     = lt.interestRate / 100;
  const interest = amount * rate;
  const total    = amount + interest;
  const monthly  = total / lt.term;

  if (sliderVal) sliderVal.textContent = formatCurrency(amount);
  document.getElementById('client-sum-principal').textContent = formatCurrency(amount);
  document.getElementById('client-sum-rate').textContent      = `${lt.interestRate}%`;
  document.getElementById('client-sum-interest').textContent  = formatCurrency(interest);
  document.getElementById('client-sum-total').textContent     = formatCurrency(total);
  document.getElementById('client-sum-monthly').textContent   = formatCurrency(monthly);

  const helpEl = document.getElementById('client-loan-type-help');
  if (helpEl) helpEl.textContent = `${lt.name}: ${lt.term} months at ${lt.interestRate}% flat interest.${lt.description ? ' ' + lt.description + '.' : ''}`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('client-loan-amount')?.addEventListener('input', updateClientLoanEstimations);
  document.getElementById('client-loan-type')?.addEventListener('change', updateClientLoanEstimations);
});

function wireLoanApplicationForm() {
  const form = document.getElementById('client-loan-application-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId   = cache.currentUser?.id;
    const slider     = document.getElementById('client-loan-amount');
    const typeSelect = document.getElementById('client-loan-type');
    const purpose    = document.getElementById('client-loan-purpose')?.value;

    const activeLoans = getClientActiveLoans(clientId);
    if (activeLoans.length >= 3) {
      showToast('Limit exceeded: You cannot have more than 3 outstanding loans.', 'error');
      return;
    }

    const amount = parseFloat(slider?.value || '0');
    if (amount < 500) { showToast('Borrow amount must be at least KSh 500.', 'error'); return; }

    const lt = typeSelect?.value ? cache.loanTypes.find(l => l.id === typeSelect.value) : null;
    if (!lt) { showToast('Please select a loan type.', 'error'); return; }

    const limit     = cache.currentUser?.limit || 10000;
    let   totalDebt = 0;
    activeLoans.forEach(l => totalDebt += l.remainingAmount || 0);

    if (totalDebt + amount > limit) { showToast('Request over limit: Exceeds your available limit.', 'error'); return; }

    const rate       = lt.interestRate / 100;
    const interest   = amount * rate;
    const total      = amount + interest;
    const newAppId   = 'APP-' + Math.floor(100000 + Math.random() * 900000);

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Submitting…';

    try {
      await setDoc(doc(db, 'loanApplications', newAppId), {
        id:              newAppId,
        customerId:      clientId,
        loanTypeId:      lt.id,
        loanTypeName:    lt.name,
        amount,
        term:            lt.term,
        purpose:         purpose || 'general',
        interestRate:    rate,
        totalRepayable:  total,
        status:          'pending',
        statusReason:    '',
        appliedAt:       Date.now()
      });

      showToast(`Application ${newAppId} submitted! Awaiting admin review.`, 'success');
      form.reset();
      populateLoanTypeDropdown();
      updateClientLoanEstimations();
    } catch (err) {
      showToast('Error submitting application: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Submit Loan Application';
    }
  });
}

function renderClientLoansLedger(clientId) {
  const listBody = document.getElementById('client-loans-history-body');
  if (!listBody) return;

  const userApps = cache.loanApplications.filter(a => a.customerId === clientId);

  if (userApps.length === 0) {
    listBody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4">No loan applications found. Submit your first request above.</td></tr>`;
    return;
  }

  const sorted = [...userApps].sort((a, b) => tsToMs(b.appliedAt) - tsToMs(a.appliedAt));

  listBody.innerHTML = sorted.map(app => {
    const lt       = cache.loanTypes.find(l => l.id === app.loanTypeId);
    const typeName = lt ? lt.name : (app.loanTypeName || 'N/A');

    let statusPill;
    if (app.status === 'approved')
      statusPill = `<span class="status-pill paid">Approved</span>`;
    else if (app.status === 'declined')
      statusPill = `<span class="status-pill" style="background:rgba(239,68,68,0.1);color:var(--danger-color);">Declined</span>`;
    else
      statusPill = `<span class="status-pill" style="background:rgba(234,179,8,0.1);color:#b45309;">Pending Review</span>`;

    const reason = app.statusReason || (app.status === 'pending' ? 'Awaiting admin review' : '—');

    return `
      <tr>
        <td class="font-mono"><strong>${app.id}</strong></td>
        <td>${typeName}</td>
        <td>${formatCurrency(app.amount)}</td>
        <td><span class="tx-status-badge">${(app.purpose || 'General').toUpperCase()}</span></td>
        <td>${(app.interestRate * 100).toFixed(1)}%</td>
        <td><strong>${formatCurrency(app.totalRepayable)}</strong></td>
        <td>${app.term} Months</td>
        <td>${formatCurrency(app.totalRepayable)}</td>
        <td>${statusPill}</td>
        <td style="max-width:160px;font-size:0.8em;color:var(--text-secondary);">${reason}</td>
      </tr>`;
  }).join('');
}


// =============================================================================
// REPAYMENT VIEW
// =============================================================================
const clientRepaySelect = document.createElement('_placeholder');  // resolved via DOM
let _clientRepaySelect, _clientRepayAmt, _clientRepaySubmitBtn, _clientRepayMaxHelp;

document.addEventListener('DOMContentLoaded', () => {
  _clientRepaySelect    = document.getElementById('client-repay-loan-select');
  _clientRepayAmt       = document.getElementById('client-repay-amount');
  _clientRepaySubmitBtn = document.getElementById('client-btn-submit-repay');
  _clientRepayMaxHelp   = document.getElementById('client-repay-max-help');

  if (_clientRepaySelect) {
    _clientRepaySelect.addEventListener('change', () => {
      const loan = cache.loans.find(l => l.id === _clientRepaySelect.value);
      if (loan) {
        if (_clientRepayMaxHelp) _clientRepayMaxHelp.textContent = `Outstanding balance: ${formatCurrency(loan.remainingAmount)} — due ${formatDate(loan.dueDate)}`;
        if (_clientRepayAmt) { _clientRepayAmt.value = loan.remainingAmount.toFixed(2); _clientRepayAmt.max = loan.remainingAmount; }
        if (_clientRepaySubmitBtn) _clientRepaySubmitBtn.disabled = false;

        const fullRadio = document.querySelector('input[name="client-repay-type"][value="full"]');
        if (fullRadio) fullRadio.checked = true;
        togglePartialAmountField(loan.remainingAmount);
      } else {
        if (_clientRepaySubmitBtn) _clientRepaySubmitBtn.disabled = true;
      }
    });
  }
});

function renderClientRepaymentForm(clientId) {
  if (!_clientRepaySelect) {
    _clientRepaySelect    = document.getElementById('client-repay-loan-select');
    _clientRepayAmt       = document.getElementById('client-repay-amount');
    _clientRepaySubmitBtn = document.getElementById('client-btn-submit-repay');
    _clientRepayMaxHelp   = document.getElementById('client-repay-max-help');
  }
  if (!_clientRepaySelect) return;

  const activeLoans = getClientActiveLoans(clientId);
  _clientRepaySelect.innerHTML = '<option value="" disabled selected>Choose a loan to pay…</option>';
  activeLoans.forEach(l => {
    const opt       = document.createElement('option');
    opt.value       = l.id;
    opt.textContent = `${l.id} — ${formatCurrency(l.remainingAmount)} outstanding (due ${formatDate(l.dueDate)})`;
    _clientRepaySelect.appendChild(opt);
  });

  if (_clientRepayMaxHelp)   _clientRepayMaxHelp.textContent = 'Select a loan to see your outstanding balance.';
  if (_clientRepaySubmitBtn) _clientRepaySubmitBtn.disabled  = true;

  const fullRadio = document.querySelector('input[name="client-repay-type"][value="full"]');
  if (fullRadio) fullRadio.checked = true;
  const partialRow = document.getElementById('client-partial-amount-row');
  if (partialRow) partialRow.style.display = 'none';

  renderClientRepaymentsLog(clientId);
}

function togglePartialAmountField(fullBalance) {
  const partialRow   = document.getElementById('client-partial-amount-row');
  const selectedType = document.querySelector('input[name="client-repay-type"]:checked')?.value;
  if (!partialRow) return;

  if (selectedType === 'partial') {
    partialRow.style.display = 'block';
    const current = parseFloat(_clientRepayAmt?.value || '');
    if (isNaN(current) || current <= 0 || current >= fullBalance) {
      if (_clientRepayAmt) _clientRepayAmt.value = '';
    }
    if (_clientRepayAmt) { _clientRepayAmt.max = fullBalance - 0.01; _clientRepayAmt.placeholder = `Enter amount (max ${formatCurrency(fullBalance - 0.01)})`; }
  } else {
    partialRow.style.display = 'none';
    if (_clientRepaySelect?.value) {
      const loan = cache.loans.find(l => l.id === _clientRepaySelect.value);
      if (loan && _clientRepayAmt) { _clientRepayAmt.value = loan.remainingAmount.toFixed(2); _clientRepayAmt.max = loan.remainingAmount; }
    }
  }
}

function wireRepaymentForm() {
  const form = document.getElementById('client-repayment-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId = cache.currentUser?.id;
    const loanId   = _clientRepaySelect?.value;
    const loan     = cache.loans.find(l => l.id === loanId && l.customerId === clientId);
    if (!loan) return;

    const repayType = document.querySelector('input[name="client-repay-type"]:checked')?.value || 'full';
    let amount;

    if (repayType === 'full') {
      amount = loan.remainingAmount;
    } else {
      amount = parseFloat(_clientRepayAmt?.value || '');
      if (isNaN(amount) || amount <= 0) { showToast('Please enter a valid partial amount.', 'error'); return; }
      if (amount >= loan.remainingAmount) { showToast('Partial amount must be less than the full balance.', 'error'); return; }
    }

    if (_clientRepaySubmitBtn) {
      _clientRepaySubmitBtn.disabled = true;
      _clientRepaySubmitBtn.querySelector('span').textContent = 'Processing payment…';
    }

    try {
      const newRemaining = Math.max(0, loan.remainingAmount - amount);
      const newStatus    = newRemaining <= 0.01 ? 'paid' : loan.status;
      const repId        = 'R-' + Math.floor(100000 + Math.random() * 900000);
      const method       = document.querySelector('input[name="client-pay-method"]:checked')?.value || 'wallet';

      const batch = writeBatch(db);
      batch.update(doc(db, 'loans', loanId), {
        remainingAmount: newRemaining <= 0.01 ? 0 : newRemaining,
        status: newStatus
      });
      batch.set(doc(db, 'repayments', repId), {
        id: repId, loanId, customerId: clientId, amount,
        type: repayType, method, timestamp: Date.now()
      });
      await batch.commit();

      const typeLabel = repayType === 'full' ? 'Full payment' : 'Partial payment';
      showToast(`${typeLabel} of ${formatCurrency(amount)} recorded successfully!`, 'success');
      renderClientRepaymentForm(clientId);
    } catch (err) {
      showToast('Error recording payment: ' + err.message, 'error');
    } finally {
      if (_clientRepaySubmitBtn) {
        _clientRepaySubmitBtn.disabled = false;
        _clientRepaySubmitBtn.querySelector('span').textContent = 'Process Repayment';
      }
    }
  });
}

function renderClientRepaymentsLog(clientId) {
  const list = document.getElementById('client-repayments-log-list');
  if (!list) return;

  const collections = cache.repayments.filter(r => r.customerId === clientId);

  if (collections.length === 0) {
    list.innerHTML = `<div class="empty-state"><i data-lucide="history"></i><p>No repayments logged yet.</p></div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  const sorted = [...collections].sort((a, b) => tsToMs(b.timestamp) - tsToMs(a.timestamp));
  list.innerHTML = sorted.map(rep => `
    <div class="repay-log-item">
      <div class="repay-log-details">
        <span class="repay-log-title">Payment for Loan ${rep.loanId}</span>
        <span class="repay-log-meta">${formatDate(rep.timestamp)} • Method: ${(rep.method || '').toUpperCase()}</span>
      </div>
      <span class="repay-log-amount">+${formatCurrency(rep.amount)}</span>
    </div>`).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}


// =============================================================================
// SETTINGS VIEW
// =============================================================================
function renderClientSettingsView() {
  const userData = cache.currentUser;
  document.getElementById('client-change-pin-form')?.reset();

  const bio   = document.getElementById('client-setting-biometrics');
  const twofa = document.getElementById('client-setting-2fa');
  if (bio)   bio.checked   = userData?.settings?.biometrics === true;
  if (twofa) twofa.checked = userData?.settings?.twofa === true;
}

function wireSettingsToggles() {
  document.getElementById('client-setting-biometrics')?.addEventListener('change', async (e) => {
    const clientId = cache.currentUser?.id;
    if (!clientId) return;
    try {
      await updateDoc(doc(db, 'users', clientId), { 'settings.biometrics': e.target.checked });
      if (cache.currentUser) { if (!cache.currentUser.settings) cache.currentUser.settings = {}; cache.currentUser.settings.biometrics = e.target.checked; }
      showToast(`Biometrics scanning is now ${e.target.checked ? 'ENABLED' : 'DISABLED'}`, 'info');
    } catch (err) { showToast('Error saving setting: ' + err.message, 'error'); }
  });

  document.getElementById('client-setting-2fa')?.addEventListener('change', async (e) => {
    const clientId = cache.currentUser?.id;
    if (!clientId) return;
    try {
      await updateDoc(doc(db, 'users', clientId), { 'settings.twofa': e.target.checked });
      if (cache.currentUser) { if (!cache.currentUser.settings) cache.currentUser.settings = {}; cache.currentUser.settings.twofa = e.target.checked; }
      showToast(`2-Factor SMS OTP is now ${e.target.checked ? 'ENABLED' : 'DISABLED'}`, 'info');
    } catch (err) { showToast('Error saving setting: ' + err.message, 'error'); }
  });
}

function wireChangePinForm() {
  const form = document.getElementById('client-change-pin-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId = cache.currentUser?.id;
    const current  = document.getElementById('client-current-pin').value;
    const fresh    = document.getElementById('client-new-pin').value;
    const confirm  = document.getElementById('client-confirm-pin').value;

    if (cache.currentUser?.pin !== current) { showToast('Invalid PIN: Current Access PIN is incorrect.', 'error'); return; }
    if (fresh.length < 4 || fresh.length > 8 || isNaN(Number(fresh))) { showToast('PIN must be a 4-8 digit numerical code.', 'error'); return; }
    if (fresh !== confirm) { showToast('Validation failed: PIN confirmation does not match.', 'error'); return; }

    try {
      await updateDoc(doc(db, 'users', clientId), { pin: fresh });
      if (cache.currentUser) cache.currentUser.pin = fresh;
      showToast('PIN successfully changed.', 'success');
      form.reset();
    } catch (err) {
      showToast('Error updating PIN: ' + err.message, 'error');
    }
  });
}


// =============================================================================
// TOAST & FORMATTERS
// =============================================================================
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-triangle' : 'info';
  toast.innerHTML = `<i data-lucide="${iconName}" style="width:18px;height:18px;flex-shrink:0;"></i><span>${message}</span>`;
  container.appendChild(toast);
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [toast] });
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function formatCurrency(amount) {
  return 'KSh ' + new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (ts?.toDate) return ts.toDate().getTime();
  return Number(ts);
}


// =============================================================================
// APPEARANCE  (UI prefs — localStorage only, not user data)
// =============================================================================
function saveUISettings() {
  localStorage.setItem('lender_client_ui_settings', JSON.stringify(cache.settings));
}

function applyTheme(theme, silent = false) {
  document.documentElement.setAttribute('data-theme', theme);
  cache.settings.theme = theme;
  saveUISettings();
  document.querySelectorAll('[data-set-theme]').forEach(b => b.classList.toggle('active', b.getAttribute('data-set-theme') === theme));
  if (!silent) showToast(`Theme changed to ${theme.charAt(0).toUpperCase() + theme.slice(1)}`, 'info');
}

function applyFont(font) {
  document.documentElement.setAttribute('data-font', font);
  cache.settings.font = font;
  saveUISettings();
  const el = document.getElementById('font-select');
  if (el) el.value = font;
}

function applyScale(scale) {
  document.documentElement.setAttribute('data-scale', scale);
  cache.settings.scale = scale;
  saveUISettings();
  document.querySelectorAll('[data-scale]').forEach(b => b.classList.toggle('active', b.getAttribute('data-scale') === scale));
}

function openGlobalSettings() {
  const modal = document.getElementById('global-settings-modal');
  if (!modal) return;
  const fs = document.getElementById('font-select');
  if (fs) fs.value = cache.settings.font || 'sans';
  document.querySelectorAll('[data-scale]').forEach(b => b.classList.toggle('active', b.getAttribute('data-scale') === cache.settings.scale));
  modal.style.display = 'flex';
}

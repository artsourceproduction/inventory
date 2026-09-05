// app.js
// Dashboard data loading, clock, nav switching, and (Phase 2B) the
// Ink Receiving screen under Inventory. Print Records, Reports, and
// Settings are still placeholders.

const MODULE_NAMES = {
  'print-records': 'Print Records',
  'reports': 'Reports',
  'settings': 'Settings',
};
const MODULE_PHASE = {
  'print-records': '02',
  'reports': '04',
  'settings': '05',
};

// ---------------- Clock ----------------

function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

// ---------------- Dashboard ----------------

async function loadDashboard() {
  const statusDot = document.getElementById('server-status-dot');
  const statusText = document.getElementById('server-status-text');

  try {
    const { count: projectCount, error: countErr } = await db
      .from('projects').select('*', { count: 'exact', head: true });
    if (countErr) throw countErr;
    document.getElementById('stat-project-count').textContent = projectCount;

    statusDot.classList.add('is-live');
    statusText.textContent = 'Connected to Supabase';
  } catch (err) {
    statusText.textContent = 'Could not reach Supabase';
    console.error(err);
  }
}

// ---------------- Inventory: Ink Receiving (Phase 2B) ----------------

const inventoryState = {
  machines: [],       // [{ id, name, code, inks: [...] }]
  activeMachineId: null,
  loaded: false,
};

async function loadInventoryMachines() {
  const tabsEl = document.getElementById('machine-tabs');
  try {
    const { data: machines, error: mErr } = await db
      .from('machines').select('id, name, code').eq('is_active', true).order('id');
    if (mErr) throw mErr;

    const { data: inks, error: iErr } = await db
      .from('inks').select('id, machine_id, color_name, color_code, unit_of_measure')
      .eq('is_active', true).order('id');
    if (iErr) throw iErr;

    inventoryState.machines = machines.map((m) => ({
      ...m,
      inks: inks.filter((ink) => ink.machine_id === m.id),
    }));
    inventoryState.loaded = true;

    if (!inventoryState.machines.length) {
      tabsEl.innerHTML = '<span class="log-empty">No machines configured.</span>';
      return;
    }

    if (!inventoryState.activeMachineId) {
      inventoryState.activeMachineId = inventoryState.machines[0].id;
    }

    renderMachineTabs();
    populateInkSelect('ink-select');
    populateInkSelect('issue-ink-select');
    loadStock();
    loadBatches();
    loadIssues();
    loadOnMachineStatus();
    loadConsumables();
    loadConsumableStock();
    populateConsumableIssueSelect();
    loadConsumableIssues();
    populateHistoryMachineFilter();
    loadTransactionHistory();
  } catch (err) {
    tabsEl.innerHTML = '<span class="log-empty">Could not load machines.</span>';
    console.error(err);
  }
}

function renderMachineTabs() {
  const tabsEl = document.getElementById('machine-tabs');
  tabsEl.innerHTML = inventoryState.machines
    .map((m) => `<button type="button" class="machine-tab${m.id === inventoryState.activeMachineId ? ' is-active' : ''}" data-machine-id="${m.id}">${m.name}</button>`)
    .join('');

  tabsEl.querySelectorAll('.machine-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      inventoryState.activeMachineId = Number(btn.dataset.machineId);
      renderMachineTabs();
      populateInkSelect('ink-select');
      populateInkSelect('issue-ink-select');
      loadStock();
      loadBatches();
      loadIssues();
      loadOnMachineStatus();
      loadConsumables();
      loadConsumableStock();
      populateConsumableIssueSelect();
      loadConsumableIssues();
      setFormMessage('receiving-message', '', null);
      setFormMessage('issuing-message', '', null);
      setFormMessage('consumable-message', '', null);
      setFormMessage('consumable-issue-message', '', null);
    });
  });
}

function getActiveMachine() {
  return inventoryState.machines.find((m) => m.id === inventoryState.activeMachineId) || null;
}

function populateInkSelect(selectId) {
  const select = document.getElementById(selectId);
  const machine = getActiveMachine();
  const inks = machine ? machine.inks : [];

  select.innerHTML = '<option value="">Select ink…</option>' +
    inks.map((ink) => `<option value="${ink.id}">${ink.color_name}</option>`).join('');
}

async function loadStock() {
  const container = document.getElementById('stock-groups');
  const machine = getActiveMachine();

  container.innerHTML = '<p class="log-empty">Loading…</p>';

  try {
    const inks = machine ? machine.inks : [];
    if (!inks.length) {
      container.innerHTML = '<p class="log-empty">No inks configured.</p>';
      return;
    }
    const inkIds = inks.map((i) => i.id);

    const { data: totals, error: tErr } = await db
      .from('ink_stock').select('ink_id, total_stock').in('ink_id', inkIds);
    if (tErr) throw tErr;

    const { data: batchRows, error: bErr } = await db
      .from('ink_batch_stock')
      .select('ink_id, batch_id, batch_number, received_date, expiry_date, unit, total_received, total_issued, remaining, expiry_status')
      .in('ink_id', inkIds)
      .order('received_date', { ascending: true })
      .order('batch_id', { ascending: true });
    if (bErr) throw bErr;

    const totalsByInk = Object.fromEntries((totals || []).map((t) => [t.ink_id, t.total_stock]));

    container.innerHTML = inks.map((ink) => {
      const batches = (batchRows || [])
        .filter((b) => b.ink_id === ink.id)
        .map((b) => ({ ...b, status: b.remaining <= 0 ? 'depleted' : 'active' }));
      const totalStock = Number(totalsByInk[ink.id] || 0);
      return `
      <div class="stock-group">
        <div class="stock-group-head">
          <span class="stock-ink-name">${ink.color_name}</span>
          <span class="stock-ink-total${totalStock < 2 ? ' low-stock' : ''}">${formatQuantity(totalStock)} ${ink.unit_of_measure}</span>
        </div>
        ${batches.length ? `
        <table class="log-table stock-batch-table">
          <thead>
            <tr><th>Batch</th><th>Received</th><th>Issued</th><th>Remaining</th><th>Expiry</th></tr>
          </thead>
          <tbody>
            ${batches.map((b) => `
              <tr class="${b.status === 'depleted' ? 'is-depleted' : ''}">
                <td>${b.batch_number}</td>
                <td>${formatQuantity(b.total_received)} ${b.unit}</td>
                <td>${formatQuantity(b.total_issued)} ${b.unit}</td>
                <td>${formatQuantity(b.remaining)} ${b.unit}</td>
                <td>${renderExpiryCell(b)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ` : '<p class="log-empty">No batches received yet.</p>'}
      </div>
    `;
    }).join('');
  } catch (err) {
    container.innerHTML = '<p class="log-empty">Could not calculate stock.</p>';
    console.error(err);
  }
}

async function loadBatches() {
  const tbody = document.getElementById('batches-table-body');
  const note = document.getElementById('batches-machine-note');
  const machine = getActiveMachine();
  note.textContent = machine ? machine.name : 'All machines';

  tbody.innerHTML = '<tr><td colspan="5" class="log-empty">Loading…</td></tr>';

  try {
    let query = db
      .from('ink_receipts')
      .select('quantity_received, unit, receipt_date, ink_batches(batch_number, expiry_date), inks!inner(color_name, machine_id)')
      .order('id', { ascending: false })
      .limit(100);
    if (machine) query = query.eq('inks.machine_id', machine.id);

    const { data: rows, error } = await query;
    if (error) throw error;
    const batches = (rows || []).map((r) => ({
      color_name: r.inks.color_name,
      batch_number: r.ink_batches.batch_number,
      quantity: r.quantity_received,
      unit: r.unit,
      received_date: r.receipt_date,
      expiry_date: r.ink_batches.expiry_date,
    }));

    if (!batches.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="log-empty">No batches recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = batches.map((b) => `
      <tr>
        <td>${b.color_name}</td>
        <td>${b.batch_number}</td>
        <td>${formatQuantity(b.quantity)} ${b.unit}</td>
        <td>${b.received_date}</td>
        <td>${b.expiry_date || '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" class="log-empty">Could not load batches.</td></tr>';
    console.error(err);
  }
}

// ---------------- Inventory: Transaction History (Phase 2L) ----------------

const historyState = { order: 'desc' };

function populateHistoryMachineFilter() {
  const select = document.getElementById('history-machine-filter');
  select.innerHTML = '<option value="">All machines</option>' +
    inventoryState.machines.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
}

async function loadTransactionHistory() {
  const tbody = document.getElementById('history-table-body');
  const type = document.getElementById('history-type-filter').value;
  const machineId = document.getElementById('history-machine-filter').value;
  const sort = document.getElementById('history-sort-select').value;

  tbody.innerHTML = '<tr><td colspan="6" class="log-empty">Loading…</td></tr>';

  try {
    const [inkR, inkI, consR, consI] = await Promise.all([
      db.from('ink_receipts').select('receipt_date, quantity_received, unit, ink_batches(expiry_date), inks(color_name, machine_id, machines(name))').limit(500),
      db.from('ink_issues').select('issue_date, quantity_issued, unit, inks(color_name), machines(id, name)').limit(500),
      db.from('consumable_receipts').select('receipt_date, quantity_received, unit, consumables(name, machine_id, machines(name))').limit(500),
      db.from('consumable_issues').select('issue_date, quantity_issued, unit, consumables(name), machines(id, name)').limit(500),
    ]);
    if (inkR.error) throw inkR.error;
    if (inkI.error) throw inkI.error;
    if (consR.error) throw consR.error;
    if (consI.error) throw consI.error;

    let rows = [
      ...(inkR.data || []).map((r) => ({
        date: r.receipt_date, type: 'Ink Receipt', machine_id: r.inks.machine_id,
        machine_name: r.inks.machines.name, item: r.inks.color_name,
        quantity: r.quantity_received, unit: r.unit, expiry_date: r.ink_batches.expiry_date,
      })),
      ...(inkI.data || []).map((r) => ({
        date: r.issue_date, type: 'Ink Issue', machine_id: r.machines.id,
        machine_name: r.machines.name, item: r.inks.color_name,
        quantity: r.quantity_issued, unit: r.unit, expiry_date: null,
      })),
      ...(consR.data || []).map((r) => ({
        date: r.receipt_date, type: 'Consumable Receipt', machine_id: r.consumables.machine_id,
        machine_name: r.consumables.machines.name, item: r.consumables.name,
        quantity: r.quantity_received, unit: r.unit, expiry_date: null,
      })),
      ...(consI.data || []).map((r) => ({
        date: r.issue_date, type: 'Consumable Issue', machine_id: r.machines.id,
        machine_name: r.machines.name, item: r.consumables.name,
        quantity: r.quantity_issued, unit: r.unit, expiry_date: null,
      })),
    ];

    if (type) rows = rows.filter((r) => r.type === type);
    if (machineId) rows = rows.filter((r) => String(r.machine_id) === String(machineId));

    const sortField = sort === 'machine' ? 'machine_name' : sort;
    const dir = historyState.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let av = a[sortField]; let bv = b[sortField];
      if (sortField === 'quantity') { av = Number(av); bv = Number(bv); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="log-empty">No transactions match these filters.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.date}</td>
        <td>${r.type}</td>
        <td>${r.machine_name}</td>
        <td>${r.item}</td>
        <td>${formatQuantity(r.quantity)} ${r.unit}</td>
        <td>${r.expiry_date || '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="log-empty">Could not load transaction history.</td></tr>';
    console.error(err);
  }
}

function initHistoryControls() {
  document.getElementById('history-type-filter').addEventListener('change', loadTransactionHistory);
  document.getElementById('history-machine-filter').addEventListener('change', loadTransactionHistory);
  document.getElementById('history-sort-select').addEventListener('change', loadTransactionHistory);

  const orderToggle = document.getElementById('history-order-toggle');
  orderToggle.addEventListener('click', () => {
    historyState.order = historyState.order === 'desc' ? 'asc' : 'desc';
    orderToggle.textContent = historyState.order === 'desc' ? 'Newest first ↓' : 'Oldest first ↑';
    loadTransactionHistory();
  });
}

async function loadIssues() {
  const tbody = document.getElementById('issues-table-body');
  const note = document.getElementById('issues-machine-note');
  const machine = getActiveMachine();
  note.textContent = machine ? machine.name : 'All machines';

  tbody.innerHTML = '<tr><td colspan="4" class="log-empty">Loading…</td></tr>';

  try {
    let query = db
      .from('ink_issues')
      .select('issue_date, quantity_issued, unit, ink_batches(batch_number), inks(color_name)')
      .order('id', { ascending: false })
      .limit(100);
    if (machine) query = query.eq('machine_id', machine.id);

    const { data: rows, error } = await query;
    if (error) throw error;
    const issues = (rows || []).map((r) => ({
      color_name: r.inks.color_name,
      batch_number: r.ink_batches.batch_number,
      quantity: r.quantity_issued,
      unit: r.unit,
      issue_date: r.issue_date,
    }));

    if (!issues.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="log-empty">No ink issued yet.</td></tr>';
      return;
    }

    tbody.innerHTML = issues.map((i) => `
      <tr>
        <td>${i.color_name}</td>
        <td>${i.batch_number}</td>
        <td>${formatQuantity(i.quantity)} ${i.unit}</td>
        <td>${i.issue_date}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="log-empty">Could not load issue history.</td></tr>';
    console.error(err);
  }
}

const EXPIRY_LABELS = {
  critical: 'Expired',
  red: 'Expires <1mo',
  yellow: 'Expires <2mo',
  normal: 'OK',
};

// expiry_status is only present for batches with remaining stock > 0
// (depleted batches show a plain dash - they're history, not available
// stock, so an expiry warning on them wouldn't mean anything).
function renderExpiryCell(batch) {
  const dateText = batch.expiry_date || '—';
  if (!batch.expiry_status) return dateText;

  const label = EXPIRY_LABELS[batch.expiry_status] || '';
  return `${dateText} <span class="expiry-badge expiry-badge--${batch.expiry_status}">${label}</span>`;
}

async function loadOnMachineStatus() {
  const tbody = document.getElementById('on-machine-table-body');
  const machine = getActiveMachine();

  if (!machine) {
    tbody.innerHTML = '<tr><td colspan="2" class="log-empty">Select a machine.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="2" class="log-empty">Loading…</td></tr>';

  try {
    const { data: rows, error } = await db
      .from('on_machine_ink_status')
      .select('color_name, last_issued_date')
      .eq('machine_id', machine.id)
      .order('ink_id');
    if (error) throw error;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="log-empty">No inks configured.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.color_name}</td>
        <td>${r.last_issued_date ? formatDisplayDate(r.last_issued_date) : 'Not yet issued'}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="2" class="log-empty">Could not load on-machine status.</td></tr>';
    console.error(err);
  }
}

// Only used for the on-machine status panel - other tables in the app
// keep showing raw ISO dates, unchanged.
function formatDisplayDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d).padStart(2, '0')}-${months[m - 1]}-${y}`;
}

async function populateConsumableIssueSelect() {
  const select = document.getElementById('consumable-issue-select');
  const machine = getActiveMachine();
  select.innerHTML = '<option value="">Select consumable…</option>';
  if (!machine) return;

  try {
    const { data: rows, error } = await db
      .from('consumable_stock').select('consumable_id, name').eq('machine_id', machine.id);
    if (error) throw error;
    select.innerHTML += (rows || []).map((r) => `<option value="${r.consumable_id}">${r.name}</option>`).join('');
  } catch (err) {
    console.error(err);
  }
}

async function loadConsumableIssues() {
  const tbody = document.getElementById('consumable-issues-table-body');
  const note = document.getElementById('consumable-issues-machine-note');
  const machine = getActiveMachine();
  note.textContent = machine ? machine.name : 'All machines';

  if (!machine) {
    tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Select a machine.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Loading…</td></tr>';

  try {
    const { data: rows, error } = await db
      .from('consumable_issues')
      .select('issue_date, quantity_issued, unit, consumables(name)')
      .eq('machine_id', machine.id)
      .order('id', { ascending: false })
      .limit(100);
    if (error) throw error;
    const issues = (rows || []).map((r) => ({
      name: r.consumables.name, quantity: r.quantity_issued, unit: r.unit, issue_date: r.issue_date,
    }));

    if (!issues.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="log-empty">No consumables issued yet.</td></tr>';
      return;
    }

    tbody.innerHTML = issues.map((r) => `
      <tr>
        <td>${r.name}</td>
        <td>${formatQuantity(r.quantity)} ${r.unit}</td>
        <td>${r.issue_date}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Could not load issue history.</td></tr>';
    console.error(err);
  }
}

function initConsumableIssueForm() {
  const form = document.getElementById('consumable-issue-form');
  const dateInput = document.getElementById('consumable-issue-date-input');
  dateInput.value = new Date().toISOString().slice(0, 10);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const consumableId = document.getElementById('consumable-issue-select').value;
    const quantity = document.getElementById('consumable-issue-quantity-input').value;
    const issueDate = dateInput.value;

    const clientErrors = [];
    if (!consumableId) clientErrors.push('Select a consumable.');
    if (!quantity || Number(quantity) <= 0) clientErrors.push('Enter a quantity greater than zero.');
    if (!issueDate) clientErrors.push('Enter the date issued.');

    if (clientErrors.length) {
      setFormMessage('consumable-issue-message', clientErrors.join(' '), 'error');
      return;
    }

    const submitBtn = form.querySelector('.btn-primary');
    submitBtn.disabled = true;

    try {
      const { data: consumable } = await db
        .from('consumables').select('name, unit_of_measure').eq('id', consumableId).single();

      const { error } = await db.rpc('issue_consumable', {
        p_consumable_id: Number(consumableId),
        p_quantity: Number(quantity),
        p_issue_date: issueDate,
      });

      if (error) {
        setFormMessage('consumable-issue-message', error.message || 'Could not save.', 'error');
        return;
      }

      setFormMessage('consumable-issue-message', `Issued ${formatQuantity(quantity)} ${consumable ? consumable.unit_of_measure : ''} of ${consumable ? consumable.name : ''}.`, 'success');
      form.reset();
      dateInput.value = new Date().toISOString().slice(0, 10);
      loadConsumableStock();
      loadConsumableIssues();
    } catch (err) {
      setFormMessage('consumable-issue-message', 'Could not reach Supabase.', 'error');
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

async function loadConsumableStock() {
  const tbody = document.getElementById('consumable-stock-table-body');
  const machine = getActiveMachine();

  if (!machine) {
    tbody.innerHTML = '<tr><td colspan="4" class="log-empty">Select a machine.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="4" class="log-empty">Loading…</td></tr>';

  try {
    const { data: rows, error } = await db
      .from('consumable_stock')
      .select('name, unit_of_measure, total_received, total_issued, current_stock')
      .eq('machine_id', machine.id)
      .order('name');
    if (error) throw error;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="log-empty">No consumables received yet.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.name}</td>
        <td>${formatQuantity(r.total_received)} ${r.unit_of_measure}</td>
        <td>${formatQuantity(r.total_issued)} ${r.unit_of_measure}</td>
        <td>${formatQuantity(r.current_stock)} ${r.unit_of_measure}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="log-empty">Could not calculate stock.</td></tr>';
    console.error(err);
  }
}

async function loadConsumables() {
  const tbody = document.getElementById('consumables-table-body');
  const note = document.getElementById('consumables-machine-note');
  const machine = getActiveMachine();
  note.textContent = machine ? machine.name : 'All machines';

  if (!machine) {
    tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Select a machine.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Loading…</td></tr>';

  try {
    const { data: rows, error } = await db
      .from('consumable_receipts')
      .select('quantity_received, unit, receipt_date, consumables!inner(name, machine_id)')
      .eq('consumables.machine_id', machine.id)
      .order('id', { ascending: false })
      .limit(100);
    if (error) throw error;
    const receipts = (rows || []).map((r) => ({
      name: r.consumables.name, quantity: r.quantity_received, unit: r.unit, receipt_date: r.receipt_date,
    }));

    if (!receipts.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="log-empty">No consumables received yet.</td></tr>';
      return;
    }

    tbody.innerHTML = receipts.map((r) => `
      <tr>
        <td>${r.name}</td>
        <td>${formatQuantity(r.quantity)} ${r.unit}</td>
        <td>${r.receipt_date}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Could not load consumables.</td></tr>';
    console.error(err);
  }
}

function initConsumableForm() {
  const form = document.getElementById('consumable-form');
  const dateInput = document.getElementById('consumable-date-input');
  dateInput.value = new Date().toISOString().slice(0, 10);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const machine = getActiveMachine();
    const nameInput = document.getElementById('consumable-name-input');
    const quantityInput = document.getElementById('consumable-quantity-input');
    const name = nameInput.value.trim();
    const quantity = quantityInput.value;
    const receivedDate = dateInput.value;

    const clientErrors = [];
    if (!machine) clientErrors.push('Select a machine.');
    if (!name) clientErrors.push('Enter a consumable name.');
    if (!quantity || Number(quantity) <= 0) clientErrors.push('Enter a quantity greater than zero.');
    if (!receivedDate) clientErrors.push('Enter the date received.');

    if (clientErrors.length) {
      setFormMessage('consumable-message', clientErrors.join(' '), 'error');
      return;
    }

    const submitBtn = form.querySelector('.btn-primary');
    submitBtn.disabled = true;

    try {
      let { data: consumable } = await db
        .from('consumables').select('id, unit_of_measure')
        .eq('machine_id', machine.id).ilike('name', name).maybeSingle();

      if (!consumable) {
        const { data: created, error: createErr } = await db
          .from('consumables').insert({ machine_id: machine.id, name }).select('id, unit_of_measure').single();
        if (createErr) throw createErr;
        consumable = created;
      }

      const { error: receiptErr } = await db.from('consumable_receipts').insert({
        consumable_id: consumable.id,
        quantity_received: Number(quantity),
        unit: consumable.unit_of_measure,
        receipt_date: receivedDate,
      });
      if (receiptErr) throw receiptErr;

      setFormMessage('consumable-message', `Added ${formatQuantity(quantity)} ${consumable.unit_of_measure} of ${name}.`, 'success');
      nameInput.value = '';
      quantityInput.value = '';
      dateInput.value = new Date().toISOString().slice(0, 10);
      loadConsumables();
      loadConsumableStock();
      populateConsumableIssueSelect();
    } catch (err) {
      setFormMessage('consumable-message', err.message || 'Could not reach Supabase.', 'error');
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

async function loadProjectsView() {
  const tbody = document.getElementById('projects-table-body');
  tbody.innerHTML = '<tr><td colspan="10" class="log-empty">Loading…</td></tr>';

  try {
    const { data: projects, error: pErr } = await db.from('projects').select('id, name, client_name').order('name');
    if (pErr) throw pErr;

    const { data: records, error: rErr } = await db
      .from('print_records')
      .select('project_id, quantity, media, printing_date, roll_width, calculated_print_length, calculated_rolls, machines(name)');
    if (rErr) throw rErr;

    if (!projects.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="log-empty">No projects yet.</td></tr>';
      return;
    }

    const SQM_TO_SQFT = 10.7639;

    const rows = projects.map((p) => {
      const jobs = (records || []).filter((r) => r.project_id === p.id);

      const dates = jobs.map((j) => j.printing_date).filter(Boolean).sort();
      const startDate = dates[0] || '—';
      const endDate = dates[dates.length - 1] || '—';

      const machinesUsed = [...new Set(jobs.map((j) => j.machines ? j.machines.name : null).filter(Boolean))];
      const mediaUsed = [...new Set(jobs.map((j) => j.media).filter(Boolean))];
      const totalQuantity = jobs.reduce((sum, j) => sum + Number(j.quantity || 0), 0);

      // Sqft / rolls / length-per-media are only computable for jobs that
      // have a completed roll calculation (calculated_print_length set) -
      // reused directly from print_records, nothing new stored.
      const calcJobs = jobs.filter((j) => j.calculated_print_length != null);
      const totalSqft = calcJobs.reduce((sum, j) => sum + (Number(j.roll_width || 0) * Number(j.calculated_print_length)), 0) * SQM_TO_SQFT;
      const totalRolls = calcJobs.reduce((sum, j) => sum + Number(j.calculated_rolls || 0), 0);

      const lengthByMedia = {};
      calcJobs.forEach((j) => {
        const key = j.media || 'Unspecified';
        lengthByMedia[key] = (lengthByMedia[key] || 0) + Number(j.calculated_print_length);
      });
      const lengthUsedText = Object.entries(lengthByMedia)
        .map(([media, len]) => `${media}: ${formatQuantity(len)} m`)
        .join(', ') || '—';

      return {
        name: p.name, client: p.client_name, startDate, endDate,
        machinesUsed: machinesUsed.join(', ') || '—',
        totalQuantity,
        mediaUsed: mediaUsed.join(', ') || '—',
        totalSqft: calcJobs.length ? formatQuantity(totalSqft) : '—',
        totalRolls: calcJobs.length ? formatQuantity(totalRolls) : '—',
        lengthUsedText,
      };
    });

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.name}</td>
        <td>${r.client}</td>
        <td>${r.startDate}</td>
        <td>${r.endDate}</td>
        <td>${r.machinesUsed}</td>
        <td>${r.totalQuantity}</td>
        <td>${r.mediaUsed}</td>
        <td>${r.totalSqft}</td>
        <td>${r.totalRolls}</td>
        <td>${r.lengthUsedText}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="10" class="log-empty">Could not load projects.</td></tr>';
    console.error(err);
  }
}

function formatQuantity(n) {
  const num = Number(n);
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function setFormMessage(elementId, text, kind) {
  const el = document.getElementById(elementId);
  el.textContent = text;
  el.classList.remove('is-error', 'is-success');
  if (kind === 'error') el.classList.add('is-error');
  if (kind === 'success') el.classList.add('is-success');
}

function initReceivingForm() {
  const form = document.getElementById('receiving-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const inkId = document.getElementById('ink-select').value;
    const quantity = document.getElementById('quantity-input').value;
    const expiry = document.getElementById('expiry-input').value;

    // Client-side validation mirrors the server so the user gets
    // immediate feedback; the server re-checks everything regardless.
    const clientErrors = [];
    if (!inkId) clientErrors.push('Select an ink.');
    if (!quantity || Number(quantity) <= 0) clientErrors.push('Enter a quantity greater than zero.');
    if (!expiry) clientErrors.push('Enter an expiry date.');

    if (clientErrors.length) {
      setFormMessage('receiving-message', clientErrors.join(' '), 'error');
      return;
    }

    const submitBtn = form.querySelector('.btn-primary');
    submitBtn.disabled = true;

    try {
      const { data: ink, error: inkErr } = await db
        .from('inks').select('machine_id, color_name, color_code, unit_of_measure').eq('id', inkId).single();
      if (inkErr) throw inkErr;

      const { count, error: countErr } = await db
        .from('ink_batches').select('*', { count: 'exact', head: true }).eq('ink_id', inkId);
      if (countErr) throw countErr;
      const batchNumber = `${ink.color_code}-${String((count || 0) + 1).padStart(4, '0')}`;
      const today = new Date().toISOString().slice(0, 10);

      const { data: batch, error: batchErr } = await db
        .from('ink_batches')
        .insert({ ink_id: inkId, batch_number: batchNumber, received_date: today, expiry_date: expiry, initial_quantity: Number(quantity), unit: ink.unit_of_measure })
        .select('id').single();
      if (batchErr) throw batchErr;

      const { error: receiptErr } = await db.from('ink_receipts').insert({
        ink_id: inkId, batch_id: batch.id, quantity_received: Number(quantity), unit: ink.unit_of_measure, receipt_date: today,
      });
      if (receiptErr) throw receiptErr;

      setFormMessage('receiving-message', `Added ${formatQuantity(quantity)} ${ink.unit_of_measure} of ${ink.color_name} — batch ${batchNumber}.`, 'success');
      form.reset();
      loadStock();
      loadBatches();
    } catch (err) {
      setFormMessage('receiving-message', err.message || 'Could not reach Supabase.', 'error');
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function initIssuingForm() {
  const form = document.getElementById('issuing-form');
  const dateInput = document.getElementById('issue-date-input');

  // Default to today, but the field stays editable - "Date Issued" is a
  // real input, not an auto-stamped value like receiving's date.
  const today = new Date();
  dateInput.value = today.toISOString().slice(0, 10);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const inkId = document.getElementById('issue-ink-select').value;
    const quantity = document.getElementById('issue-quantity-input').value;
    const issueDate = dateInput.value;

    const clientErrors = [];
    if (!inkId) clientErrors.push('Select an ink.');
    if (!quantity || Number(quantity) <= 0) clientErrors.push('Enter a quantity greater than zero.');
    if (!issueDate) clientErrors.push('Enter the date issued.');

    if (clientErrors.length) {
      setFormMessage('issuing-message', clientErrors.join(' '), 'error');
      return;
    }

    const submitBtn = form.querySelector('.btn-primary');
    submitBtn.disabled = true;

    try {
      const { data: ink } = await db
        .from('inks').select('color_name, unit_of_measure').eq('id', inkId).single();

      const { data: allocations, error } = await db.rpc('issue_ink', {
        p_ink_id: Number(inkId),
        p_quantity: Number(quantity),
        p_issue_date: issueDate,
      });

      if (error) {
        setFormMessage('issuing-message', error.message || 'Could not save.', 'error');
        return;
      }

      const batchCount = (allocations || []).length;
      setFormMessage('issuing-message', `Issued ${formatQuantity(quantity)} ${ink ? ink.unit_of_measure : ''} of ${ink ? ink.color_name : ''} (${batchCount} batch${batchCount > 1 ? 'es' : ''} used).`, 'success');
      form.reset();
      dateInput.value = today.toISOString().slice(0, 10);
      loadStock();
      loadIssues();
      loadOnMachineStatus();
    } catch (err) {
      setFormMessage('issuing-message', 'Could not reach Supabase.', 'error');
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ---------------- Nav / view switching ----------------

const viewHistory = [];
let currentView = null;

function setView(view, opts) {
  opts = opts || {};
  const dashboardView = document.getElementById('view-dashboard');
  const inventoryView = document.getElementById('view-inventory');
  const placeholderView = document.getElementById('view-placeholder');
  const title = document.getElementById('page-title');
  const backBtn = document.getElementById('back-btn');

  if (!opts.isBack && currentView && currentView !== view) {
    viewHistory.push(currentView);
  }
  currentView = view;
  backBtn.classList.toggle('is-hidden', viewHistory.length === 0);

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.view === view);
  });

  dashboardView.classList.add('is-hidden');
  inventoryView.classList.add('is-hidden');
  document.getElementById('view-print-records').classList.add('is-hidden');
  document.getElementById('view-projects').classList.add('is-hidden');
  document.getElementById('view-machine-service').classList.add('is-hidden');
  document.getElementById('view-machine-service-detail').classList.add('is-hidden');
  document.getElementById('view-settings').classList.add('is-hidden');
  placeholderView.classList.add('is-hidden');

  if (view === 'dashboard') {
    dashboardView.classList.remove('is-hidden');
    title.textContent = 'Dashboard';
  } else if (view === 'projects') {
    document.getElementById('view-projects').classList.remove('is-hidden');
    title.textContent = 'Projects';
    loadProjectsView();
  } else if (view === 'inventory') {
    inventoryView.classList.remove('is-hidden');
    title.textContent = 'Inventory';
    if (!inventoryState.loaded) loadInventoryMachines();
  } else if (view === 'print-records') {
    document.getElementById('view-print-records').classList.remove('is-hidden');
    title.textContent = 'Print Records';
    initPrintRecordsView();
  } else if (view === 'machine-service') {
    document.getElementById('view-machine-service').classList.remove('is-hidden');
    title.textContent = 'Machine Service History';
  } else if (view === 'machine-service-detail') {
    document.getElementById('view-machine-service-detail').classList.remove('is-hidden');
    document.getElementById('machine-service-detail-title').textContent = opts.machineName || 'Machine Service History';
    title.textContent = opts.machineName || 'Machine Service History';
    if (opts.machineCode) loadMachineServiceHistory(opts.machineCode);
  } else if (view === 'settings') {
    document.getElementById('view-settings').classList.remove('is-hidden');
    title.textContent = 'Settings';
    renderAccountManagement();
  } else {
    placeholderView.classList.remove('is-hidden');
    title.textContent = MODULE_NAMES[view] || view;
    document.getElementById('placeholder-title').textContent = MODULE_NAMES[view] || view;
    document.getElementById('placeholder-index').textContent = MODULE_PHASE[view] || '';
  }
}

document.getElementById('back-btn').addEventListener('click', () => {
  const prev = viewHistory.pop();
  if (prev) setView(prev, { isBack: true });
});

document.querySelectorAll('.machine-select-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    setView('machine-service-detail', { machineName: btn.dataset.machine, machineCode: btn.dataset.machineCode });
  });
});

const machineServiceState = { currentMachineId: null, currentMachineCode: null };

async function loadMachineServiceHistory(machineCode) {
  const tbody = document.getElementById('service-history-table-body');
  tbody.innerHTML = '<tr><td colspan="5" class="log-empty">Loading…</td></tr>';
  machineServiceState.currentMachineCode = machineCode;

  // Reset the entry form when switching machines - it's one shared form
  // element, so leftover typed values would otherwise carry over to
  // whichever machine is opened next.
  document.getElementById('service-entry-form').reset();
  document.getElementById('service-entry-form').classList.add('is-hidden');
  setFormMessage('add-service-entry-message', '', null);

  try {
    const { data: machine, error: mErr } = await db.from('machines').select('id').eq('code', machineCode).single();
    if (mErr) throw mErr;
    machineServiceState.currentMachineId = machine.id;

    const { data: rows, error } = await db
      .from('machine_service_records')
      .select('started_at, ended_at, description, replaced_parts, engineer_name')
      .eq('machine_id', machine.id)
      .order('started_at', { ascending: false });
    if (error) throw error;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="log-empty">No service records yet for this machine.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${formatDateTime(r.started_at)}</td>
        <td>${formatDateTime(r.ended_at)}</td>
        <td>${r.description}</td>
        <td>${r.replaced_parts || '—'}</td>
        <td>${r.engineer_name}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" class="log-empty">Could not load service history.</td></tr>';
    console.error(err);
  }
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

document.getElementById('add-service-entry-btn').addEventListener('click', () => {
  document.getElementById('service-entry-form').classList.toggle('is-hidden');
});

document.getElementById('export-service-pdf-btn').addEventListener('click', exportServiceHistoryToPDF);

async function exportServiceHistoryToPDF() {
  const btn = document.getElementById('export-service-pdf-btn');
  const machineName = document.getElementById('machine-service-detail-title').textContent;

  if (!machineServiceState.currentMachineId) {
    setFormMessage('add-service-entry-message', 'Could not determine the selected machine.', 'error');
    return;
  }

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Preparing PDF…';

  try {
    const { data: rows, error } = await db
      .from('machine_service_records')
      .select('description, replaced_parts, engineer_name, requested_at, started_at, ended_at')
      .eq('machine_id', machineServiceState.currentMachineId)
      .order('started_at', { ascending: false });
    if (error) throw error;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

    doc.setFontSize(16);
    doc.text('The Art Source — Printing Department', 40, 40);
    doc.setFontSize(13);
    doc.text(`Machine Service History — ${machineName}`, 40, 60);
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(`Generated ${new Date().toLocaleString('en-GB')}`, 40, 76);
    doc.setTextColor(0);

    const body = rows.map((r) => [
      formatDateTime(r.requested_at),
      formatDateTime(r.started_at),
      formatDateTime(r.ended_at),
      r.description || '—',
      r.replaced_parts || '—',
      r.engineer_name || '—',
    ]);

    doc.autoTable({
      startY: 92,
      head: [['Requested', 'Started', 'Ended', 'Service Details', 'Replaced Parts', 'Engineer']],
      body: body.length ? body : [['—', '—', '—', 'No service records for this machine.', '—', '—']],
      styles: { fontSize: 9, cellPadding: 6, valign: 'top' },
      headStyles: { fillColor: [44, 90, 160], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 244, 241] },
      columnStyles: {
        3: { cellWidth: 220 },
        4: { cellWidth: 150 },
      },
    });

    const fileName = `${machineName.replace(/\s+/g, '_')}_service_history.pdf`;
    doc.save(fileName);
  } catch (err) {
    setFormMessage('add-service-entry-message', err.message || 'Could not generate PDF.', 'error');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

document.getElementById('service-entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const description = document.getElementById('se-description').value.trim();
  const replacedParts = document.getElementById('se-replaced-parts').value.trim();
  const engineer = document.getElementById('se-engineer').value.trim();
  const requestedDate = document.getElementById('se-requested-date').value;
  const requestedTime = document.getElementById('se-requested-time').value;
  const startedDate = document.getElementById('se-started-date').value;
  const startedTime = document.getElementById('se-started-time').value;
  const endedDate = document.getElementById('se-ended-date').value;
  const endedTime = document.getElementById('se-ended-time').value;

  const errors = [];
  if (!description) errors.push('Enter service details/description.');
  if (!engineer) errors.push('Enter the engineer who visited.');
  if (!startedDate || !startedTime) errors.push('Enter the date and time service started.');
  if (!endedDate || !endedTime) errors.push('Enter the date and time service ended.');

  const startedAt = startedDate && startedTime ? `${startedDate}T${startedTime}:00` : null;
  const endedAt = endedDate && endedTime ? `${endedDate}T${endedTime}:00` : null;
  if (startedAt && endedAt && endedAt < startedAt) {
    errors.push('Service ended time must not be before service started time.');
  }

  if (errors.length) {
    setFormMessage('add-service-entry-message', errors.join(' '), 'error');
    return;
  }

  if (!machineServiceState.currentMachineId) {
    setFormMessage('add-service-entry-message', 'Could not determine the selected machine.', 'error');
    return;
  }

  const submitBtn = e.target.querySelector('.btn-primary');
  submitBtn.disabled = true;

  try {
    const requestedAt = requestedDate && requestedTime ? `${requestedDate}T${requestedTime}:00` : null;

    const { error } = await db.from('machine_service_records').insert({
      machine_id: machineServiceState.currentMachineId,
      description,
      replaced_parts: replacedParts || null,
      engineer_name: engineer,
      requested_at: requestedAt,
      started_at: startedAt,
      ended_at: endedAt,
    });
    if (error) throw error;

    setFormMessage('add-service-entry-message', 'Service entry saved.', 'success');
    e.target.reset();
    e.target.classList.add('is-hidden');
    if (machineServiceState.currentMachineCode) loadMachineServiceHistory(machineServiceState.currentMachineCode);
  } catch (err) {
    setFormMessage('add-service-entry-message', err.message || 'Could not save entry.', 'error');
    console.error(err);
  } finally {
    submitBtn.disabled = false;
  }
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    setView(item.dataset.view);
  });
});

document.getElementById('projects-card-btn').addEventListener('click', () => setView('projects'));

updateClock();
setInterval(updateClock, 30000);
loadDashboard();
// ---------------- Print Records (Phase 3B) ----------------

const printRecordsState = { initialized: false };

function initPrintRecordsView() {
  if (printRecordsState.initialized) {
    loadPrintRecords();
    return;
  }
  printRecordsState.initialized = true;

  populatePrintRecordMachineSelect();
  populatePrintRecordMachineFilterSelect();
  populatePrintRecordFilterOptions();
  initPrintRecordFilters();
  initPrintRecordSearchAndFilters();
  initPrintRecordDatePicker();

  const form = document.getElementById('print-record-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const payload = {
      project_name: document.getElementById('pr-project-name').value.trim(),
      client_name: document.getElementById('pr-client-name').value.trim(),
      image_name: document.getElementById('pr-image-name').value.trim(),
      machine_id: Number(document.getElementById('pr-machine-select').value),
      media: document.getElementById('pr-media').value.trim(),
      image_width: document.getElementById('pr-image-width').value,
      image_height: document.getElementById('pr-image-height').value,
      quantity: document.getElementById('pr-quantity').value,
      roll_width: document.getElementById('pr-roll-width').value,
      roll_length: document.getElementById('pr-roll-length').value,
      printing_date: document.getElementById('pr-printing-date').value,
      gap_mm: document.getElementById('pr-gap').value,
    };

    const clientErrors = [];
    if (!payload.project_name) clientErrors.push('Enter a project name.');
    if (!payload.client_name) clientErrors.push('Enter a client name.');
    if (!payload.image_name) clientErrors.push('Enter an image name.');
    if (!payload.machine_id) clientErrors.push('Select a machine.');
    if (!payload.media) clientErrors.push('Enter the media.');
    if (!payload.image_width || Number(payload.image_width) <= 0) clientErrors.push('Enter a valid image width.');
    if (!payload.image_height || Number(payload.image_height) <= 0) clientErrors.push('Enter a valid image height.');
    if (!payload.quantity || Number(payload.quantity) <= 0) clientErrors.push('Enter a quantity greater than zero.');
    if (!payload.roll_width || Number(payload.roll_width) <= 0) clientErrors.push('Enter a valid roll width.');
    if (!payload.roll_length || Number(payload.roll_length) <= 0) clientErrors.push('Enter a valid roll length.');
    if (!payload.printing_date) clientErrors.push('Select a printing date.');
    if (payload.gap_mm === '' || Number(payload.gap_mm) < 0) clientErrors.push('Enter a gap of zero or greater.');

    if (clientErrors.length) {
      setFormMessage('print-record-message', clientErrors.join(' '), 'error');
      return;
    }

    const submitBtn = form.querySelector('.btn-primary');
    submitBtn.disabled = true;

    try {
      let { data: project } = await db
        .from('projects').select('id')
        .ilike('name', payload.project_name).ilike('client_name', payload.client_name).maybeSingle();

      if (!project) {
        const { data: created, error: createErr } = await db
          .from('projects').insert({ name: payload.project_name, client_name: payload.client_name }).select('id').single();
        if (createErr) throw createErr;
        project = created;
      }

      const now = new Date();
      const printingTime = now.toTimeString().slice(0, 8);

      // Roll-calculation columns (effective size, images/row, rows,
      // print length, rolls) are filled in automatically by the
      // print_records_before_insert trigger in Supabase - it rejects
      // the insert if the image doesn't fit, same as the old backend.
      const { error: insertErr } = await db.from('print_records').insert({
        project_id: project.id,
        machine_id: payload.machine_id,
        image_name: payload.image_name,
        media: payload.media,
        image_width: Number(payload.image_width),
        image_height: Number(payload.image_height),
        quantity: Number(payload.quantity),
        roll_width: Number(payload.roll_width),
        roll_length: Number(payload.roll_length),
        gap_mm: Number(payload.gap_mm),
        printing_date: payload.printing_date,
        printing_time: printingTime,
      });

      if (insertErr) {
        setFormMessage('print-record-message', insertErr.message || 'Could not save.', 'error');
        return;
      }

      setFormMessage('print-record-message', `Added print record for ${payload.image_name} (${payload.project_name}).`, 'success');
      form.reset();
      document.getElementById('pr-printing-date').value = toDateStr(new Date());
      loadPrintRecords(printRecordsState.lastRange && printRecordsState.lastRange.from, printRecordsState.lastRange && printRecordsState.lastRange.to);
      populatePrintRecordFilterOptions();
    } catch (err) {
      setFormMessage('print-record-message', err.message || 'Could not reach Supabase.', 'error');
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  loadPrintRecords();
}

function initPrintRecordDatePicker() {
  const dateInput = document.getElementById('pr-printing-date');
  const todayBtn = document.getElementById('pr-today-btn');

  dateInput.value = toDateStr(new Date());
  todayBtn.addEventListener('click', () => {
    dateInput.value = toDateStr(new Date());
  });
}

async function populatePrintRecordMachineSelect() {
  const select = document.getElementById('pr-machine-select');
  try {
    const { data: machines, error } = await db.from('machines').select('id, name').eq('is_active', true).order('id');
    if (error) throw error;
    select.innerHTML = '<option value="">Select machine…</option>' +
      machines.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  } catch (err) {
    console.error(err);
  }
}

async function loadPrintRecords(from, to) {
  // Date range comes from the Today/Week/Month/Custom buttons (passed in
  // by initPrintRecordFilters); the other filters are read directly from
  // their own controls so any combination of filters + search can apply
  // together.
  const tbody = document.getElementById('print-records-table-body');
  tbody.innerHTML = '<tr><td colspan="17" class="log-empty">Loading…</td></tr>';

  const search = document.getElementById('pr-search').value.trim();
  const project = document.getElementById('pr-project-filter').value;
  const client = document.getElementById('pr-client-filter').value;
  const machineId = document.getElementById('pr-machine-filter').value;
  const media = document.getElementById('pr-media-filter').value;

  try {
    let query = db
      .from('print_records')
      .select('printing_date, printing_time, image_name, media, image_width, image_height, gap_mm, effective_width_mm, effective_height_mm, roll_width, roll_length, images_per_row, rows_required, calculated_print_length, quantity, calculated_rolls, projects!inner(name, client_name), machines!inner(name)')
      .order('printing_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(200);

    if (from && to) query = query.gte('printing_date', from).lte('printing_date', to);
    if (project) query = query.eq('projects.name', project);
    if (client) query = query.eq('projects.client_name', client);
    if (machineId) query = query.eq('machine_id', machineId);
    if (media) query = query.eq('media', media);

    printRecordsState.lastRange = { from, to };

    const { data, error } = await query;
    if (error) throw error;

    let rows = (data || []).map((r) => ({
      ...r, project_name: r.projects.name, client_name: r.projects.client_name, machine_name: r.machines.name,
    }));

    // Search spans project/client/image name - Supabase can't OR across
    // an embedded table's columns in one request, so it's applied here
    // instead, same combined result as the old backend's SQL OR.
    if (search) {
      const term = search.toLowerCase();
      rows = rows.filter((r) =>
        r.project_name.toLowerCase().includes(term) ||
        r.client_name.toLowerCase().includes(term) ||
        r.image_name.toLowerCase().includes(term)
      );
    }

    renderPrintRecordTotals(rows);

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="17" class="log-empty">No print records match these filters.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.printing_date}</td>
        <td>${r.printing_time}</td>
        <td>${r.project_name}</td>
        <td>${r.client_name}</td>
        <td>${r.image_name}</td>
        <td>${r.machine_name}</td>
        <td>${r.media}</td>
        <td>${formatQuantity(r.image_width)} × ${formatQuantity(r.image_height)} cm</td>
        <td>${r.gap_mm != null ? formatQuantity(r.gap_mm) + ' mm' : '—'}</td>
        <td>${r.effective_width_mm != null ? `${formatQuantity(r.effective_width_mm)} × ${formatQuantity(r.effective_height_mm)} mm` : '—'}</td>
        <td>${formatQuantity(r.roll_width)} m</td>
        <td>${formatQuantity(r.roll_length)} m</td>
        <td>${r.images_per_row != null ? r.images_per_row : '—'}</td>
        <td>${r.rows_required != null ? r.rows_required : '—'}</td>
        <td>${r.calculated_print_length != null ? formatQuantity(r.calculated_print_length) + ' m' : '—'}</td>
        <td>${r.quantity}</td>
        <td>${r.calculated_rolls != null ? formatQuantity(r.calculated_rolls) : '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="17" class="log-empty">Could not load print records.</td></tr>';
    console.error(err);
  }
}

function renderPrintRecordTotals(rows) {
  document.getElementById('pr-total-jobs').textContent = rows.length;

  const totalQty = rows.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
  document.getElementById('pr-total-quantity').textContent = totalQty;

  const rollsRows = rows.filter((r) => r.calculated_rolls != null);
  const totalRolls = rollsRows.reduce((sum, r) => sum + Number(r.calculated_rolls), 0);
  document.getElementById('pr-total-rolls').textContent = rollsRows.length ? formatQuantity(totalRolls) : '—';

  const machinesUsed = [...new Set(rows.map((r) => r.machine_name))];
  document.getElementById('pr-machines-used').textContent = machinesUsed.length ? machinesUsed.join(', ') : '—';
}

async function populatePrintRecordFilterOptions() {
  try {
    const { data: projectRows, error: pErr } = await db.from('projects').select('name, client_name');
    if (pErr) throw pErr;
    const { data: mediaRows, error: mErr } = await db.from('print_records').select('media').not('media', 'is', null);
    if (mErr) throw mErr;

    const projects = [...new Set(projectRows.map((r) => r.name))].sort();
    const clients = [...new Set(projectRows.map((r) => r.client_name))].sort();
    const media = [...new Set(mediaRows.map((r) => r.media).filter(Boolean))].sort();

    const projectSelect = document.getElementById('pr-project-filter');
    projectSelect.innerHTML = '<option value="">All projects</option>' +
      projects.map((p) => `<option value="${p}">${p}</option>`).join('');

    const clientSelect = document.getElementById('pr-client-filter');
    clientSelect.innerHTML = '<option value="">All clients</option>' +
      clients.map((c) => `<option value="${c}">${c}</option>`).join('');

    const mediaSelect = document.getElementById('pr-media-filter');
    mediaSelect.innerHTML = '<option value="">All media</option>' +
      media.map((m) => `<option value="${m}">${m}</option>`).join('');
  } catch (err) {
    console.error(err);
  }
}

async function populatePrintRecordMachineFilterSelect() {
  const select = document.getElementById('pr-machine-filter');
  try {
    const { data: machines, error } = await db.from('machines').select('id, name').eq('is_active', true).order('id');
    if (error) throw error;
    select.innerHTML = '<option value="">All machines</option>' +
      machines.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  } catch (err) {
    console.error(err);
  }
}

function initPrintRecordSearchAndFilters() {
  const reload = () => {
    const { from, to } = printRecordsState.lastRange || {};
    loadPrintRecords(from, to);
  };

  document.getElementById('pr-search').addEventListener('input', debounce(reload, 250));
  document.getElementById('pr-project-filter').addEventListener('change', reload);
  document.getElementById('pr-client-filter').addEventListener('change', reload);
  document.getElementById('pr-machine-filter').addEventListener('change', reload);
  document.getElementById('pr-media-filter').addEventListener('change', reload);

  document.getElementById('pr-clear-filters').addEventListener('click', () => {
    document.getElementById('pr-search').value = '';
    document.getElementById('pr-project-filter').value = '';
    document.getElementById('pr-client-filter').value = '';
    document.getElementById('pr-machine-filter').value = '';
    document.getElementById('pr-media-filter').value = '';
    reload();
  });
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function initPrintRecordFilters() {
  const buttons = document.querySelectorAll('#pr-filters .btn-secondary');
  const customPanel = document.getElementById('pr-custom-range');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');

      const range = btn.dataset.range;
      if (range === 'custom') {
        customPanel.classList.remove('is-hidden');
        return;
      }
      customPanel.classList.add('is-hidden');

      const today = new Date();
      let from, to;

      if (range === 'today') {
        from = to = toDateStr(today);
      } else if (range === 'week') {
        const day = (today.getDay() + 6) % 7; // 0 = Monday
        const monday = new Date(today); monday.setDate(today.getDate() - day);
        const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
        from = toDateStr(monday); to = toDateStr(sunday);
      } else if (range === 'month') {
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        from = toDateStr(first); to = toDateStr(last);
      }

      loadPrintRecords(from, to);
    });
  });

  document.getElementById('pr-apply-custom').addEventListener('click', () => {
    const from = document.getElementById('pr-from-date').value;
    const to = document.getElementById('pr-to-date').value;
    if (!from || !to) return;
    loadPrintRecords(from, to);
  });
}

initReceivingForm();
initIssuingForm();
initConsumableForm();
initConsumableIssueForm();
initHistoryControls();

// ---------------- Auth (Part 3: login + account creation) ----------------

const EDGE_FUNCTION_URL = 'https://cmorisybgmuxhcufnqsz.supabase.co/functions/v1/clever-service';
const authState = { user: null, profile: null };

function applyAuthUI() {
  const loggedIn = !!authState.user;
  const canEdit = authState.profile && authState.profile.role !== 'viewer';
  const isOwnerOrAdmin = authState.profile && (authState.profile.role === 'owner' || authState.profile.role === 'admin');

  document.body.classList.toggle('read-only', !canEdit);
  document.getElementById('login-open-btn').classList.toggle('is-hidden', loggedIn);
  document.getElementById('logged-in-info').classList.toggle('is-hidden', !loggedIn);
  document.getElementById('settings-nav-item').classList.toggle('is-hidden', !isOwnerOrAdmin);

  if (loggedIn) {
    const displayName = (authState.profile && authState.profile.name) || authState.user.email;
    document.getElementById('auth-user-email').textContent = displayName;

    const role = authState.profile ? authState.profile.role : '';
    const showRole = role === 'owner' || role === 'admin';
    document.getElementById('auth-user-role').textContent = showRole ? role : '';
    document.getElementById('auth-user-role-wrap').classList.toggle('is-hidden', !showRole);
  }
}

async function refreshAuthState() {
  // getSession() (not getUser()) - it doesn't error for an anonymous
  // visitor, just returns null. getUser() errors in that normal case,
  // which previously caused problems reacting to it.
  const { data: { session } } = await db.auth.getSession();

  if (!session) {
    authState.user = null;
    authState.profile = null;
    applyAuthUI();
    return;
  }

  authState.user = session.user;
  const { data: profile } = await db.from('profiles').select('role, must_change_password').eq('id', session.user.id).single();
  authState.profile = profile || null;

  if (profile && profile.must_change_password) {
    document.getElementById('set-password-modal').classList.remove('is-hidden');
  }
  applyAuthUI();
}

function initAuth() {
  const loginModal = document.getElementById('login-modal');
  document.getElementById('login-open-btn').addEventListener('click', () => {
    loginModal.classList.remove('is-hidden');
  });
  document.getElementById('login-cancel-btn').addEventListener('click', () => {
    loginModal.classList.add('is-hidden');
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      setFormMessage('login-message', error.message, 'error');
      return;
    }
    setFormMessage('login-message', '', null);
    loginModal.classList.add('is-hidden');
    document.getElementById('login-form').reset();
    await refreshAuthState();
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await db.auth.signOut();
    await refreshAuthState();
  });

  // Triggered either by an invited person's first login, or by a
  // pre-existing account that still has must_change_password = true.
  document.getElementById('set-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('set-name').value.trim();
    const designation = document.getElementById('set-designation').value.trim();
    const p1 = document.getElementById('set-password-1').value;
    const p2 = document.getElementById('set-password-2').value;

    if (!name) {
      setFormMessage('set-password-message', 'Enter your name.', 'error');
      return;
    }
    if (!designation) {
      setFormMessage('set-password-message', 'Enter your designation.', 'error');
      return;
    }
    if (p1 !== p2) {
      setFormMessage('set-password-message', 'Passwords do not match.', 'error');
      return;
    }
    if (p1.length < 6) {
      setFormMessage('set-password-message', 'Password must be at least 6 characters.', 'error');
      return;
    }

    const { error } = await db.auth.updateUser({ password: p1 });
    if (error) {
      setFormMessage('set-password-message', error.message, 'error');
      return;
    }
    await db.from('profiles').update({ name, designation, must_change_password: false }).eq('id', authState.user.id);
    document.getElementById('set-password-modal').classList.add('is-hidden');
    document.getElementById('set-password-form').reset();
    await refreshAuthState();
  });

  document.getElementById('create-account-toggle-btn').addEventListener('click', () => {
    document.getElementById('create-member-form').classList.toggle('is-hidden');
  });

  document.getElementById('account-details-close-btn').addEventListener('click', () => {
    document.getElementById('account-details-modal').classList.add('is-hidden');
  });

  document.getElementById('account-details-remove-btn').addEventListener('click', () => {
    removeMember(accountDetailsState.targetId, accountDetailsState.targetEmail);
  });

  document.getElementById('create-member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('member-email').value.trim();
    const role = authState.profile.role === 'owner' ? document.getElementById('member-role').value : 'user';
    const submitBtn = e.target.querySelector('.btn-primary');
    submitBtn.disabled = true;

    try {
      const { data: { session } } = await db.auth.getSession();
      if (!session) {
        setFormMessage('create-member-message', 'You are not logged in - please log in again.', 'error');
        return;
      }

      // Supabase's gateway expects the anon key on the 'apikey' header
      // for routing/quota purposes, separate from the Authorization
      // bearer token (which identifies the logged-in caller). Missing
      // this header can cause the request to be rejected before it
      // ever reaches the function code.
      const res = await fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ email, role, redirectTo: window.location.origin }),
      });

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        setFormMessage('create-member-message', `Server returned an unreadable response (HTTP ${res.status}). Check the create-member function is deployed and named exactly "create-member".`, 'error');
        return;
      }

      if (!res.ok) {
        setFormMessage('create-member-message', data.error || `Could not create account (HTTP ${res.status}).`, 'error');
        return;
      }
      setFormMessage('create-member-message', `Invited ${email} as ${role}. They'll receive an email to set their password.`, 'success');
      e.target.reset();
      e.target.classList.add('is-hidden');
      loadMembers();
    } catch (err) {
      // Surface the real browser-level error instead of a vague generic
      // message, so the actual cause is visible without opening DevTools.
      setFormMessage('create-member-message', `Request failed: ${err.message}`, 'error');
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  db.auth.onAuthStateChange(() => refreshAuthState());
  refreshAuthState();
}

function renderAccountManagement() {
  const canManage = authState.profile && (authState.profile.role === 'owner' || authState.profile.role === 'admin');
  document.getElementById('not-logged-in-notice').classList.toggle('is-hidden', canManage);
  document.getElementById('account-mgmt-content').classList.toggle('is-hidden', !canManage);
  if (!canManage) return;

  // Only the Owner may choose the role; an Admin can only ever create
  // Users, so the picker is hidden and the form always sends 'user'.
  document.getElementById('member-role-field').classList.toggle('is-hidden', authState.profile.role !== 'owner');

  loadMembers();
}

const REMOVE_FUNCTION_URL = 'https://cmorisybgmuxhcufnqsz.supabase.co/functions/v1/remove-member';

const accountDetailsState = { targetId: null, targetEmail: null };

async function loadMembers() {
  const tbody = document.getElementById('members-table-body');
  tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Loading…</td></tr>';
  try {
    const { data: rows, error } = await db.from('profiles').select('id, name, email, role, managed_by, must_change_password').order('email');
    if (error) throw error;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="log-empty">No members yet.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr data-id="${r.id}" data-name="${r.name || ''}" data-email="${r.email}" data-role="${r.role}" data-managed-by="${r.managed_by || ''}">
        <td>${r.email}</td>
        <td>${r.role}</td>
        <td>${r.must_change_password ? 'Not yet' : 'Yes'}</td>
      </tr>
    `).join('');

    document.querySelectorAll('#members-table-body tr').forEach((row) => {
      row.addEventListener('click', () => openAccountDetails(row.dataset));
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="log-empty">Could not load members.</td></tr>';
    console.error(err);
  }
}

function openAccountDetails(data) {
  accountDetailsState.targetId = data.id;
  accountDetailsState.targetEmail = data.email;

  document.getElementById('ad-name').textContent = data.name || '—';
  document.getElementById('ad-email').textContent = data.email;
  document.getElementById('ad-role').textContent = data.role;
  setFormMessage('account-details-message', '', null);

  const myId = authState.user.id;
  const myRole = authState.profile.role;
  const canRemove = data.id !== myId && data.role !== 'owner' &&
    (myRole === 'owner' || (myRole === 'admin' && data.role === 'user' && data.managedBy === myId));

  document.getElementById('account-details-remove-btn').classList.toggle('is-hidden', !canRemove);
  document.getElementById('account-details-modal').classList.remove('is-hidden');
}

async function removeMember(targetId, email) {
  if (!confirm(`Remove ${email}? This cannot be undone.`)) return;

  try {
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch(REMOVE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ target_id: targetId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormMessage('account-details-message', data.error || `Could not remove account (HTTP ${res.status}).`, 'error');
      return;
    }
    document.getElementById('account-details-modal').classList.add('is-hidden');
    setFormMessage('create-member-message', `Removed ${email}.`, 'success');
    loadMembers();
  } catch (err) {
    setFormMessage('account-details-message', `Request failed: ${err.message}`, 'error');
    console.error(err);
  }
}

initAuth();

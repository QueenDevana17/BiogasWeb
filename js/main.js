// /mnt/data/js/main.js
// Styled charts + Firestore realtime + Alerts for thresholds (temp and pH)
// Timestamp labels formatted to seconds: "YYYY-MM-DD HH:MM:SS" (no milliseconds, no Z)

(function () {
  const log = (...a) => console.log('[biogas-main]', ...a);

  // ALERT CONFIG
  const ALERT_CONFIG = {
    temp: { min: 32.0, max: 40.0 },         // °C
    ph:   { min: 6.8,  max: 8.0 },          // pH
    ALERT_COOLDOWN_MS: 30 * 60 * 1000,      // 30 minutes cooldown
    CARD_FLASH_MS: 5000                     // flash card for 5s
  };

  window.alertState = window.alertState || { lastAlertAt: {} };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  function start() {
    log('DOM ready — initializing styled charts + alerts');
    if (typeof Chart === 'undefined') {
      console.error('Chart.js not found.');
      return;
    }

    // chart defaults
    try {
      Chart.defaults.font.family = 'Nunito, -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
      Chart.defaults.color = '#858796';
    } catch (e) {}

    // --- helpers ---
    function toDate(ts) {
      if (!ts) return new Date();
      if (window.firebaseApp && typeof window.firebaseApp.tsToDate === 'function') return window.firebaseApp.tsToDate(ts);
      if (typeof ts.toDate === 'function') return ts.toDate();
      if (ts.seconds) return new Date(ts.seconds * 1000);
      return new Date(ts);
    }

    // Format to "YYYY-MM-DD HH:MM:SS" (no ms, no Z)
    function isoNoMs(d) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      const hh = String(d.getHours()).padStart(2,'0');
      const min = String(d.getMinutes()).padStart(2,'0');
      const ss = String(d.getSeconds()).padStart(2,'0');
      return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
    }

    // --- create chart factory (styled) ---
    function createStyledLineChart(canvasId, opts = {}) {
      const el = document.getElementById(canvasId);
      if (!el) { log('missing canvas', canvasId); return null; }
      const ctx = el.getContext('2d');
      const backgroundColor = opts.backgroundColor || 'rgba(78,115,223,0.05)';
      const borderColor = opts.borderColor || 'rgba(78,115,223,1)';
      const pointColor = opts.pointColor || borderColor;
      const unit = opts.unit || '';

      const cfg = {
        type: 'line',
        data: { labels: [], datasets: [{ label: '', data: [], fill: true, backgroundColor, borderColor, pointRadius:3, pointBackgroundColor: pointColor, tension: 0.3 }] },
        options: {
          maintainAspectRatio: false,
          // Chart.js v2 compatibility
          legend: { display: false },
          // plugins for v3+
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgb(255,255,255)',
              titleColor: '#6e707e',
              bodyColor: '#858796',
              borderColor: '#dddfeb',
              borderWidth: 1,
              padding: 10,
              displayColors: false,
              mode: 'index',
              intersect: false,
              callbacks: {
                // title: show the full datetime label (our label will be "YYYY-MM-DD HH:MM:SS")
                title: function(context) {
                  if (!context || context.length === 0) return '';
                  return context[0].label || '';
                },
                label: function (context) {
                  const value = context.raw;
                  if (value === null || value === undefined) return '';
                  const str = (Math.abs(value) >= 10) ? Number(value).toFixed(1) : Number(value).toFixed(2);
                  return str + (unit ? ' ' + unit : '');
                }
              }
            }
          },
          scales: {
            x: {
              grid: { display: false, drawBorder: false },
              ticks: {
                autoSkip: true,
                maxRotation: 0,
                callback: function(value) {
                  // underlying label is "YYYY-MM-DD HH:MM:SS" -> show only time "HH:MM:SS"
                  const raw = (this.getLabelForValue) ? this.getLabelForValue(value) : value;
                  if (!raw) return '';
                  const parts = String(raw).split(' ');
                  return parts.length > 1 ? parts[1] : raw;
                }
              }
            },
            y: {
              beginAtZero: true,
              ticks: {
                maxTicksLimit: 5,
                padding: 10,
                callback: function(v) {
                  return String(v) + (unit ? unit : '');
                }
              },
              grid: {
                color: 'rgb(234,236,244)',
                drawBorder: false,
                borderDash: [2],
                zeroLineColor: 'rgb(234,236,244)',
                zeroLineBorderDash: [2]
              }
            }
          }
        }
      };

      return new Chart(ctx, cfg);
    }

    // create charts
    const pHChart  = createStyledLineChart('pHChart',  { backgroundColor: 'rgba(78,115,223,0.05)', borderColor: 'rgba(78,115,223,1)', pointColor: 'rgba(78,115,223,1)', unit: 'pH' });
    const tChart   = createStyledLineChart('TempChart',{ backgroundColor: 'rgba(28,200,138,0.05)', borderColor: '#1cc88a', pointColor: '#1cc88a', unit: '°C' });
    const lChart   = createStyledLineChart('LPBChart', { backgroundColor: 'rgba(54,185,204,0.05)', borderColor: '#36b9cc', pointColor: '#36b9cc', unit: ' L/m' });
    const pbhChart = createStyledLineChart('PBHChart', { backgroundColor: 'rgba(246,194,62,0.05)', borderColor: '#f6c23e', pointColor: '#f6c23e', unit: ' L/hari' });

    // stat elements
    const phEl = document.getElementById('stat-ph');
    const tmpEl = document.getElementById('stat-temp');
    const lajuEl = document.getElementById('stat-laju');
    log('stat elements', { phEl, tmpEl, lajuEl });

    // --- alerts UI helpers ---
    function ensureAlertsContainer() {
      if (document.getElementById('alerts-container')) return document.getElementById('alerts-container');
      const c = document.createElement('div');
      c.id = 'alerts-container';
      c.style.position = 'fixed';
      c.style.right = '20px';
      c.style.bottom = '20px';
      c.style.zIndex = '1100';
      c.style.maxWidth = '320px';
      document.body.appendChild(c);
      return c;
    }

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    function showInPageAlert(title, message, level = 'danger', timeout = 8000) {
      const container = ensureAlertsContainer();
      const el = document.createElement('div');
      el.className = 'alert alert-' + (level || 'danger') + ' alert-dismissible fade show';
      el.role = 'alert';
      el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.12)';
      el.innerHTML = `<strong>${escapeHtml(title)}</strong><div>${escapeHtml(message)}</div>
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>`;
      container.appendChild(el);
      setTimeout(()=> { try { el.classList.remove('show'); el.remove(); } catch(e){} }, timeout);
    }

    async function sendBrowserNotification(title, body) {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        try {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') {
            new Notification(title, { body });
          }
        } catch (e) {
          console.warn('Notification permission request failed', e);
        }
      }
    }

    function flashCard(el) {
      if (!el) return;
      const orig = el.className;
      el.classList.add('border-left-danger','bg-danger','text-white');
      setTimeout(()=> {
        try { el.className = orig; } catch(e) {}
      }, ALERT_CONFIG.CARD_FLASH_MS);
    }

    // --- alerts logic ---
    function checkAlerts(latest) {
      if (!latest) return;
      const now = Date.now();

      function maybeAlert(key, condition, title, message, elToFlash) {
        if (!condition) return;
        const last = window.alertState.lastAlertAt[key] || 0;
        if (now - last < ALERT_CONFIG.ALERT_COOLDOWN_MS) {
          log('suppress alert', key);
          return;
        }
        window.alertState.lastAlertAt[key] = now;
        showInPageAlert(title, message, 'danger', 10000);
        sendBrowserNotification(title, message);
        if (elToFlash) flashCard(elToFlash);
      }

      // Temperature
      if (latest.temp !== undefined && latest.temp !== null) {
        const t = Number(latest.temp);
        if (t < ALERT_CONFIG.temp.min) maybeAlert('temp_low', true, 'Suhu rendah', `Temperatur ${t}°C di bawah minimum ${ALERT_CONFIG.temp.min}°C`, tmpEl);
        else if (t > ALERT_CONFIG.temp.max) maybeAlert('temp_high', true, 'Suhu tinggi', `Temperatur ${t}°C di atas maksimum ${ALERT_CONFIG.temp.max}°C`, tmpEl);
      }

      // pH
      if (latest.ph !== undefined && latest.ph !== null) {
        const p = Number(latest.ph);
        if (p < ALERT_CONFIG.ph.min) maybeAlert('ph_low', true, 'pH rendah', `pH ${p} di bawah minimum ${ALERT_CONFIG.ph.min}`, phEl);
        else if (p > ALERT_CONFIG.ph.max) maybeAlert('ph_high', true, 'pH tinggi', `pH ${p} di atas maksimum ${ALERT_CONFIG.ph.max}`, phEl);
      }
    }

    // --- aggregation: integrate L/min to liters/day ---
    function aggregateDailyFromRate(rows) {
      const byDay = new Map();
      if (!Array.isArray(rows) || rows.length === 0) return { labels: [], values: [], raw: [] };

      for (let i = 0; i < rows.length - 1; i++) {
        const a = rows[i], b = rows[i+1];
        if (a.laju == null || b.laju == null) continue;
        const ta = toDate(a.timestamp), tb = toDate(b.timestamp);
        if (isNaN(ta) || isNaN(tb) || tb <= ta) continue;
        const vA = Number(a.laju) || 0, vB = Number(b.laju) || 0;

        let segStart = new Date(ta);
        const segEnd = new Date(tb);

        while (segStart < segEnd) {
          const endOfDay = new Date(segStart.getFullYear(), segStart.getMonth(), segStart.getDate(), 24, 0, 0, 0);
          const thisSegEnd = (endOfDay < segEnd) ? endOfDay : segEnd;
          const segDurationMin = Math.max(0, (thisSegEnd - segStart) / 60000);

          const fracStart = Math.max(0, (segStart - ta) / (tb - ta));
          const fracEnd = Math.max(0, (thisSegEnd - ta) / (tb - ta));
          const vStart = vA + (vB - vA) * fracStart;
          const vEnd = vA + (vB - vA) * fracEnd;
          const subLiters = ((vStart + vEnd) / 2) * segDurationMin;

          const key = segStart.getFullYear() + '-' + String(segStart.getMonth()+1).padStart(2,'0') + '-' + String(segStart.getDate()).padStart(2,'0');
          const cur = byDay.get(key) || { sum: 0, date: new Date(segStart.getFullYear(), segStart.getMonth(), segStart.getDate()) };
          cur.sum += subLiters;
          byDay.set(key, cur);

          segStart = new Date(thisSegEnd);
        }
      }

      const entries = Array.from(byDay.entries()).sort((a,b)=>a[1].date - b[1].date);
      const labels = entries.map(e => e[1].date.toLocaleDateString());
      const values = entries.map(e => Number(e[1].sum.toFixed(3)));
      return { labels, values, raw: entries };
    }

    // --- updateCharts: timeline + pbh ---
    function updateCharts(rows) {
      if (!Array.isArray(rows)) return;

      // timeline labels formatted to seconds and without Z
      const timelineLabels = rows.map(r => {
        const d = toDate(r.timestamp);
        return isoNoMs(d); // "YYYY-MM-DD HH:MM:SS"
      });

      const phData = rows.map(r => (r.ph !== undefined ? Number(r.ph) : null));
      const tData  = rows.map(r => (r.temp !== undefined ? Number(r.temp) : null));
      const lData  = rows.map(r => (r.laju !== undefined ? Number(r.laju) : null));

      if (pHChart) { pHChart.data.labels = timelineLabels; pHChart.data.datasets[0].data = phData; pHChart.update(); }
      if (tChart)  { tChart.data.labels = timelineLabels;  tChart.data.datasets[0].data = tData;  tChart.update(); }
      if (lChart)  { lChart.data.labels = timelineLabels;  lChart.data.datasets[0].data = lData;  lChart.update(); }

      // compute daily liters from rate
      const agg = aggregateDailyFromRate(rows);
      if (pbhChart) { pbhChart.data.labels = agg.labels; pbhChart.data.datasets[0].data = agg.values; pbhChart.update(); }

      // update top cards & alerts
      if (rows.length) updateTopCards(rows[rows.length - 1]);
      if (rows.length) checkAlerts(rows[rows.length - 1]);
    }

    function updateTopCards(latest) {
      if (!latest) return;
      if (phEl && latest.ph !== undefined && latest.ph !== null) phEl.textContent = Number(latest.ph).toFixed(2);
      if (tmpEl && latest.temp !== undefined && latest.temp !== null) tmpEl.textContent = Number(latest.temp).toFixed(1) + (tmpEl.dataset?.unit || '°C');
      if (lajuEl && latest.laju !== undefined && latest.laju !== null) lajuEl.textContent = Number(latest.laju).toFixed(2) + (lajuEl.dataset?.unit || ' L/m');
    }

    // --- Firestore listener hookup ---
    if (window.firebaseApp && typeof window.firebaseApp.listenLatest === 'function') {
      try {
        window._biogasUnsub = window.firebaseApp.listenLatest((rows) => {
          log('Realtime rows received count=', rows.length);
          if (!Array.isArray(rows) || rows.length === 0) return;
          updateCharts(rows);
        }, 200);
      } catch (err) {
        console.error('listenLatest error', err);
      }
    } else {
      log('firebaseApp.listenLatest not available — ensure js/firebase.js loaded and firebaseConfig is correct');
    }

    // --- debugging helpers ---
    window.biogasUI = window.biogasUI || {};
    window.biogasUI.updateCharts = updateCharts;
    window.biogasUI.updateTopCards = updateTopCards;
    window.biogasUI.stopRealtime = () => { if (window._biogasUnsub) { window._biogasUnsub(); window._biogasUnsub = null; } };
    window.biogasUI._testAlert = function() {
      const fake = { ph: 8.5, temp: 45, laju: 4.2, timestamp: new Date() };
      checkAlerts(fake);
      showInPageAlert('Test alert', 'Simulated temp and pH out of range', 'danger', 8000);
    };

    log('UI init complete (timestamps to seconds, alerts enabled)');
  } // start()
})();

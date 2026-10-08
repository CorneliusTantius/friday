const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

async function runBrowserCheck(repositoryRoot) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const publicDir = path.join(repositoryRoot, 'public');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(publicDir + path.sep) || !fs.existsSync(filename)) return res.writeHead(404).end();
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html');
    fs.createReadStream(filename).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
        addEventListener() {}
        close() { this.readyState = 2; }
      };
    });
    const errors = [], mutations = [], socialRequestFailures = [];
    const model = { provider: 'test', id: 'model', name: 'Test model' };
    const status = { busy: false, canAbort: false, running: true, piRunning: true, workspace: '/workspace', preferredWorkspace: '/workspace', model, contextUsage: { tokens: 1200, contextWindow: 100000, percent: 1.2 } };
    const entries = [{ id: 'entry-1', type: 'expense', amount: 50000, category: 'Food', description: 'Lunch', date: new Date().toLocaleDateString('en-CA') }];
    const calendarEvents = [];
    let fileContent = '# A workspace note';
    let dashboardUnavailable = false;
    await page.route('https://fonts.**/**', route => route.abort());
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname;
      if (dashboardUnavailable && ['/api/friday/status', '/api/status', '/api/system/settings', '/api/devices', '/api/friday/memory/graph', '/api/finances'].includes(endpoint)) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) });
      }
      let body = {};
      if (request.method() !== 'GET') mutations.push({ endpoint, method: request.method(), body: request.postData() ? request.postDataJSON() : null });
      if (endpoint === '/api/socials/gmail/status') body = { configured: true, connected: false, email: null, scope: null };
      else if (endpoint === '/api/socials/slack/status') body = { configured: true, connected: false, workspace: null, selectedChannels: [] };
      else if (endpoint === '/api/calendar/events') {
        if (request.method() === 'POST') calendarEvents.push({ ...request.postDataJSON(), id: '123e4567-e89b-42d3-a456-426614174000' });
        body = request.method() === 'POST' ? { event: calendarEvents.at(-1) } : { events: calendarEvents };
      } else if (/^\/api\/calendar\/events\//.test(endpoint)) {
        const id = endpoint.split('/').at(-1);
        const index = calendarEvents.findIndex(event => event.id === id);
        if (request.method() === 'PUT' && index >= 0) calendarEvents[index] = { ...calendarEvents[index], ...request.postDataJSON() };
        if (request.method() === 'DELETE' && index >= 0) calendarEvents.splice(index, 1);
        body = request.method() === 'DELETE' ? { deleted: true, id } : { event: calendarEvents[index] };
      }
      else if (endpoint.endsWith('/models')) body = { models: [model], current: model };
      else if (endpoint.endsWith('/thinking-levels')) body = { levels: ['off', 'low', 'medium', 'high'], current: 'off' };
      else if (endpoint.endsWith('/history')) body = { messages: [{ role: 'assistant', content: 'Your workspace is ready.' }], total: 1, sessionPath: '/session.jsonl' };
      else if (endpoint.endsWith('/status')) body = status;
      else if (endpoint.endsWith('/events/token')) body = { token: 'test' };
      else if (endpoint.endsWith('/workspaces')) body = { workspaces: [{ path: '/workspace', label: 'Workspace' }] };
      else if (endpoint.endsWith('/sessions')) body = { sessions: [], workspace: '/workspace', currentSession: '/session.jsonl' };
      else if (endpoint.endsWith('/pi-conversations')) body = { sessions: [] };
      else if (endpoint.endsWith('/files/content')) {
        if (request.method() === 'PUT') fileContent = request.postDataJSON().content;
        body = { content: fileContent, path: 'note.md', editorType: 'markdown', size: fileContent.length, modified: new Date().toISOString() };
      } else if (endpoint.endsWith('/files')) body = { root: '/agent', path: '', entries: [{ type: 'file', path: 'note.md', name: 'note.md', size: 20 }] };
      else if (endpoint === '/api/finances') {
        if (request.method() === 'POST') entries.push({ ...request.postDataJSON(), amount: Number(request.postDataJSON().amount), id: 'entry-2' });
        body = { entries };
      } else if (endpoint.endsWith('/devices')) body = { available: true, devices: [{ hostname: 'MSI', online: true, self: true, addresses: ['127.0.0.1'], usage: { cpuPercent: 15, memoryPercent: 40, load1: 0.2 } }] };
      else if (endpoint === '/api/system/temperature') body = { status: 'available', celsius: 45, sampledAt: '2026-09-30T00:00:00.000Z' };
      else if (endpoint.endsWith('/system/settings')) body = { host: 'localhost', port: 3000, systemUsage: { cpuPercent: 15.4, memoryPercent: 40.6, load1: 0.2 } };
      else if (endpoint.endsWith('/friday/settings')) body = { fridayChat: { running: true, directory: '/friday', sessionsDirectory: '/friday/sessions' } };
      else if (endpoint.endsWith('/pi/settings')) body = { ...status, piPackages: [] };
      else if (endpoint.endsWith('/sync/settings')) body = { owner: 'test', repo: 'workspace' };
      else if (endpoint.endsWith('/auth')) body = { providers: [] };
      else if (endpoint.endsWith('/repos')) body = { repos: [{ name: 'Friday', path: '/workspace/repos/friday', branch: 'main', staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 }] };
      else if (endpoint.endsWith('/notes/content')) body = { content: '# Notes\nAn idea worth keeping.' };
      else if (endpoint.endsWith('/notes')) body = { notes: [{ name: 'Ideas', path: 'ideas.md' }] };
      else if (endpoint.endsWith('/memory/graph')) body = { nodes: [{ id: 'memory', type: 'curated', label: 'Memory' }, { id: 'daily', type: 'daily', label: '2026-09-29' }], edges: [{ source: 'memory', target: 'daily' }], totalDailyNotes: 1 };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && (message.location().url || '').endsWith('/socials.js')) errors.push(message.text());
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/socials/')) socialRequestFailures.push(`${url.pathname}: ${request.failure()?.errorText || 'request failed'}`);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('.dashboard-hero').waitFor();
    await page.waitForFunction(() => ['#gmail-status', '#slack-status'].every(selector => !document.querySelector(selector).textContent.includes('Checking connection')));
    assert.deepEqual(await page.locator('#gmail-status, #slack-status').allTextContents(), ['Not connected', 'Not connected']);
    assert.equal(await page.locator('#dashboard-temperature').textContent(), 'Highest sensor: 45.0 °C', 'initial temperature is rendered immediately without waiting for polling');
    await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-metric')].some(card => card.querySelector('.dashboard-metric-label')?.textContent === 'Host CPU' && card.querySelector('.dashboard-metric-detail')?.textContent === 'MSI'));
    assert.equal(await page.locator('.dashboard-metric').filter({ hasText: 'Active agents' }).locator('.dashboard-metric-value').textContent(), '2');
    assert.equal(await page.locator('.dashboard-metric').filter({ hasText: 'Active agents' }).locator('.dashboard-metric-detail').textContent(), 'Friday 1 running · Pi 1 running');
    assert.equal(await page.locator('.dashboard-metric').filter({ hasText: 'Host CPU' }).locator('.dashboard-metric-value').textContent(), '15%');
    assert.deepEqual(await page.locator('.dashboard-resource-gauge label').allTextContents(), ['CPU: 15%', 'RAM: 41%']);
    assert.deepEqual(await page.locator('.dashboard-resource-gauge progress').evaluateAll(items => items.slice(0, 2).map(item => item.getAttribute('aria-valuetext'))), ['15%', '41%']);
    async function checkShellLayout(width, height, expectedTopbarHeight) {
      const layout = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect();
        const root = getComputedStyle(document.documentElement);
        const topbar = box('.app-topbar');
        const sidebar = box('#workspace-sidebar');
        const shell = box('.workspace-shell');
        const controls = [...document.querySelectorAll('.app-topbar button, .app-topbar a, .app-topbar input, .app-topbar select')].filter(el => getComputedStyle(el).display !== 'none').map(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        return { bg: root.backgroundColor, accent: root.getPropertyValue('--accent').trim(), display: root.getPropertyValue('--display').trim(), mono: root.getPropertyValue('--mono').trim(), topbar: { left: topbar.left, right: topbar.right, top: topbar.top, bottom: topbar.bottom, height: topbar.height }, sidebar: { top: sidebar.top, bottom: sidebar.bottom }, shell: { top: shell.top, bottom: shell.bottom }, controls };
      });
      assert.equal(layout.bg, 'rgb(11, 14, 17)', 'Root background theme');
      assert.equal(layout.accent, '#72d9e5', 'Accent theme');
      assert.ok(layout.display && layout.mono, 'Display and mono theme fonts are defined');
      assert.ok(Math.abs(layout.topbar.height - expectedTopbarHeight) <= 1, `Topbar height ${width}x${height}: ${layout.topbar.height}, expected ${expectedTopbarHeight}`);
      for (const r of layout.controls) assert.ok(r.left >= layout.topbar.left - 1 && r.right <= layout.topbar.right + 1 && r.top >= layout.topbar.top - 1 && r.bottom <= layout.topbar.bottom + 1, `Topbar control outside topbar ${width}x${height}: ${JSON.stringify(r)}`);
      if (width > 600) assert.ok(Math.abs(layout.sidebar.top - layout.shell.top) <= 1 && Math.abs(layout.sidebar.bottom - layout.shell.bottom) <= 1, `Sidebar does not span shell height ${width}x${height}: ${JSON.stringify(layout)}`);
    }
    await checkShellLayout(1440, 1000, 71);
    assert.equal(await page.locator('#assistant-rail').evaluate(el => el.hidden), true, 'Desktop assistant rail starts collapsed');
    await page.waitForFunction(() => !document.querySelector('#friday-message').disabled);
    await page.evaluate(() => { window.originalFridayForm = document.querySelector('#friday-form'); });
    async function navigate(feature) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+k');
      await page.locator('#shell-command-input').fill(feature);
      await page.locator(`[data-command-feature="${feature}"]`).click();
      await page.waitForTimeout(80);
      assert.equal(await page.locator('.workspace-shell').getAttribute('data-feature'), feature);
    }
    async function checkBounds(width, feature) {
      const bounds = await page.evaluate(() => {
        const main = document.querySelector('#main-content');
        const view = main.querySelector(':scope > section:not([hidden])');
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, main: main.getBoundingClientRect().width, view: view.clientWidth, content: view.scrollWidth };
      });
      assert.ok(bounds.page <= bounds.viewport, `Page overflow ${width}/${feature}: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.main > 200, `Collapsed main ${width}/${feature}: ${JSON.stringify(bounds)}`);
      if (bounds.content > bounds.view + 1) console.log(await page.evaluate(() => [...document.querySelectorAll('#main-content section:not([hidden]) *')].filter(el => el.getBoundingClientRect().right > document.querySelector('#main-content').getBoundingClientRect().right).map(el => [el.tagName, el.className, el.getBoundingClientRect().right]).slice(0,20)));
      assert.ok(bounds.content <= bounds.view + 1, `View overflow ${width}/${feature}: ${JSON.stringify(bounds)}`);
    }
    for (const width of [360, 390, 600, 800, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const feature of ['dashboard', 'friday', 'pi', 'files', 'repos', 'notes', 'finances', 'calendar', 'settings']) {
        await navigate(feature);
        await checkBounds(width, feature);
        await checkShellLayout(width, 900, width <= 600 ? 0 : 71);
        assert.equal(await page.locator(`.feature[data-feature="${feature}"]`).getAttribute('aria-current'), 'page');
        if (feature === 'calendar') {
          assert.equal(await page.locator('#calendar-month-grid').isVisible(), width > 600, `Month grid visibility at ${width}px`);
          assert.equal(await page.locator('#calendar-mobile-date').isVisible(), width <= 600, `Mobile date picker visibility at ${width}px`);
          assert.equal(await page.locator('#calendar-mobile-agenda').isVisible(), width <= 600, `Mobile monthly agenda visibility at ${width}px`);
          if (width <= 600) {
            await page.locator('#calendar-mobile-date').fill('2026-09-29');
            assert.equal(await page.locator('#calendar-mobile-date').inputValue(), '2026-09-29');
            await page.locator('#calendar-today').click();
          }
        }
      }
      await navigate('dashboard');
      if (width <= 600) {
        assert.deepEqual(await page.locator('.shell-mobile-shortcuts button').allTextContents(), ['πPi', 'Friday', 'Dashboard', 'Finance', 'More']);
        assert.equal(await page.locator('.dashboard-tab').getAttribute('aria-current'), 'page');
        const center = await page.locator('.dashboard-tab').boundingBox();
        assert.ok(Math.abs(center.x + center.width / 2 - width / 2) < 2, 'Dashboard shortcut stays centered');
      }
      if (width <= 1170) {
        const askFriday = page.getByRole('button', { name: 'Ask Friday', exact: true });
        await askFriday.click();
        await page.locator('#assistant-rail.shell-drawer-open').waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await askFriday.evaluate(el => document.activeElement === el), true, 'Ask Friday restores focus to its visible trigger');
        await page.keyboard.press('Control+j');
        await page.locator('#assistant-rail.shell-drawer-open').waitFor();
        assert.equal(await page.locator('#assistant-rail').evaluate(el => el.inert), false);
        await page.locator('#friday-message').fill('Keep this draft');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#assistant-rail').evaluate(el => el.inert), true);
      } else {
        const assistantToggle = page.locator('.shell-assistant-toggle');
        assert.equal(await page.locator('#assistant-rail').evaluate(el => el.hidden), true, 'Desktop assistant rail starts collapsed');
        await assistantToggle.click();
        assert.equal(await page.locator('#assistant-rail').evaluate(el => el.hidden), false);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#assistant-rail').evaluate(el => el.hidden), true, 'Escape collapses the desktop assistant rail');
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.shell-assistant-toggle')), true);
        await assistantToggle.click();
        await page.locator('#friday-message').fill('Keep this draft');
        const rects = await page.evaluate(() => ['#main-content', '#assistant-rail'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; }));
        assert.ok(rects[1].width >= 280 && rects[1].left >= rects[0].right - 1, 'Assistant rail sits beside main');
        await assistantToggle.click();
        assert.equal(await page.locator('#assistant-rail').evaluate(el => el.hidden), true);
        assert.equal(await page.locator('.workspace-shell').getAttribute('data-assistant'), 'closed');
      }
      await navigate('friday');
      await page.waitForFunction(() => document.querySelector('#friday-workspace-directory').value === '/friday');
      assert.equal(await page.locator('#friday-workspace-directory').isDisabled(), true);
      assert.equal(await page.locator('#friday-workspace-directory').getAttribute('readonly'), '');
      assert.equal(await page.locator('#friday-message').inputValue(), 'Keep this draft');
      assert.equal(await page.evaluate(() => window.originalFridayForm === document.querySelector('#friday-form')), true);
      await navigate('dashboard');
      assert.equal(await page.locator('#friday-message').inputValue(), 'Keep this draft');
      if (width <= 600) {
        const moreButton = page.locator('.shell-mobile-shortcuts [data-shell-drawer="sidebar"]');
        await moreButton.click();
        assert.equal(await page.locator('#workspace-sidebar').evaluate(el => el.inert), false);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'logout', await page.evaluate(() => document.activeElement.outerHTML));
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#workspace-sidebar').evaluate(el => el.inert), true);
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.shell-mobile-shortcuts [data-shell-drawer="sidebar"]')), true);
      }
    }
    for (const [width, height] of [[320, 700], [667, 375]]) {
      await page.setViewportSize({ width, height });
      await checkShellLayout(width, height, width <= 600 ? 0 : 71);
      await navigate('dashboard');
      await checkBounds(width, 'dashboard');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate('files');
    await page.locator('[data-file-scope="pi-files"]').click();
    assert.equal(await page.locator('[data-file-scope="pi-files"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#file-list .file-item').click();
    await page.locator('#file-editor').fill('# Edited note');
    await page.locator('.feature[data-feature="files"]').click();
    assert.equal(await page.locator('#file-editor').inputValue(), '# Edited note', 'Reselecting Files preserves edits');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('.feature[data-feature="notes"]').click();
    assert.equal(await page.locator('.workspace-shell').getAttribute('data-feature'), 'pi-files');
    assert.equal(await page.locator('#file-editor').inputValue(), '# Edited note', 'Cancelled navigation preserves edits');
    await page.locator('#file-save').click();
    await page.waitForTimeout(100);
    assert.ok(mutations.some(item => item.endpoint === '/api/pi/files/content' && item.method === 'PUT' && item.body.content === '# Edited note'));
    await navigate('repos');
    await page.locator('[data-repo-scope="pi"]').click();
    await page.locator('#clone-repo-url').fill('https://github.com/example/repo.git');
    await page.locator('#clone-repo-form button').click();
    await page.waitForTimeout(100);
    assert.ok(mutations.some(item => item.endpoint === '/api/pi/repos' && item.method === 'POST'));
    await navigate('finances');
    await page.locator('#finance-form [name="amount"]').fill('25000');
    await page.locator('#finance-form [name="description"]').fill('Coffee');
    await page.locator('#finance-submit').click();
    await page.waitForTimeout(100);
    assert.ok(mutations.some(item => item.endpoint === '/api/finances' && item.method === 'POST'));
    await navigate('calendar');
    const visibleMonth = await page.locator('#calendar-month-label').textContent();
    await page.locator('#calendar-previous-month').click();
    assert.notEqual(await page.locator('#calendar-month-label').textContent(), visibleMonth);
    await page.locator('#calendar-next-month').click();
    assert.equal(await page.locator('#calendar-month-label').textContent(), visibleMonth);
    await page.locator('#calendar-today').click();
    await page.locator('#calendar-title').fill('Planning');
    await page.locator('#calendar-start').fill('2026-09-29T10:00');
    await page.locator('#calendar-end').fill('2026-09-29T11:00');
    await page.locator('#calendar-event-form button[type="submit"]').click();
    await page.getByRole('heading', { name: 'Planning' }).waitFor();
    assert.equal(await page.locator('.calendar-day-button.selected .calendar-event-indicator').textContent(), '1');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#calendar-month-grid').isVisible(), false);
    assert.match(await page.locator('#calendar-mobile-agenda').textContent(), /Planning/);
    const mobileFormBounds = await page.locator('#calendar-event-form').evaluate((form) => ({
      right: form.getBoundingClientRect().right,
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: form.scrollWidth,
      clientWidth: form.clientWidth,
    }));
    assert.ok(mobileFormBounds.right <= mobileFormBounds.viewportWidth, 'calendar form must stay within the mobile viewport');
    assert.ok(mobileFormBounds.scrollWidth <= mobileFormBounds.clientWidth + 1, 'calendar form must not overflow its card');
    await page.locator('#calendar-mobile-agenda').getByRole('button', { name: /Planning/ }).click();
    assert.equal(await page.locator('#calendar-mobile-date').inputValue(), '2026-09-29');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.local-calendar-event').getByRole('button', { name: 'Edit' }).click();
    await page.locator('#calendar-title').fill('Review');
    await page.locator('#calendar-event-form button[type="submit"]').click();
    await page.getByRole('heading', { name: 'Review' }).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.local-calendar-event').getByRole('button', { name: 'Delete' }).click();
    await page.getByText('No events yet. Create one to start your agenda.').waitFor();
    assert.ok(mutations.some(item => item.endpoint === '/api/calendar/events' && item.method === 'POST'));
    assert.ok(mutations.some(item => item.endpoint === '/api/calendar/events/123e4567-e89b-42d3-a456-426614174000' && item.method === 'PUT'));
    assert.ok(mutations.some(item => item.endpoint === '/api/calendar/events/123e4567-e89b-42d3-a456-426614174000' && item.method === 'DELETE'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await navigate('dashboard');
    assert.equal(await page.locator('.orbit-rotate').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    if (process.env.FRIDAY_SCREENSHOTS) {
      fs.mkdirSync(process.env.FRIDAY_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.FRIDAY_SCREENSHOTS, 'desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(process.env.FRIDAY_SCREENSHOTS, 'mobile.png') });
    }
    dashboardUnavailable = true;
    await page.locator('#refresh-dashboard').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-metric-value')].every(el => el.textContent === 'Unavailable'));
    assert.deepEqual(await page.locator('.dashboard-status').allTextContents(), ['Unavailable', 'Unavailable']);
    assert.ok(await page.getByText('Financial data unavailable', { exact: true }).isVisible());
    dashboardUnavailable = false;
    let loginAttempts = 0;
    await page.route('**/api/login', async route => {
      loginAttempts++;
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().postDataJSON().password, loginAttempts === 1 ? 'wrong-password' : 'test-password');
      await route.fulfill({ status: loginAttempts === 1 ? 401 : 200, contentType: 'application/json', body: JSON.stringify(loginAttempts === 1 ? { error: 'Incorrect password' } : { ok: true }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/login.html?notice=login-required`);
    assert.ok(await page.locator('#login-toast').isVisible());
    assert.equal(await page.locator('.logo').textContent(), 'Fr');
    assert.equal(await page.locator('button[type="submit"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(114, 217, 229)');
    for (const [width, height] of [[320, 568], [390, 844], [667, 375], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Lock screen overflow at ${width}`);
      await page.locator('button[type="submit"]').scrollIntoViewIfNeeded();
      assert.ok(await page.locator('button[type="submit"]').isVisible());
    }
    await page.locator('#password').fill('wrong-password');
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#error').textContent === 'Incorrect password');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'password');
    assert.equal(await page.locator('button[type="submit"]').isEnabled(), true);
    await page.locator('#password').fill('test-password');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('.dashboard-hero').waitFor();
    assert.equal(loginAttempts, 2);
    assert.deepEqual(socialRequestFailures, [], `Socials API network failures: ${socialRequestFailures.join('; ')}`);
    assert.deepEqual(errors, [], `Browser JavaScript errors: ${errors.join('; ')}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { runBrowserCheck };

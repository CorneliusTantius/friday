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
    const errors = [], mutations = [], socialRequests = [];
    const model = { provider: 'test', id: 'model', name: 'Test model' };
    const status = { busy: false, canAbort: false, running: true, piRunning: true, workspace: '/workspace', preferredWorkspace: '/workspace', model, contextUsage: { tokens: 1200, contextWindow: 100000, percent: 1.2 } };
    const entries = [{ id: 'entry-1', type: 'expense', amount: 50000, category: 'Food', description: 'Lunch', date: new Date().toLocaleDateString('en-CA') }];
    const calendarEvents = [];
    const fridaySessions = [
      { id: 'friday-existing', name: 'Original conversation', modified: new Date().toISOString(), messageCount: 2 },
      { id: 'friday-other', name: 'Other conversation', modified: new Date().toISOString(), messageCount: 1 },
    ];
    let currentFridaySession = 'friday-other';
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
      if (endpoint.startsWith('/api/socials/')) socialRequests.push({ endpoint, method: request.method() });
      if (endpoint === '/api/calendar/events') {
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
      else if (endpoint === '/api/friday/sessions') {
        if (request.method() === 'POST') {
          const session = { id: 'friday-created', name: 'New conversation', modified: new Date().toISOString(), messageCount: 0 };
          fridaySessions.unshift(session); currentFridaySession = session.id; body = { id: session.id };
        } else body = { sessions: fridaySessions, workspace: '/workspace', currentSession: currentFridaySession };
      } else if (/^\/api\/friday\/sessions\/[^/]+/.test(endpoint)) {
        const [, rawId, action] = endpoint.match(/^\/api\/friday\/sessions\/([^/]+)(?:\/(open))?$/) || [];
        const id = decodeURIComponent(rawId || '');
        const index = fridaySessions.findIndex(session => session.id === id);
        if (action === 'open' && request.method() === 'POST') currentFridaySession = id;
        else if (request.method() === 'PATCH' && index >= 0) fridaySessions[index].name = request.postDataJSON().name;
        else if (request.method() === 'DELETE' && index >= 0) fridaySessions.splice(index, 1);
        body = request.method() === 'DELETE' ? { deleted: true, id } : { session: fridaySessions[index] };
      } else if (endpoint === '/api/session/reset' && request.method() === 'POST') body = { runId: 'new-pi-session', sessionPath: '/workspace/new.jsonl', workspace: '/workspace' };
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
      else if (endpoint.endsWith('/friday/settings')) body = { fridayChat: { running: true, directory: '/friday/workspaces/team/production/shared/long-workspace-directory-example', sessionsDirectory: '/friday/sessions' } };
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

    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('.dashboard-hero').waitFor();
    assert.equal(await page.locator('#dashboard-temperature').textContent(), 'Highest sensor: 45.0 °C', 'initial temperature is rendered immediately without waiting for polling');
    await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-metric')].some(card => card.querySelector('.dashboard-metric-label')?.textContent === 'Host CPU' && card.querySelector('.dashboard-metric-detail')?.textContent === 'MSI'));
    assert.equal(await page.locator('.dashboard-metric').filter({ hasText: 'Active agents' }).locator('.dashboard-metric-value').textContent(), '2');
    assert.equal(await page.locator('.dashboard-metric').filter({ hasText: 'Active agents' }).locator('.dashboard-metric-detail').textContent(), 'Friday 1 running · Pi 1 running');
    assert.equal(await page.locator('.dashboard-metric').filter({ hasText: 'Host CPU' }).locator('.dashboard-metric-value').textContent(), '15%');
    assert.deepEqual(await page.locator('.dashboard-resource-gauge label').allTextContents(), ['CPU: 15%', 'RAM: 41%']);
    assert.deepEqual(await page.locator('.dashboard-resource-gauge progress').evaluateAll(items => items.slice(0, 2).map(item => item.getAttribute('aria-valuetext'))), ['15%', '41%']);
    async function checkShellLayout(width, height) {
      const layout = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect();
        const root = getComputedStyle(document.documentElement);
        const main = box('#main-content');
        const sidebar = box('#workspace-sidebar');
        const mainStyle = getComputedStyle(document.querySelector('#main-content'));
        const shell = box('.workspace-shell');
        return { bg: root.backgroundColor, accent: root.getPropertyValue('--accent').trim(), display: root.getPropertyValue('--display').trim(), mono: root.getPropertyValue('--mono').trim(), topbarCount: document.querySelectorAll('.app-topbar').length, documentWidth: document.documentElement.scrollWidth, main: { top: main.top, paddingTop: parseFloat(mainStyle.paddingTop), paddingRight: parseFloat(mainStyle.paddingRight), paddingBottom: parseFloat(mainStyle.paddingBottom), paddingLeft: parseFloat(mainStyle.paddingLeft) }, sidebar: { top: sidebar.top, bottom: sidebar.bottom, width: sidebar.width }, shell: { top: shell.top, bottom: shell.bottom } };
      });
      assert.equal(layout.bg, 'rgb(11, 14, 17)', 'Root background theme');
      assert.equal(layout.accent, '#72d9e5', 'Accent theme');
      assert.ok(layout.display && layout.mono, 'Display and mono theme fonts are defined');
      assert.equal(layout.topbarCount, 0, `No global topbar remains at ${width}x${height}`);
      assert.ok(Math.abs(layout.main.top - layout.shell.top) <= 1, `Main content has no reserved topbar gap ${width}x${height}: ${JSON.stringify(layout)}`);
      const expectedSidebarWidth = width > 1390 ? 235.4 : width > 800 ? 209 : width > 600 ? 77 : 264;
      const expectedBlockInset = width >= 1700 ? 40 : width > 1390 ? 32 : width > 600 ? 28 : 0;
      const expectedInlineInset = width >= 1700 ? 40 : width > 1390 ? 32 : width > 600 ? 24 : 0;
      assert.ok(Math.abs(layout.sidebar.width - expectedSidebarWidth) <= 1, `Sidebar is 10% wider at ${width}px: ${JSON.stringify(layout)}`);
      for (const [side, expected] of [['paddingTop', expectedBlockInset], ['paddingBottom', expectedBlockInset], ['paddingLeft', expectedInlineInset], ['paddingRight', expectedInlineInset]]) {
        assert.ok(Math.abs(layout.main[side] - expected) <= 1, `Main content ${side} at ${width}px is ${expected}px: ${JSON.stringify(layout)}`);
      }
      assert.ok(layout.documentWidth <= width, `No horizontal overflow at ${width}x${height}: ${JSON.stringify(layout)}`);
      if (width > 600) assert.ok(Math.abs(layout.sidebar.top - layout.shell.top) <= 1 && Math.abs(layout.sidebar.bottom - layout.shell.bottom) <= 1, `Sidebar does not span shell height ${width}x${height}: ${JSON.stringify(layout)}`);
    }
    await checkShellLayout(1440, 1000);
    for (const [width, height] of [[1800, 1000], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await checkShellLayout(width, height);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.locator('#assistant-rail').evaluate(el => el.hidden), true, 'Desktop assistant rail starts collapsed');
    await page.waitForFunction(() => !document.querySelector('#friday-message').disabled);
    await page.evaluate(() => { window.originalFridayForm = document.querySelector('#friday-form'); });
    async function navigate(feature) {
      await page.keyboard.press('Escape');
      await page.locator(`#workspace-sidebar [data-feature="${feature}"]`).first().click();
      await page.waitForTimeout(80);
      assert.equal(await page.locator('.workspace-shell').getAttribute('data-feature'), feature);
    }
    await navigate('socials');
    assert.equal(await page.locator('#socials-feature').evaluate(el => el.hidden), false, 'Socials navigation still opens its feature');
    assert.equal(await page.locator('#socials-feature').evaluate(el => el.textContent.trim()), '', 'Socials is intentionally blank');
    assert.deepEqual(socialRequests, [], 'Socials emits no connector API requests');
    await navigate('dashboard');
    const fridayAgent = page.locator('[data-feature="friday"]');
    const submenuToggle = page.locator('#friday-submenu-toggle');
    await page.locator('#friday-nav-entry').hover();
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'false', 'Hover does not open the conversation submenu');
    assert.equal(await page.locator('#friday-session-list').isVisible(), false);
    await fridayAgent.focus();
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'false', 'Keyboard focus on Friday Agent does not open the submenu');
    assert.equal(await page.locator('#friday-session-list').isVisible(), false);
    await fridayAgent.click();
    await fridayAgent.waitFor({ state: 'visible' });
    assert.equal(await fridayAgent.getAttribute('aria-current'), 'page', 'Friday Agent label navigates to its feature');
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'false', 'Navigating to Friday does not open the submenu');
    await submenuToggle.focus();
    await submenuToggle.press('Enter');
    await page.locator('#friday-submenu-toggle[aria-expanded="true"]').waitFor();
    assert.equal(await page.locator('#friday-session-list').isVisible(), true, 'Enter opens the explicit arrow toggle');
    await submenuToggle.press('Space');
    await page.locator('#friday-submenu-toggle[aria-expanded="false"]').waitFor();
    assert.equal(await page.locator('#friday-session-list').isVisible(), false, 'Space closes the explicit arrow toggle');
    await navigate('pi');
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'false', 'Navigation preserves collapsed state');
    await navigate('friday');
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'false', 'Friday page activation does not auto-expand');
    await submenuToggle.click();
    await page.locator('#friday-submenu-toggle[aria-expanded="true"]').waitFor();
    await submenuToggle.click();
    await page.locator('#friday-submenu-toggle[aria-expanded="false"]').waitFor();
    await submenuToggle.click();
    await page.locator('#friday-submenu-toggle[aria-expanded="true"]').waitFor();
    await navigate('pi');
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'true', 'Navigation preserves explicit expanded state');
    await navigate('friday');
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#friday-session-list').isVisible(), true);
    await page.waitForFunction(() => document.querySelectorAll('#friday-session-list .friday-session-disclosure').length === 2);
    const sessionDetails = page.locator('#friday-session-list .friday-session-disclosure');
    assert.deepEqual(await sessionDetails.evaluateAll(items => items.map(item => item.open)), [false, false], 'Supplementary session details start collapsed on the active Friday page');
    assert.equal(await page.locator('#friday-session-list .friday-session-actions').first().isVisible(), false, 'Supplemental actions stay tucked away while collapsed');
    assert.equal(await page.locator('#friday-sidebar').evaluate(el => el.closest('#friday-feature')), null, 'Conversations are not a second feature column');
    const fridayBounds = await page.evaluate(() => {
      const chat = document.querySelector('#friday-feature .friday-app').getBoundingClientRect();
      const panel = document.querySelector('#friday-pi-sidebar').getBoundingClientRect();
      return { chatRight: chat.right, panelLeft: panel.left, panelWidth: panel.width, featureWidth: document.querySelector('#friday-feature').getBoundingClientRect().width };
    });
    assert.ok(fridayBounds.panelWidth >= 320 && fridayBounds.panelWidth <= fridayBounds.featureWidth * 0.4, `Friday right sidebar remains about 35%: ${JSON.stringify(fridayBounds)}`);
    assert.ok(fridayBounds.chatRight <= fridayBounds.panelLeft + 1, `Friday chat has the vacated left-column space: ${JSON.stringify(fridayBounds)}`);
    await sessionDetails.first().locator('summary').click();
    await page.waitForFunction(() => document.querySelector('#friday-session-list .friday-session-disclosure')?.open === true);
    assert.equal(await page.locator('#friday-session-list .friday-session-actions').first().isVisible(), true, 'Explicit disclosure reveals rename/delete actions');
    await page.locator('.friday-session-open').first().click();
    await page.waitForFunction(() => document.querySelector('.friday-session-open')?.getAttribute('aria-current') === 'true');
    assert.deepEqual(await page.locator('#friday-session-list .friday-session-disclosure').evaluateAll(items => items.map(item => item.open)), [true, false], 'Session selection refresh preserves explicit details choice');
    assert.equal(await page.locator('.friday-session-open').nth(1).getAttribute('aria-current'), 'false');
    const refreshResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/friday/sessions' && response.request().method() === 'GET');
    await page.locator('#friday-refresh-sessions').click();
    await refreshResponse;
    await page.waitForFunction(() => document.querySelector('#friday-session-list .friday-session-disclosure')?.open === true);
    assert.deepEqual(await page.locator('#friday-session-list .friday-session-disclosure').evaluateAll(items => items.map(item => item.open)), [true, false], 'Polling refresh preserves the user’s explicit choice without opening other details');
    assert.equal(await page.locator('#friday-submenu-toggle').getAttribute('aria-expanded'), 'true', 'Session-list polling preserves explicit submenu state');
    page.once('dialog', dialog => { assert.equal(dialog.type(), 'prompt'); void dialog.accept('Renamed conversation'); });
    await page.getByRole('button', { name: 'Rename Original conversation' }).click();
    await page.getByText('Renamed conversation', { exact: true }).waitFor();
    page.once('dialog', dialog => { assert.equal(dialog.type(), 'confirm'); void dialog.accept(); });
    await page.getByRole('button', { name: 'Delete Renamed conversation' }).click();
    await page.getByText('No conversations yet', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'New Friday conversation' }).click();
    await page.getByText('New conversation', { exact: true }).waitFor();
    assert.ok(mutations.some(item => item.endpoint === '/api/friday/sessions/friday-existing' && item.method === 'PATCH'));
    assert.ok(mutations.some(item => item.endpoint === '/api/friday/sessions/friday-existing' && item.method === 'DELETE'));
    assert.ok(mutations.some(item => item.endpoint === '/api/friday/sessions' && item.method === 'POST'));
    await navigate('pi');
    await page.getByRole('button', { name: 'New Pi session' }).click();
    await page.getByText('New session ready', { exact: true }).waitFor();
    assert.ok(mutations.some(item => item.endpoint === '/api/session/reset' && item.method === 'POST' && item.body.cwd === '/workspace'));
    await page.setViewportSize({ width: 390, height: 844 });
    await navigate('friday');
    await page.locator('.shell-mobile-shortcuts [data-shell-drawer="sidebar"]').click();
    await page.locator('#workspace-sidebar.shell-drawer-open').waitFor();
    await page.locator('#friday-nav-entry').dispatchEvent('pointerleave', { pointerType: 'mouse' });
    await page.locator('#friday-nav-entry').dispatchEvent('pointerenter', { pointerType: 'touch' });
    await page.locator('#friday-submenu-toggle').evaluate(el => el.click());
    await page.locator('#friday-submenu-toggle[aria-expanded="false"]').waitFor();
    assert.equal(await page.locator('#friday-session-list').isVisible(), false, 'Touch toggle closes the active-page submenu');
    await page.locator('#friday-submenu-toggle').evaluate(el => el.click());
    await page.locator('#friday-submenu-toggle[aria-expanded="true"]').waitFor();
    assert.equal(await page.locator('#friday-session-list').isVisible(), true, 'Touch toggle reopens the submenu');
    await page.keyboard.press('Escape');

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
      for (const feature of ['dashboard', 'friday', 'pi', 'files', 'repos', 'notes', 'finances', 'socials', 'calendar', 'settings']) {
        await navigate(feature);
        await checkBounds(width, feature);
        await checkShellLayout(width, 900);
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
      const workspacePath = '/friday/workspaces/team/production/shared/long-workspace-directory-example';
      await page.waitForFunction(path => document.querySelector('#friday-workspace-directory').textContent === path, workspacePath);
      assert.equal(await page.locator('#friday-workspace-directory').evaluate(el => el.tagName), 'CODE');
      assert.equal(await page.locator('#friday-workspace-directory').isEditable(), false);
      assert.equal(await page.locator('#friday-workspace-directory').getAttribute('role'), 'status');
      assert.equal(await page.locator('#friday-workspace-directory').evaluate(el => getComputedStyle(el).userSelect), 'text');
      assert.equal(await page.locator('#friday-workspace-directory').evaluate(el => getComputedStyle(el).overflowWrap), 'anywhere');
      assert.ok(await page.locator('#friday-workspace-directory').evaluate(el => el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight)), 'Long workspace paths wrap rather than truncate');
      assert.equal(await page.locator('#friday-new-conversation').getAttribute('aria-label'), 'New Friday conversation');
      assert.equal(await page.locator('#friday-message').inputValue(), 'Keep this draft');
      assert.equal(await page.evaluate(() => window.originalFridayForm === document.querySelector('#friday-form')), true);
      await navigate('dashboard');
      assert.equal(await page.locator('#friday-message').inputValue(), 'Keep this draft');
      if (width <= 600) {
        const moreButton = page.locator('.shell-mobile-shortcuts [data-shell-drawer="sidebar"]');
        await moreButton.click();
        assert.equal(await page.locator('#workspace-sidebar').evaluate(el => el.inert), false);
        const assistantToggle = page.locator('#workspace-sidebar .shell-assistant-toggle');
        assert.equal(await assistantToggle.isVisible(), true, 'the Friday assistant remains available in the More drawer');
        await assistantToggle.click();
        await page.locator('#assistant-rail.shell-drawer-open').waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.shell-mobile-shortcuts [data-shell-drawer="sidebar"]')), true, 'assistant close restores focus to the visible More control');
        await moreButton.click();
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'logout', await page.evaluate(() => document.activeElement.outerHTML));
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#workspace-sidebar').evaluate(el => el.inert), true);
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.shell-mobile-shortcuts [data-shell-drawer="sidebar"]')), true);
      }
    }
    for (const [width, height] of [[320, 700], [667, 375]]) {
      await page.setViewportSize({ width, height });
      await checkShellLayout(width, height);
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
    await navigate('friday');
    if (await submenuToggle.getAttribute('aria-expanded') !== 'true') await submenuToggle.click();
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'true', 'Explicit expansion remains set before reload');
    await page.waitForFunction(() => document.querySelectorAll('#friday-session-list .friday-session-disclosure').length > 0);
    await page.locator('#friday-session-list .friday-session-disclosure').first().locator('summary').click();
    await page.waitForFunction(() => document.querySelector('#friday-session-list .friday-session-disclosure')?.open === true);
    await page.reload();
    await page.locator('.dashboard-hero').waitFor();
    await navigate('friday');
    await page.waitForFunction(() => document.querySelectorAll('#friday-session-list .friday-session-disclosure').length > 0);
    assert.equal(await submenuToggle.getAttribute('aria-expanded'), 'false', 'Page reload resets the conversation submenu to collapsed');
    assert.equal(await page.locator('#friday-session-list').isVisible(), false);
    assert.ok(await page.locator('#friday-session-list .friday-session-disclosure').evaluateAll(items => items.every(item => !item.open)), 'Page reload resets all supplemental details to collapsed');
    await navigate('dashboard');
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
    assert.deepEqual(socialRequests, [], `Socials must not call connector APIs: ${JSON.stringify(socialRequests)}`);
    assert.deepEqual(errors, [], `Browser JavaScript errors: ${errors.join('; ')}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { runBrowserCheck };

'use strict';

const { Plugin, ItemView, Modal, SuggestModal, Setting, Notice, Menu, Component, TFile, MarkdownView, MarkdownRenderer } = require('obsidian');
const { exec, execFileSync, spawn } = require('child_process');
const pathMod = require('path');
const fs = require('fs');
const os = require('os');

const VIEW_TYPE = 'jarvis-command-center';

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function fmtDate(str) {
    if (!str) return '—';
    const d = new Date(str + 'T12:00:00');
    if (isNaN(d)) return str;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(str) {
    if (!str) return null;
    const d = new Date(str + 'T12:00:00');
    if (isNaN(d)) return null;
    const now = new Date(); now.setHours(0,0,0,0); d.setHours(0,0,0,0);
    return Math.ceil((d - now) / 86400000);
}

function urgency(days) {
    if (days === null) return 'future';
    if (days < 0)  return 'overdue';
    if (days <= 7) return 'urgent';
    if (days <= 30) return 'soon';
    return 'future';
}

// ── Token usage ───────────────────────────────────────────────────────────────

async function readTokenUsage(_vaultRoot) {
    // Primary: read from jarvis_status.py cache (accurate API rate-limit data from Anthropic headers)
    const cacheFile = pathMod.join(os.homedir(), '.claude', 'cache', 'jarvis_usage.json');
    if (fs.existsSync(cacheFile)) {
        try {
            const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            const ageMs = Date.now() - (cache.timestamp * 1000);
            if (ageMs < 10 * 60 * 1000) { // fresh within 10 minutes
                const rl = cache.rate_limits || {};
                return {
                    fromCache: true,
                    fiveHourPct:    rl.five_hour?.used_percentage  ?? null,
                    sevenDayPct:    rl.seven_day?.used_percentage  ?? null,
                    fiveHourResetsAt:  rl.five_hour?.resets_at     ?? null,
                    sevenDayResetsAt:  rl.seven_day?.resets_at     ?? null,
                    model:          cache.model?.display_name      ?? null,
                    contextPct:     cache.context_window?.used_percentage ?? null,
                    cacheAgeMs:     ageMs,
                };
            }
        } catch { /* fall through */ }
    }

    // Fallback: count output tokens from JSONL transcripts
    const projectsRoot = pathMod.join(os.homedir(), '.claude', 'projects');
    const zero = { output: 0, input: 0, cacheCreate: 0, cacheRead: 0 };
    const result = { fromCache: false, window5h: { ...zero }, weekly: { ...zero }, oldest5h: null, oldestWeek: null };

    if (!fs.existsSync(projectsRoot)) return result;

    const now = Date.now();
    const ago5h   = now - 5  * 3600 * 1000;
    const agoWeek = now - 7  * 86400 * 1000;

    const projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => pathMod.join(projectsRoot, d.name));

    for (const dir of projectDirs) {
        let files;
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
        catch { continue; }

        for (const file of files) {
            const lines = fs.readFileSync(pathMod.join(dir, file), 'utf-8').split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    const usage = entry.message?.usage;
                    if (!usage) continue;
                    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
                    const o = usage.output_tokens || 0;
                    const i = usage.input_tokens || 0;
                    const cc = usage.cache_creation_input_tokens || 0;
                    const cr = usage.cache_read_input_tokens || 0;
                    if (ts >= agoWeek) {
                        result.weekly.output += o; result.weekly.input += i;
                        result.weekly.cacheCreate += cc; result.weekly.cacheRead += cr;
                        if (result.oldestWeek === null || ts < result.oldestWeek) result.oldestWeek = ts;
                    }
                    if (ts >= ago5h) {
                        result.window5h.output += o; result.window5h.input += i;
                        result.window5h.cacheCreate += cc; result.window5h.cacheRead += cr;
                        if (result.oldest5h === null || ts < result.oldest5h) result.oldest5h = ts;
                    }
                } catch { /* skip */ }
            }
        }
    }
    return result;
}

// ── Review gate on export ────────────────────────────────────────────────────

// A PDF is the moment a document stops being a draft and becomes a thing
// someone else reads. Everywhere else in this vault an unreviewed file is a
// reminder; here it is a claim leaving the building, so this is the one place
// that asks before letting it go.
//
// It checks the BLOB, not the filename: .claude/codex-review/reviewed.tsv
// records the exact text Codex saw, so editing a file after its review puts it
// back on the wrong side of this gate. That is the behaviour we want - the
// review covered the old sentence, not the new one.
//
// It asks rather than blocks. A hard block with no override is a thing that
// will one day stand between TC and a deadline at 2am, and the honest design
// is to make the state visible, not to make the decision for him.
const GATED = [/^proposals\//, /^experiments\/.*\/reports\//, /^fellowships\/.*\/drafts\//];

function unreviewedForExport(vaultRoot, relPath) {
    if (!GATED.some(re => re.test(relPath))) return null;
    try {
        const tsv = pathMod.join(vaultRoot, '.claude', 'codex-review', 'reviewed.tsv');
        if (!fs.existsSync(tsv)) return 'never reviewed (no review history on this machine)';
        const blob = execFileSync('git', ['hash-object', relPath],
                                  { cwd: vaultRoot, encoding: 'utf-8' }).trim();
        let seen = null;
        for (const line of fs.readFileSync(tsv, 'utf-8').split('\n')) {
            const [p, h] = line.split('\t');
            if (p === relPath) seen = h;            // last wins: the most recent review
        }
        if (!seen) return 'never reviewed';
        if (seen !== blob) return 'changed since its last review';
        return null;
    } catch (e) {
        // FAIL LOUD, NOT OPEN. The first version returned null here, so when
        // vaultRoot was undefined the join threw, the gate reported "reviewed"
        // for everything, and nothing looked wrong. A broken check is not the
        // same as a clean document, and the person exporting should be the one
        // who decides what to do about it.
        return `unverifiable — the review check failed (${String(e).slice(0, 80)})`;
    }
}

// ── API credits ───────────────────────────────────────────────────────────────

// WHAT THIS IS NOT. The Plan Usage section above reports a limit Anthropic
// imposes and reports back; it is authoritative. This one is arithmetic we do
// ourselves - tokens the provider reported, multiplied by prices.json - because
// neither provider exposes a prepaid balance to an ordinary API key. It can
// drift from the real invoice, so it says "local estimate" on its face and
// carries the date the prices were last checked. That date matters: the OpenAI
// rows were guessed from memory until 2026-09-20 and every one was low, so this
// widget would have shown roughly half the true spend and looked just as sure.
async function readApiCredits(vaultRoot) {
    const cfgPath    = pathMod.join(vaultRoot, 'analysis', 'scripts', 'api', 'credits.json');
    const pricePath  = pathMod.join(vaultRoot, 'analysis', 'scripts', 'api', 'prices.json');
    const ledgerPath = pathMod.join(vaultRoot, '.claude', 'api_ledger.jsonl');
    if (!fs.existsSync(cfgPath)) return null;

    let cfg, prices = { models: {} };
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch { return null; }
    try { prices = JSON.parse(fs.readFileSync(pricePath, 'utf-8')); } catch { /* provider map only */ }

    const providerOf = model => prices.models?.[model]?.provider ?? null;
    const spent = {}, jobs = [];
    let firstTs = null, lastTs = null, unattributed = 0;

    if (fs.existsSync(ledgerPath)) {
        for (const line of fs.readFileSync(ledgerPath, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line);
                const prov = providerOf(r.model);
                const usd  = Number(r.usd) || 0;
                // An unmapped model is money we cannot attribute. Silently
                // dropping it would make the widget read low, which is the
                // direction that matters, so it is surfaced instead.
                if (prov) spent[prov] = (spent[prov] || 0) + usd;
                else unattributed += usd;
                jobs.push({ ts: r.ts, job: r.job, model: r.model, usd, provider: prov });
                const t = Date.parse(r.ts);
                if (!isNaN(t)) {
                    if (firstTs === null || t < firstTs) firstTs = t;
                    if (lastTs  === null || t > lastTs)  lastTs  = t;
                }
            } catch { /* skip a malformed line rather than lose the section */ }
        }
    }

    const now = Date.now();
    const spanDays = (firstTs !== null && lastTs > firstTs)
        ? (lastTs - firstTs) / 86400000 : null;

    const accounts = (cfg.accounts || []).map(a => {
        const used = spent[a.provider] || 0;
        const left = Math.max(0, a.granted_usd - used);
        const daysLeft = Math.max(0, Math.ceil((Date.parse(a.expires) - now) / 86400000));
        // Burn rate needs a span to divide by. One burst in one afternoon gives
        // no defensible rate, and inventing one would be the whole point of the
        // widget going wrong, so it stays null and the UI says so.
        const perDay = (spanDays && spanDays >= 1) ? used / spanDays : null;
        return {
            ...a, used, left, daysLeft,
            pctUsed: a.granted_usd ? used / a.granted_usd * 100 : 0,
            projectedUse: perDay !== null ? (used + perDay * daysLeft) / a.granted_usd * 100 : null,
        };
    });

    return {
        accounts,
        jobs: jobs.slice(-5).reverse(),
        totalJobs: jobs.length,
        unattributed,
        pricesVerified: prices._verified || null,
        understated: cfg.understated_before || null,
    };
}

// ── Input modal ───────────────────────────────────────────────────────────────

class InputModal extends Modal {
    constructor(app, title, placeholder, onSubmit) {
        super(app);
        this.modalTitle = title;
        this.placeholder = placeholder;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('jcc-modal');
        contentEl.createEl('h3', { text: this.modalTitle, cls: 'jcc-modal-title' });

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: this.placeholder,
            cls: 'jcc-modal-input',
        });

        const row = contentEl.createDiv('jcc-modal-row');
        const btn = row.createEl('button', { text: 'Run', cls: 'mod-cta' });
        const cancel = row.createEl('button', { text: 'Cancel' });

        btn.onclick = () => {
            const v = input.value.trim();
            if (v) { this.onSubmit(v); this.close(); }
        };
        cancel.onclick = () => this.close();
        input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
        setTimeout(() => input.focus(), 60);
    }

    onClose() {
        // Drop the plugin's handle so a stale modal cannot be driven after exit.
        try { if (this._onDispose) this._onDispose(); } catch (e) {}
        // Raw listener, so it must be removed explicitly — with the SAME
        // capture flag, or removeEventListener silently does nothing.
        // Raw listeners must be removed with the SAME capture flag — a
        // mismatched flag makes removeEventListener silently do nothing and
        // the listener would outlive the presentation.
        // Remove from the SAME objects that were bound, with the same capture
        // flag — a mismatch makes removeEventListener silently do nothing.
        if (this._onWinCap && this._win) this._win.removeEventListener('keydown', this._onWinCap, true);
        if (this._onDocCap && this._doc) this._doc.removeEventListener('keydown', this._onDocCap, true);
        if (this._onWinCap2) window.removeEventListener('keydown', this._onWinCap2, true);
        if (this._onDocCap2) document.removeEventListener('keydown', this._onDocCap2, true);
        this.contentEl.empty();
    }
}

// ── Textarea modal ────────────────────────────────────────────────────────────

class TextareaModal extends Modal {
    // `initial` is optional and last, so every existing call site is unchanged.
    // It exists for the tracker's free-text cells: an "Edit…" that opens empty
    // would silently discard whatever the cell already said.
    constructor(app, title, placeholder, submitLabel, onSubmit, initial) {
        super(app);
        this.modalTitle = title;
        this.placeholder = placeholder;
        this.submitLabel = submitLabel || 'Submit';
        this.onSubmit = onSubmit;
        this.initial = initial || '';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('jcc-modal');
        contentEl.createEl('h3', { text: this.modalTitle, cls: 'jcc-modal-title' });

        const ta = contentEl.createEl('textarea', {
            placeholder: this.placeholder,
            cls: 'jcc-modal-textarea',
        });
        if (this.initial) ta.value = this.initial;

        const row = contentEl.createDiv('jcc-modal-row');
        const btn = row.createEl('button', { text: this.submitLabel, cls: 'mod-cta' });
        const cancel = row.createEl('button', { text: 'Cancel' });

        btn.onclick = () => { this.onSubmit(ta.value.trim()); this.close(); };
        cancel.onclick = () => this.close();
        ta.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) btn.click();
        });
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 60);
    }

    onClose() { this.contentEl.empty(); }
}

// ── Output modal ──────────────────────────────────────────────────────────────

class OutputModal extends Modal {
    constructor(app, title, content, { isMarkdown = false, filePath = null } = {}) {
        super(app);
        this.modalTitle = title;
        this.content = content;
        this.isMarkdown = isMarkdown;
        this.filePath = filePath;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('jcc-output-modal');
        contentEl.createEl('h3', { text: this.modalTitle, cls: 'jcc-modal-title' });

        if (this.isMarkdown) {
            const div = contentEl.createDiv('jcc-output-markdown');
            await MarkdownRenderer.render(this.app, this.content, div, this.filePath || '', null);
        } else {
            const pre = contentEl.createEl('pre', { cls: 'jcc-output-pre' });
            pre.textContent = this.content;
        }

        const row = contentEl.createDiv('jcc-modal-row');
        if (this.filePath) {
            const openBtn = row.createEl('button', { text: 'Open in Obsidian', cls: 'mod-cta' });
            openBtn.onclick = () => {
                this.app.workspace.openLinkText(this.filePath, '', false);
                this.close();
            };
        }
        row.createEl('button', { text: 'Close', cls: this.filePath ? '' : 'mod-cta' }).onclick = () => this.close();
    }

    onClose() { this.contentEl.empty(); }
}

// ── Zotero suggest modal ──────────────────────────────────────────────────────

class ZoteroSuggestModal extends SuggestModal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder('Search Zotero library, or paste a DOI / PMID…');
        this.setInstructions([
            { command: '↑↓', purpose: 'navigate' },
            { command: '↵', purpose: 'ingest paper' },
            { command: 'esc', purpose: 'cancel' },
        ]);
        this._papers = this._loadPapers();
    }

    _loadPapers() {
        return this.app.vault.getFiles()
            .filter(f => f.path.startsWith('literature/zotero/') && f.name.endsWith('.md'))
            .map(f => {
                const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
                const authors = Array.isArray(fm.authors) ? fm.authors : (fm.authors ? [fm.authors] : []);
                return {
                    title:   fm.title   || f.basename,
                    authors,
                    year:    fm.year    ? String(fm.year) : '',
                    journal: fm.journal || '',
                    doi:     fm.doi     || '',
                    path:    f.path,
                };
            })
            .filter(p => p.title)
            .sort((a, b) => (b.year || '').localeCompare(a.year || ''));
    }

    getSuggestions(query) {
        const q = query.trim().toLowerCase();

        // Direct DOI / PMID passthrough — show as first item
        const isDOI  = /^10\.\d{4}/.test(query.trim());
        const isPMID = /^\d{7,9}$/.test(query.trim());
        const direct = (q && (isDOI || isPMID))
            ? [{ _direct: true, title: `Use "${query.trim()}" as identifier`, identifier: query.trim() }]
            : [];

        if (!q) return [...direct, ...this._papers.slice(0, 25)];

        const filtered = this._papers.filter(p => {
            const authorStr = p.authors.join(' ').toLowerCase();
            return p.title.toLowerCase().includes(q)
                || authorStr.includes(q)
                || p.journal.toLowerCase().includes(q)
                || p.year.includes(q)
                || p.doi.toLowerCase().includes(q);
        }).slice(0, 25);

        return [...direct, ...filtered];
    }

    renderSuggestion(paper, el) {
        if (paper._direct) {
            el.addClass('jcc-zotero-direct');
            el.createEl('span', { text: paper.title, cls: 'jcc-zotero-direct-label' });
            return;
        }
        const firstAuthor = paper.authors[0]
            ? paper.authors[0].split(',')[0].trim().split(' ').pop()
            : 'Unknown';
        const authorStr = paper.authors.length > 1 ? `${firstAuthor} et al.` : firstAuthor;
        const meta = [authorStr, paper.year, paper.journal].filter(Boolean).join(' · ');

        el.addClass('jcc-zotero-item');
        el.createEl('div', { text: paper.title,  cls: 'jcc-zotero-title' });
        el.createEl('div', { text: meta,          cls: 'jcc-zotero-meta' });
    }

    onOpen() {
        super.onOpen();
        // SuggestModal doesn't populate suggestions until first input event
        this.inputEl.dispatchEvent(new InputEvent('input'));
    }

    onChooseSuggestion(paper, _evt) {
        const identifier = paper._direct ? paper.identifier : (paper.doi || paper.title);
        this.onChoose(identifier);
    }
}

// ── Main view ─────────────────────────────────────────────────────────────────

class CommandCenterView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin        = plugin;
        this._refreshTimer = null;
        this._gameSection  = null;
        this._gameCleanup  = null;
    }

    getViewType()    { return VIEW_TYPE; }
    getDisplayText() { return 'Command Center'; }
    getIcon()        { return 'microscope'; }

    async onOpen()  {
        await this.render();
        this._appendGame();
        this._refreshTimer = setInterval(() => this.render(), 60_000);
    }

    onClose() {
        if (this._refreshTimer) clearInterval(this._refreshTimer);
        if (this._gameCleanup)  this._gameCleanup();
    }

    get vaultRoot() {
        return this.app.vault.adapter.basePath;
    }

    // ── Top-level render ────────────────────────────────────────────────────

    async render() {
        const root = this.containerEl.children[1];
        const savedGame = this._gameSection;
        root.empty();
        root.addClass('jcc-root');

        this._renderHeader(root);
        this._renderTribunal(root);

        const [objectives, experiments, cellCultures, deadlines, tokens, credits] = await Promise.all([
            this._getObjectives(),
            this._getExperiments(),
            this._getCellCultureTasks(),
            this._getDeadlines(),
            readTokenUsage(this.vaultRoot),
            readApiCredits(this.vaultRoot),
        ]);

        this._renderTokens(root, tokens);
        if (credits?.accounts?.length) this._renderApiCredits(root, credits);
        if (this._timers?.length) this._renderTimers(root);
        // EMPTY SECTIONS DO NOT RENDER. A column of boxes each saying "none" reads
        // as broken rather than as quiet, so a section appears only when it has
        // something to say. The empty branches inside each renderer stay put as a
        // guard for direct calls.
        if (objectives?.items?.length) this._renderObjectives(root, objectives);
        if (experiments.length)        this._renderExperiments(root, experiments);
        if (cellCultures.length)       this._renderCellCultureTasks(root, cellCultures);
        if (deadlines.length)          this._renderDeadlines(root, deadlines);
        this._renderActions(root);
        if (savedGame) root.appendChild(savedGame);
    }

    // ── Header ──────────────────────────────────────────────────────────────

    _renderHeader(root) {
        const h = root.createDiv('jcc-header');
        const orb = h.createEl('button', { cls: 'jcc-orb', title: 'Ask JARVIS…' });
        orb.innerHTML = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="jcc-core-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#ffffff"  stop-opacity="1"/>
      <stop offset="20%"  stop-color="#aaffff"  stop-opacity="1"/>
      <stop offset="55%"  stop-color="#00aaff"  stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#003399"  stop-opacity="0"/>
    </radialGradient>
    <filter id="jcc-glow-filter" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="1.8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Outermost static ring + 36 tick marks -->
  <circle cx="32" cy="32" r="30" fill="none" stroke="#00D4FF" stroke-opacity="0.07" stroke-width="0.4"/>
  <g stroke="#00D4FF">
    ${Array.from({length:36},(_,i)=>{const a=i*10*Math.PI/180,major=i%9===0,minor=i%3===0,r1=major?26.2:(minor?27.4:28.3),op=major?0.70:(minor?0.38:0.18),sw=major?1.3:(minor?0.65:0.32),x1=(32+r1*Math.cos(a)).toFixed(2),y1=(32+r1*Math.sin(a)).toFixed(2),x2=(32+30*Math.cos(a)).toFixed(2),y2=(32+30*Math.sin(a)).toFixed(2);return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${sw}" stroke-opacity="${op}"/>`;}).join('')}
  </g>

  <!-- Radar sweep — fast CW on outer ring -->
  <g class="jcc-ring-scan">
    <path fill="none" stroke="#80ffff" stroke-width="2.4" stroke-linecap="round" opacity="0.9"
          d="M 32 2 A 30 30 0 0 1 39.76 3.02"/>
    <path fill="none" stroke="#00D4FF" stroke-width="1.7" stroke-linecap="round" opacity="0.45"
          d="M 39.76 3.02 A 30 30 0 0 1 49.21 7.43"/>
    <path fill="none" stroke="#0066FF" stroke-width="0.9" opacity="0.18"
          d="M 49.21 7.43 A 30 30 0 0 1 57.98 17"/>
    <circle cx="32" cy="2" r="2" fill="#ccffff" opacity="0.95"/>
  </g>

  <!-- Ring A (r=24) — slow CW -->
  <g class="jcc-ring-outer">
    <circle cx="32" cy="32" r="24" fill="none" stroke="#00D4FF" stroke-opacity="0.09" stroke-width="0.4"
            stroke-dasharray="4 3"/>
    <path fill="none" stroke="#00D4FF" stroke-width="1.7" stroke-linecap="round"
          d="M 32 8 A 24 24 0 0 1 56 32"/>
    <path fill="none" stroke="#0055EE" stroke-width="1.1" stroke-linecap="round"
          d="M 32 56 A 24 24 0 0 1 8 32"/>
    <path fill="none" stroke="#00AAFF" stroke-width="0.55" stroke-dasharray="5 3"
          d="M 49 15 A 24 24 0 0 1 53.75 21.86"/>
    <circle cx="32" cy="8"  r="1.7" fill="#00EEFF"/>
    <circle cx="56" cy="32" r="1.2" fill="#0099FF"/>
    <circle cx="32" cy="56" r="1.0" fill="#0055EE"/>
    <circle cx="8"  cy="32" r="1.0" fill="#0055EE"/>
  </g>

  <!-- Ring B (r=17) — medium CCW -->
  <g class="jcc-ring-mid">
    <circle cx="32" cy="32" r="17" fill="none" stroke="#00D4FF" stroke-opacity="0.11" stroke-width="0.4"
            stroke-dasharray="2.5 2"/>
    <path fill="none" stroke="#00D4FF" stroke-width="1.4" stroke-linecap="round"
          d="M 32 15 A 17 17 0 0 0 15 32"/>
    <path fill="none" stroke="#0077FF" stroke-width="0.9" stroke-linecap="round"
          d="M 49 32 A 17 17 0 0 0 32 49"/>
    <path fill="none" stroke="#00CCFF" stroke-width="0.5" stroke-dasharray="4 3"
          d="M 44.02 20 A 17 17 0 0 0 47.5 26.5"/>
    <circle cx="32" cy="15" r="1.3" fill="#00DDFF"/>
    <circle cx="49" cy="32" r="0.9" fill="#0088FF"/>
  </g>

  <!-- Ring C (r=11) — fast CW -->
  <g class="jcc-ring-inner">
    <circle cx="32" cy="32" r="11" fill="none" stroke="#00D4FF" stroke-opacity="0.14" stroke-width="0.4"
            stroke-dasharray="1.5 2"/>
    <path fill="none" stroke="#00EEFF" stroke-width="1.3" stroke-linecap="round"
          d="M 32 21 A 11 11 0 0 1 43 32"/>
    <path fill="none" stroke="#0077FF" stroke-width="0.8" stroke-linecap="round"
          d="M 32 43 A 11 11 0 0 1 21 32"/>
    <circle cx="32" cy="21" r="1.2" fill="#00FFEE"/>
    <circle cx="43" cy="32" r="0.8" fill="#0088FF"/>
  </g>

  <!-- Radial spokes — inner (ring C → ring A) -->
  <g stroke="#00D4FF" stroke-opacity="0.18" stroke-width="0.35">
    <line x1="32" y1="21" x2="32" y2="8"/>
    <line x1="43" y1="32" x2="56" y2="32"/>
    <line x1="32" y1="43" x2="32" y2="56"/>
    <line x1="21" y1="32" x2="8"  y2="32"/>
  </g>
  <!-- Radial spokes — diagonal (ring A → outer ring) -->
  <g stroke="#00D4FF" stroke-opacity="0.12" stroke-width="0.3">
    <line x1="49" y1="15" x2="53.21" y2="10.79"/>
    <line x1="49" y1="49" x2="53.21" y2="53.21"/>
    <line x1="15" y1="49" x2="10.79" y2="53.21"/>
    <line x1="15" y1="15" x2="10.79" y2="10.79"/>
  </g>

  <!-- Hexagonal frame (static) — arc-reactor center motif -->
  <polygon points="32,24 38.93,28 38.93,36 32,40 25.07,36 25.07,28"
           fill="none" stroke="#00AAFF" stroke-opacity="0.32" stroke-width="0.55"/>
  <!-- Hex inner lattice -->
  <g stroke="#00D4FF" stroke-opacity="0.10" stroke-width="0.3">
    <line x1="32" y1="24" x2="32" y2="40"/>
    <line x1="25.07" y1="28" x2="38.93" y2="36"/>
    <line x1="38.93" y1="28" x2="25.07" y2="36"/>
  </g>

  <!-- Pulsing core glow -->
  <circle cx="32" cy="32" r="9.5" fill="url(#jcc-core-glow)" class="jcc-orb-pulse"
          filter="url(#jcc-glow-filter)"/>
  <!-- Solid core -->
  <circle cx="32" cy="32" r="4" fill="#00AAFF" opacity="0.95"/>
  <!-- Center highlight -->
  <circle cx="32" cy="32" r="1.7" fill="#ffffff"/>
  <!-- Crosshair -->
  <line x1="32" y1="29.2" x2="32" y2="34.8" stroke="#fff" stroke-width="0.4" stroke-opacity="0.6"/>
  <line x1="29.2" y1="32" x2="34.8" y2="32" stroke="#fff" stroke-width="0.4" stroke-opacity="0.6"/>
</svg>`;
        orb.onclick = () => {
            new InputModal(this.app, 'Ask JARVIS', 'What do you want to know?', (query) => {
                new Notice('JARVIS is thinking…');
                this._claudeExec(query, (stdout) => {
                    new OutputModal(this.app, 'JARVIS', stdout || '(no response)', { isMarkdown: true }).open();
                }, null, 180_000);
            }).open();
        };
        h.createEl('span', { text: 'JARVIS', cls: 'jcc-logo' });
        h.createEl('span', {
            text: new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
            cls: 'jcc-header-date',
        });
        const btn = h.createEl('button', { text: '↺', cls: 'jcc-icon-btn', title: 'Refresh' });
        btn.onclick = () => this.render();
    }

    // ── The Tribunal ────────────────────────────────────────────────────────

    // Directly under the orb, because its position is the argument: the two
    // things at the top of this panel are "ask Jarvis" and "have Jarvis judged".
    // Buried in the action grid it becomes one of fourteen buttons and gets
    // used the way a rule in CLAUDE.md gets followed - which is to say, when
    // someone remembers.
    _renderTribunal(root) {
        const sec = root.createDiv('jcc-section jcc-tribunal');
        const btn = sec.createEl('button', { cls: 'jcc-tribunal-btn' });

        // Wrapped so a ring can orbit it on hover: a pseudo-element needs an
        // element to hang off, and an <img> cannot carry one.
        const sigil = btn.createDiv('jcc-tribunal-sigil');
        const img = sigil.createEl('img', { cls: 'jcc-tribunal-img' });
        img.src = this.app.vault.adapter.getResourcePath(
            '.obsidian/plugins/jarvis-command-center/tribunal.png');
        img.alt = 'The Living Tribunal';

        const txt = btn.createDiv('jcc-tribunal-text');
        txt.createEl('div', { text: 'Consult the Tribunal', cls: 'jcc-tribunal-title' });
        // "Codex, then a cold read · TC_004_TH3_brief" read as a job in flight
        // when it was only naming the open file. The verb makes it a button
        // again: this is what WOULD happen, not what IS happening.
        //
        // AND IT HAS TO FOLLOW THE ACTIVE FILE. The panel renders once and then
        // sits there; the click resolves the target at click time, so a subtitle
        // fixed at render time will eventually name a different document than
        // the one that would actually be judged. Worse, a panel that rendered
        // before any note was open says "Open a document" forever. Repaint it
        // on file-open, and register that listener exactly once - render() runs
        // again on every refresh and would otherwise stack them.
        txt.createEl('div', { cls: 'jcc-tribunal-sub' });
        // A SECOND LINE, so a finished sitting does not squat on the one that
        // says what the button does. Showing the verdict INSTEAD of the action
        // left the row frozen on "Verdicts in on review_status.sh" with no way
        // back - the button still worked, but nothing on it said so.
        txt.createEl('div', { cls: 'jcc-tribunal-verdict' });
        this._paintTribunal();

        // THE CLICK HANDLER LIVES HERE, on the button. It was swallowed into
        // _paintTribunal by an earlier edit, where `btn` does not exist - and
        // because a restored "done" state returns before that line, the handler
        // was never assigned at all. The row looked alive and did nothing.
        btn.onclick = () => this.plugin.consultTribunal();

        // The subtitle has to follow the active file: the click resolves its
        // target at click time, so a line fixed at render would eventually name
        // a different document than the one that would be judged. Registered
        // once - render() runs again on every refresh and would stack them.
        if (!this._tribunalWired) {
            this._tribunalWired = true;
            this.registerEvent(this.app.workspace.on('file-open', () => this._paintTribunal()));
            // While a run is in flight the line counts minutes, so an idle
            // panel still shows progress rather than a frozen "judging…".
            this.registerInterval(window.setInterval(() => {
                if (this.plugin.tribunalState?.status === 'running') this._paintTribunal();
            }, 30_000));
        }
    }

    // One place that decides what the row says, because three call sites
    // writing the same string is how they drift apart.
    _paintTribunal() {
        const el = this.containerEl.querySelector('.jcc-tribunal-sub');
        if (!el) return;
        const st = this.plugin.tribunalState;
        const mins = t => Math.max(0, Math.round((Date.now() - t) / 60000));

        if (st?.status === 'running') {
            const m = mins(st.startedAt);
            el.textContent = `⏳ Judging ${st.name} — ${m ? `${m}m elapsed` : 'just started'}`;
            el.classList.add('jcc-tribunal-busy');
            return;
        }
        el.classList.remove('jcc-tribunal-busy');

        const vd = this.containerEl.querySelector('.jcc-tribunal-verdict');
        if (vd) {
            if (st?.status === 'done') {
                vd.textContent = `✅ last sitting: ${st.name}, ${mins(st.endedAt)}m ago — ask Claude to read it`;
            } else if (st?.status === 'failed') {
                vd.textContent = `⚠️ last sitting failed on ${st.name}: ${st.why}`;
            } else {
                vd.textContent = '';
            }
        }
        const f = this.app.workspace.getActiveFile();
        el.textContent = f && f.extension === 'md'
            ? `Judge ${f.basename} — Codex, then a blinded cold read`
            : 'Open a document to have it judged';
    }

    // ── Token usage ─────────────────────────────────────────────────────────
    _renderTokens(root, tokens) {
        const sec = root.createDiv('jcc-section');
        const hdr = sec.createDiv('jcc-token-header');
        hdr.createEl('span', { text: 'Plan Usage', cls: 'jcc-section-title' });
        const link = hdr.createEl('a', { text: '→', cls: 'jcc-token-link' });
        link.onclick = () => window.open('https://claude.ai/settings/limits', '_blank');

        const fmtReset = secs => {
            if (!secs) return '';
            const ms = secs * 1000 - Date.now();
            if (ms <= 0) return 'resetting…';
            const mins = Math.ceil(ms / 60_000);
            if (mins < 60)  return `resets ${mins}m`;
            const hrs = Math.ceil(ms / 3_600_000);
            if (hrs < 48)   return `resets ${hrs}h`;
            return `resets ${Math.ceil(ms / 86_400_000)}d`;
        };

        if (tokens.fromCache) {
            // Accurate: direct from Anthropic API headers via jarvis_status.py
            const p5  = tokens.fiveHourPct  ?? 0;
            const p7  = tokens.sevenDayPct  ?? 0;
            this._progressBar(sec, '5-hour limit',        p5,  100, fmtReset(tokens.fiveHourResetsAt));
            this._progressBar(sec, 'Weekly · all models', p7,  100, fmtReset(tokens.sevenDayResetsAt));
            if (tokens.model) {
                const age = Math.round(tokens.cacheAgeMs / 60_000);
                sec.createEl('div', { text: `${tokens.model} · updated ${age}m ago`, cls: 'jcc-token-meta' });
            }
        } else {
            // Fallback: estimated from JSONL token counts
            const now = Date.now();
            const MAX_5H_OUT   = 620_000;
            const MAX_WEEK_OUT = 16_500_000;
            const reset5h   = tokens.oldest5h   ? Math.max(0, (tokens.oldest5h   + 5 * 3600_000 - now) / 1000) : null;
            const resetWeek = tokens.oldestWeek ? Math.max(0, (tokens.oldestWeek + 7 * 86400_000 - now) / 1000) : null;
            const pct5h   = tokens.window5h.output / MAX_5H_OUT * 100;
            const pctWeek = tokens.weekly.output   / MAX_WEEK_OUT * 100;
            this._progressBar(sec, '5-hour limit',        pct5h,   100, fmtReset(reset5h));
            this._progressBar(sec, 'Weekly · all models', pctWeek, 100, fmtReset(resetWeek));
            sec.createEl('div', { text: 'estimated · open Claude Code to sync', cls: 'jcc-token-meta' });
        }
    }

    // ── API credits ─────────────────────────────────────────────────────────
    _renderApiCredits(root, credits) {
        const sec = root.createDiv('jcc-section');
        const hdr = sec.createDiv('jcc-token-header');
        hdr.createEl('span', { text: 'API Credits', cls: 'jcc-section-title' });
        const link = hdr.createEl('a', { text: '→', cls: 'jcc-token-link' });
        link.onclick = () => window.open(credits.accounts[0].console, '_blank');

        const usd = n => (n >= 100 ? '$' + n.toFixed(0) : '$' + n.toFixed(2));

        // JUST THE BALANCE. A bar reading "100% left" for a year says nothing;
        // the dollars remaining is the thing worth glancing at. Expiry rides
        // along in small text because these credits lapse long before this
        // burn rate could spend them.
        const bal = n => '$' + n.toLocaleString('en-US',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        for (const a of credits.accounts) {
            const row = sec.createDiv('jcc-credit-row');
            row.createEl('span', { text: a.label, cls: 'jcc-credit-name' });
            const right = row.createDiv('jcc-credit-right');
            right.createEl('span', { text: bal(a.left), cls: 'jcc-credit-amount' });
            const expiry = a.daysLeft > 60
                ? `${Math.round(a.daysLeft / 30)}mo left`
                : `${a.daysLeft}d left`;
            right.createEl('span', { text: expiry, cls: 'jcc-credit-expiry' });
        }

        const totals = credits.accounts.reduce((t, a) => t + a.used, 0);
        const parts = [`${usd(totals)} spent · ${credits.totalJobs} jobs`];

        // The line worth reading: at this pace, how much simply expires.
        const worst = credits.accounts
            .filter(a => a.projectedUse !== null)
            .sort((x, y) => x.projectedUse - y.projectedUse)[0];
        if (worst && worst.projectedUse < 50) {
            parts.push(`on pace to use ${worst.projectedUse.toFixed(0)}% of ${worst.label} before it expires`);
        }
        sec.createEl('div', { text: parts.join(' · '), cls: 'jcc-token-meta' });

        if (credits.jobs.length) {
            const recent = credits.jobs
                .map(j => `${j.job} ${usd(j.usd)}`)
                .join('  ·  ');
            sec.createEl('div', { text: recent, cls: 'jcc-credit-jobs' });
        }

        // Provenance, always visible. This number is ours, not the provider's.
        const notes = ['local estimate'];
        if (credits.pricesVerified) {
            const dates = Object.values(credits.pricesVerified).sort();
            const ageDays = Math.floor((Date.now() - Date.parse(dates[0])) / 86400000);
            notes.push(ageDays > 90 ? `prices UNVERIFIED for ${ageDays}d` : `prices checked ${dates[0]}`);
        }
        if (credits.unattributed > 0.005) notes.push(`${usd(credits.unattributed)} unattributed`);
        if (credits.understated) notes.push(`pre-${credits.understated.ts.slice(0, 10)} ${credits.understated.provider} entries ~${credits.understated.factor}x low`);
        sec.createEl('div', { text: notes.join(' · '), cls: 'jcc-token-meta' });
    }

    _progressBar(parent, label, value, max, resetStr = '') {
        const wrap    = parent.createDiv('jcc-bar-wrap');
        const pct     = Math.min(value / max * 100, 100);
        const pctLeft = Math.max(0, 100 - pct);
        const row     = wrap.createDiv('jcc-bar-label-row');
        row.createEl('span', { text: label, cls: 'jcc-bar-label' });
        const right = row.createDiv('jcc-bar-right');
        right.createEl('span', { text: pctLeft.toFixed(0) + '% left', cls: 'jcc-bar-pct' });
        if (resetStr) right.createEl('span', { text: ' · ' + resetStr, cls: 'jcc-bar-reset' });
        const track = wrap.createDiv('jcc-bar-track');
        const fill  = track.createDiv('jcc-bar-fill');
        fill.style.width = pctLeft + '%';
        if (pctLeft < 10)      fill.addClass('danger');
        else if (pctLeft < 30) fill.addClass('warn');
    }

    // ── Today's objectives ──────────────────────────────────────────────────

    async _getObjectives() {
        const file = this.app.vault.getAbstractFileByPath(`daily-notes/${todayStr()}.md`);
        if (!(file instanceof TFile)) return null;

        const text = await this.app.vault.read(file);
        const items = [];
        let inside = false;
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^##\s+.*(plan|tasks?|todo|objective)/i.test(line)) { inside = true; continue; }
            if (inside && /^##/.test(line)) break;
            if (!inside) continue;
            const chk = line.match(/^[-*]\s+\[([x ])\]\s+(.+)/i);
            if (!chk) continue;
            const raw = chk[2].trim()
                .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
                .replace(/\*\*(.+?)\*\*/g, '$1')
                .replace(/→\s*\[\[.*?\]\]/g, '')
                .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
                .trim().replace(/\s+/g, ' ');
            items.push({ done: chk[1].toLowerCase() === 'x', text: raw, lineIndex: i });
        }
        return { items, file: file.path };
    }

    async _toggleObjective(filePath, lineIndex) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;
        const text = await this.app.vault.read(file);
        const lines = text.split('\n');
        if (lineIndex >= lines.length) return;
        const line = lines[lineIndex];
        const nowChecked = !/\[x\]/i.test(line);
        lines[lineIndex] = nowChecked
            ? line.replace(/\[ \]/, '[x]')
            : line.replace(/\[x\]/i, '[ ]');
        await this.app.vault.modify(file, lines.join('\n'));
        await this._syncTaskToWeeklyPlan(line, nowChecked);
        await this.render();
    }

    _normalizeTask(raw) {
        return raw
            .replace(/^[-*]\s+\[[x ]\]\s+/i, '')
            .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
            .replace(/\s+/g, ' ').trim().toLowerCase();
    }

    async _syncTaskToWeeklyPlan(dailyLine, nowChecked) {
        const normalized = this._normalizeTask(dailyLine);
        if (normalized.length < 5) return;

        // Monday of current week
        const today = new Date();
        const monday = new Date(today);
        monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
        const weekStr = monday.toISOString().split('T')[0];

        const planFile = this.app.vault.getAbstractFileByPath(
            `weekly-plans/${weekStr}_weekly-plan.md`
        );
        if (!(planFile instanceof TFile)) return;

        const planText  = await this.app.vault.read(planFile);
        const planLines = planText.split('\n');
        const idx = planLines.findIndex(pl =>
            /^[-*]\s+\[[x ]\]/i.test(pl) && this._normalizeTask(pl) === normalized
        );
        if (idx === -1) return;

        planLines[idx] = nowChecked
            ? planLines[idx].replace(/\[ \]/, '[x]')
            : planLines[idx].replace(/\[x\]/i, '[ ]');
        await this.app.vault.modify(planFile, planLines.join('\n'));
    }

    _renderObjectives(root, data) {
        const sec = this._section(root, '📋 Today\'s Objectives');

        if (!data) {
            const empty = sec.createDiv('jcc-empty');
            empty.createEl('span', { text: 'No daily note yet. ' });
            const lnk = empty.createEl('a', { text: 'Open daily notes →', cls: 'jcc-link' });
            lnk.onclick = () => this.app.workspace.openLinkText('daily-notes', '', false);
            return;
        }

        if (!data.items.length) {
            sec.createEl('div', { text: 'No tasks found in today\'s note.', cls: 'jcc-empty' });
            return;
        }

        const done = data.items.filter(i => i.done).length;
        const total = data.items.length;
        const pct = Math.round((done / total) * 100);

        const progressWrap = sec.createDiv('jcc-obj-progress');
        const bar = progressWrap.createDiv('jcc-obj-bar');
        bar.style.width = `${pct}%`;

        const ol = sec.createEl('ol', { cls: 'jcc-obj-list' });
        for (const item of data.items) {
            const li = ol.createEl('li', { cls: 'jcc-obj-item' + (item.done ? ' done' : '') });
            const chk = li.createEl('input', { cls: 'jcc-obj-check' });
            chk.type = 'checkbox';
            chk.checked = item.done;
            chk.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this._toggleObjective(data.file, item.lineIndex);
            });
            li.createEl('span', { text: item.text, cls: 'jcc-obj-text' });
        }

        const footer = sec.createDiv('jcc-obj-footer');
        footer.createEl('span', { text: `${done} / ${total} complete`, cls: 'jcc-muted' });
        const openBtn = footer.createEl('a', { text: 'Open note →', cls: 'jcc-link' });
        openBtn.onclick = () => this.app.workspace.openLinkText(data.file, '', false);
    }

    // ── Active experiments ──────────────────────────────────────────────────

    async _getExperiments() {
        const allFiles = this.app.vault.getFiles();
        return allFiles
            .filter(f => f.path.startsWith('experiments/TC_') && f.name.endsWith('_overview.md'))
            .map(f => {
                const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
                const folder = f.parent?.path || '';

                // Find day files: TC_XXX_dayN_YYYY-MM-DD.md
                const dayFiles = allFiles
                    .filter(df => df.parent?.path === folder && /TC_\d+_day\d+/.test(df.name))
                    .map(df => ({ file: df, day: parseInt(df.name.match(/_day(\d+)/)?.[1] || '0', 10) }))
                    .sort((a, b) => b.day - a.day);

                const lastDayFile = dayFiles[0]?.file || null;
                const latestDay = dayFiles[0]?.day || 0;
                const lastDateMatch = lastDayFile?.name.match(/(\d{4}-\d{2}-\d{2})/);
                const lastDate = lastDateMatch?.[1] || '';

                // Relative days since last activity
                let daysSince = null;
                if (lastDate) {
                    const d = new Date(lastDate + 'T12:00:00');
                    const now = new Date(); now.setHours(0,0,0,0);
                    daysSince = Math.round((now - d) / 86400000);
                }

                return {
                    id:          fm.experiment_id || f.name.match(/TC_\d+/)?.[0] || '?',
                    status:      fm.status || 'active',
                    started:     fm.date_started || '',
                    path:        f.path,
                    dayCount:    dayFiles.length,
                    latestDay,
                    lastDate,
                    daysSince,
                    lastDayPath: lastDayFile?.path || '',
                };
            })
            .filter(e => e.status === 'active')
            .sort((a, b) => b.id.localeCompare(a.id));
    }

    _renderExperiments(root, exps) {
        const sec = this._section(root, '🔬 Active Experiments');

        if (!exps.length) {
            sec.createEl('div', { text: 'No active experiments.', cls: 'jcc-empty' });
            return;
        }

        for (const exp of exps) {
            const row = sec.createDiv('jcc-exp-row');

            const left = row.createDiv('jcc-exp-left');
            const id = left.createEl('span', { text: exp.id, cls: 'jcc-exp-id' });
            id.onclick = () => this.app.workspace.openLinkText(exp.path, '', false);

            if (exp.dayCount > 0) {
                const dayBadge = left.createEl('span', {
                    text: `Day ${exp.latestDay}`,
                    cls: 'jcc-badge jcc-badge-active',
                    title: 'Click to open latest day file',
                });
                if (exp.lastDayPath) {
                    dayBadge.style.cursor = 'pointer';
                    dayBadge.onclick = e => {
                        e.stopPropagation();
                        this.app.workspace.openLinkText(exp.lastDayPath, '', false);
                    };
                }
            } else {
                left.createEl('span', { text: exp.status, cls: 'jcc-badge jcc-badge-active' });
            }

            const right = row.createDiv('jcc-exp-right');
            if (exp.daysSince !== null) {
                const label = exp.daysSince === 0 ? 'today'
                            : exp.daysSince === 1 ? '1d ago'
                            : `${exp.daysSince}d ago`;
                const cls = exp.daysSince > 7 ? 'jcc-muted jcc-stale' : 'jcc-muted';
                right.createEl('span', { text: label, cls });
            } else if (exp.started) {
                right.createEl('span', { text: fmtDate(exp.started), cls: 'jcc-muted' });
            }
        }
    }

    // ── Cell cultures ───────────────────────────────────────────────────────

    async _getCellCultureTasks() {
        const today = new Date(); today.setHours(0,0,0,0);
        const soon  = new Date(today); soon.setDate(soon.getDate() + 2);

        const tasks = [];
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith('reagents/') && !f.name.includes('tracker') && !f.name.includes('base'));

        for (const file of files) {
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (!fm || fm.type !== 'cell-line' || fm.status !== 'active') continue;

            const text  = await this.app.vault.read(file);
            let inside  = false;
            for (const line of text.split('\n')) {
                if (/^##\s+.*upcoming.*culture/i.test(line)) { inside = true; continue; }
                if (inside && /^##/.test(line)) break;
                if (!inside) continue;
                const chk = line.match(/^[-*]\s+\[ \]\s+(.+?)📅\s*(\d{4}-\d{2}-\d{2})/);
                if (!chk) continue;
                const due = new Date(chk[2] + 'T00:00:00');
                if (due > soon) continue;
                const days = Math.round((due - today) / 864e5);
                tasks.push({
                    name: fm.name || file.basename,
                    task: chk[1].trim(),
                    days,
                    status: days < 0 ? 'overdue' : days === 0 ? 'today' : 'soon',
                    path: file.path,
                });
            }
        }
        return tasks.sort((a, b) => a.days - b.days);
    }

    _renderCellCultureTasks(root, tasks) {
        const sec = this._section(root, '🧫 Cell Cultures');
        if (!tasks.length) {
            sec.createEl('div', { text: 'No cultures due in the next 2 days.', cls: 'jcc-empty' });
            return;
        }
        const ul = sec.createEl('ul', { cls: 'jcc-obj-list' });
        for (const t of tasks) {
            const li  = ul.createEl('li', { cls: 'jcc-exp-item' });
            const dot = t.status === 'overdue' ? '🔴' : t.status === 'today' ? '🟡' : '🟢';
            li.createEl('span', { text: dot + ' ' });
            const lnk = li.createEl('a', { text: t.name, cls: 'jcc-link' });
            lnk.onclick = () => this.app.workspace.openLinkText(t.path, '', false);
            li.createEl('span', { text: ' — ' + t.task, cls: 'jcc-muted' });
            const age = t.days < 0 ? `${Math.abs(t.days)}d overdue` : t.days === 0 ? 'Today' : `in ${t.days}d`;
            li.createEl('span', { text: '  · ' + age, cls: 'jcc-muted' });
        }
    }

    // ── Timer ────────────────────────────────────────────────────────────────

    _parseDuration(str) {
        str = str.trim().toLowerCase();
        const colon = str.match(/^(\d+):(\d{2})$/);
        if (colon) return parseInt(colon[1]) * 60 + parseInt(colon[2]);
        const sec = str.match(/^(\d+(?:\.\d+)?)\s*s(?:ec)?$/);
        if (sec) return Math.round(parseFloat(sec[1]));
        const min = str.match(/^(\d+(?:\.\d+)?)\s*(?:m(?:in)?)?$/);
        if (min) return Math.round(parseFloat(min[1]) * 60);
        return null;
    }

    _parseTimerInput(raw) {
        const text = raw.trim();
        // "label duration" — label is everything before the final duration token
        const m = text.match(/^(.*?)\s*(\d+:\d{2}|\d+(?:\.\d+)?\s*(?:m(?:in)?|s(?:ec)?)?)$/i);
        if (m) {
            const secs = this._parseDuration(m[2]);
            if (secs !== null) return { label: m[1].trim() || 'Timer', secs };
        }
        const secs = this._parseDuration(text);
        return secs !== null ? { label: 'Timer', secs } : null;
    }

    _beep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            [0, 0.4, 0.8].forEach(t => {
                const o = ctx.createOscillator(), g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination);
                o.frequency.value = 880;
                g.gain.setValueAtTime(0.35, ctx.currentTime + t);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.35);
                o.start(ctx.currentTime + t);
                o.stop(ctx.currentTime + t + 0.35);
            });
            setTimeout(() => ctx.close(), 4000);
        } catch(e) {}
    }

    _startTimer(label, secs) {
        const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        const timer = { label, remaining: secs, total: secs, interval: null };
        this._timers = this._timers || [];
        this._timers.push(timer);

        const notice = new Notice(`⏱ ${label}: ${fmt(secs)}`, 0);
        this.render();

        // Countdown — updates notice only
        timer.interval = setInterval(() => {
            timer.remaining--;
            notice.messageEl.innerText = `⏱ ${label}: ${fmt(timer.remaining)}`;
            if (timer.remaining <= 0) {
                clearInterval(timer.interval);
                notice.hide();
                this._timers = this._timers.filter(t => t !== timer);
                new Notice(`⏱ Done — ${label}!`, 60000);
                this._beep();
                this.render();
                if (!this._timers.length) {
                    clearInterval(this._timerDisplayInterval);
                    this._timerDisplayInterval = null;
                }
            }
        }, 1000);

        // Separate DOM update interval — reads live refs each tick, skips stale ones
        if (!this._timerDisplayInterval) {
            this._timerDisplayInterval = setInterval(() => {
                const f = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
                for (const t of (this._timers || [])) {
                    if (t._timeEl?.isConnected) {
                        t._timeEl.innerText = f(t.remaining);
                        t._barEl.style.width = `${Math.round((1 - t.remaining / t.total) * 100)}%`;
                    }
                }
            }, 1000);
        }
    }

    _renderTimers(root) {
        const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        const sec = this._section(root, '⏱ Active Timers');
        for (const t of this._timers) {
            const row = sec.createDiv('jcc-timer-row');
            const pct = Math.round((1 - t.remaining / t.total) * 100);

            const top = row.createDiv('jcc-timer-top');
            top.createEl('span', { text: t.label, cls: 'jcc-timer-label' });
            t._timeEl = top.createEl('span', { text: fmt(t.remaining), cls: 'jcc-timer-time' });
            const cancel = top.createEl('button', { text: '✕', cls: 'jcc-timer-cancel' });
            cancel.onclick = () => {
                clearInterval(t.interval);
                this._timers = this._timers.filter(x => x !== t);
                this.render();
            };

            const wrap = row.createDiv('jcc-timer-bar-wrap');
            t._barEl = wrap.createDiv('jcc-timer-bar-fill');
            t._barEl.style.width = `${pct}%`;
        }
    }

    // ── Deadlines ───────────────────────────────────────────────────────────

    async _getDeadlines() {
        const files = this.app.vault.getFiles().filter(f =>
            f.path.startsWith('deadlines/') && f.name.endsWith('.md') && !f.name.includes('tracker')
        );

        return files
            .map(f => {
                const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
                return {
                    name:    fm.name || f.basename,
                    due:     fm.due_date || '',
                    type:    fm.type || 'other',
                    status:  fm.status || 'upcoming',
                    path:    f.path,
                };
            })
            .filter(d => {
                if (d.status === 'completed') return false;
                if (!d.name && !d.due) return false;
                const days = daysUntil(d.due);
                return days === null || days <= 30; // only show next 30 days + no-date
            })
            .sort((a, b) => {
                const da = a.due ? new Date(a.due) : new Date('9999');
                const db = b.due ? new Date(b.due) : new Date('9999');
                return da - db;
            });
    }

    _renderDeadlines(root, deadlines) {
        const sec = this._section(root, '📅 Upcoming Deadlines');

        if (!deadlines.length) {
            sec.createEl('div', { text: 'No upcoming deadlines.', cls: 'jcc-empty' });
            return;
        }

        for (const dl of deadlines) {
            const days = daysUntil(dl.due);
            const urg  = urgency(days);
            const row  = sec.createDiv(`jcc-dl-row jcc-dl-${urg}`);

            const left = row.createDiv('jcc-dl-left');
            left.createEl('span', { text: dl.name, cls: 'jcc-dl-name' });
            left.createEl('span', { text: dl.type, cls: 'jcc-badge' });

            const right = row.createDiv('jcc-dl-right');
            if (days !== null) {
                const label = days < 0  ? `${Math.abs(days)}d overdue`
                            : days === 0 ? 'Today!'
                            : days === 1 ? 'Tomorrow'
                            : `${days}d`;
                right.createEl('span', { text: label, cls: `jcc-dl-days jcc-dl-${urg}` });
            }
            right.createEl('span', { text: fmtDate(dl.due), cls: 'jcc-muted' });
        }
    }

    // ── Quick actions ───────────────────────────────────────────────────────

    _renderActions(root) {
        const sec = this._section(root, '⚡ Quick Actions');
        const grid = sec.createDiv('jcc-action-grid');

        const actions = [
            {
                icon: '📄', label: 'Ingest Paper', color: 'pink',
                desc: 'Paste a DOI/title/link (e.g. from Consensus)',
                run: () => new InputModal(this.app,
                    'Ingest Paper',
                    'Paste DOI, title, or link from Consensus…',
                    val => this._runSkillHeadless('ingest-paper', val, `Ingesting "${val.slice(0,40)}…"`)
                ).open(),
            },
            {
                icon: '📓', label: 'Log Today', color: 'teal',
                desc: 'Create experiment day file',
                run: () => new InputModal(this.app,
                    'Log Experiment Day',
                    'Experiment ID (e.g. TC_001)…',
                    val => this._runSkillHeadless('log-today', val, `Logging ${val}…`)
                ).open(),
            },
            {
                icon: '⏱', label: 'Timer', color: 'teal',
                desc: 'Countdown for protocol steps',
                run: () => new InputModal(this.app,
                    'Start Timer',
                    'e.g.  5  ·  5 min  ·  1:30  ·  lysis 5  ·  ice 15',
                    val => {
                        const parsed = this._parseTimerInput(val);
                        if (!parsed) { new Notice('Invalid — try "5", "5 min", "1:30", or "lysis 5"'); return; }
                        this._startTimer(parsed.label, parsed.secs);
                    }
                ).open(),
            },
            {
                icon: '🧫', label: 'Log Culture', color: 'pink',
                desc: 'Feed, passage, or count cells',
                run: () => new InputModal(this.app,
                    'Log Culture',
                    'Cell line (e.g. A20, RMA, 293T) — or leave blank for all active…',
                    val => this._runSkillHeadless('log-culture', val, `Logging culture${val ? ' for ' + val : ''}…`)
                ).open(),
            },
            {
                icon: '🔄', label: 'Refresh Cultures', color: 'purple',
                desc: 'Re-sync the culture tracker widget',
                run: () => this.plugin.refreshCultures(),
            },
            {
                icon: '♻️', label: 'Refresh Note', color: 'teal',
                desc: 'Re-render the open report + reload its figures',
                run: () => this.plugin.refreshNote(null, false),
            },
            {
                icon: '🧠', label: 'Query Wiki', color: 'navy',
                desc: 'Search experiment knowledge base',
                run: () => new InputModal(this.app,
                    'Query Wiki',
                    'Question about your data…',
                    val => this._runSkillOutput('query-wiki', val, 'Wiki Query')
                ).open(),
            },
            {
                icon: '🗓️', label: 'Weekly Plan', color: 'indigo',
                desc: 'Build this week\'s day-by-day plan',
                run: () => new TextareaModal(this.app,
                    'Weekly Plan',
                    'Anything extra this week?\n\ne.g. Advisor meeting Thursday 2pm\nConference abstract due Friday\nOrdering reagents Monday\nLeaving early Wednesday',
                    'Build Plan',
                    val => this._runSkillHeadless('weekly-plan', val, 'Building weekly plan… (takes ~10 min)', 600_000)
                ).open(),
            },
            {
                icon: '📋', label: 'Weekly Review', color: 'rose',
                desc: 'Start Friday review',
                run: () => this._runSkillHeadless('weekly-review', '', 'Creating weekly review…'),
            },
            {
                icon: '⌖', label: 'Fix Figures', color: 'rose',
                desc: 'Apply figure annotations to the figures',
                run: () => new InputModal(this.app,
                    'Fix Figures',
                    'Experiment or note (e.g. TC_002) — blank for the open note…',
                    val => this._runSkillHeadless('fix-figures', val,
                        `Applying figure annotations${val ? ' for ' + val : ''}…`, 600_000)
                ).open(),
            },
            {
                icon: '📑', label: 'Export PDF', color: 'indigo',
                desc: 'Share-ready PDF of a protocol, report, or proposal',
                run: () => new JccPdfExportModal(this.app, this.plugin).open(),
            },
            {
                icon: '🎤', label: 'Lab Meeting', color: 'rose',
                desc: 'Draft narrative + figure picks',
                run: () => new InputModal(this.app,
                    'Lab Meeting Prep',
                    'Experiment IDs to present (e.g. TC_003 TC_005), or leave blank for all active…',
                    val => this._runSkillOutput('lab-meeting-prep', val, 'Lab Meeting Prep')
                ).open(),
            },
            {
                icon: '🌉', label: 'Bridge Watcher', color: 'navy',
                desc: 'Start the Codex bridge and show its state',
                run: () => this._bridgeEnsure(),
            },
        ];

        for (const a of actions) {
            const btn = grid.createDiv(`jcc-action-btn jcc-accent-${a.color}`);
            const top = btn.createDiv('jcc-action-top');
            if (a.img) {
                // A file in the plugin folder, addressed through the vault
                // adapter. A bare relative path does not resolve from a plugin
                // view - Obsidian serves plugin assets on its own app:// origin,
                // and getResourcePath is the only thing that knows it.
                const el = top.createEl('img', { cls: 'jcc-action-icon jcc-action-img' });
                el.src = this.app.vault.adapter.getResourcePath(
                    `.obsidian/plugins/jarvis-command-center/${a.img}`);
                el.alt = a.label;
            } else {
                top.createEl('span', { text: a.icon, cls: 'jcc-action-icon' });
            }
            top.createEl('span', { text: a.label, cls: 'jcc-action-label' });
            btn.createEl('div', { text: a.desc, cls: 'jcc-action-desc' });
            btn.onclick = a.run;
        }
    }

    // ── Claude execution helpers ────────────────────────────────────────────

    _runSkillHeadless(skill, args, notice, timeout) {
        const n = new Notice(`⏳ ${notice}`, 0);
        let secs = 0;
        const timer = setInterval(() => {
            secs += 10;
            const m = Math.floor(secs / 60), s = secs % 60;
            const elapsed = m > 0 ? `${m}m ${s}s` : `${secs}s`;
            try { n.setMessage(`⏳ ${notice}\n${elapsed} elapsed…`); } catch {}
        }, 10_000);

        const cleanup = (ok) => {
            clearInterval(timer);
            n.hide();
            if (ok) {
                new Notice(`✓ ${skill} complete — check vault for updates.`, 8000);
                setTimeout(() => this.render(), 1000);
            }
        };

        const prompt = args ? `/${skill} ${args}` : `/${skill}`;
        this._claudeExec(prompt, null, () => cleanup(true), timeout, () => cleanup(false));
    }

    _runSkillOutput(skill, args, title) {
        const prompt = `/${skill} ${args}`;
        new Notice(`Running ${skill}…`);
        this._claudeExec(prompt, (stdout) => {
            new OutputModal(this.app, title, stdout).open();
        }, null);
    }

    // ── Codex bridge ────────────────────────────────────────────────────────
    //
    // The watcher has to run ON THE HOST: Codex sandboxes its own tool calls
    // with Seatbelt, which will not nest, so Claude Science cannot start it and
    // the script refuses rather than running one that drains nothing. A Claude
    // Code session starts it, but a Claude-Science-only morning needs a human.
    // This is that human's one click. `ensure` is idempotent, so pressing it
    // when the watcher is already up just reports the state.
    _bridgeEnsure() {
        const sh = 'analysis/scripts/codex_bridge_watch.sh';
        const cmd = `bash ${JSON.stringify(sh)} ensure && bash ${JSON.stringify(sh)} status`;
        new Notice('🌉 Checking the Codex bridge…', 2000);
        exec(cmd, { cwd: this.vaultRoot, timeout: 20_000 }, (err, stdout, stderr) => {
            if (err) {
                new Notice(`🌉 Bridge failed: ${(stderr || err.message || '').slice(0, 160)}`, 10_000);
                console.error('[JCC] bridge', err, stderr);
                return;
            }
            const pid = (stdout.match(/running \(pid (\d+)\)/) || [])[1];
            const queued = (stdout.match(/queued\s+(\d+)/) || [])[1] ?? '0';
            if (!pid) { new OutputModal(this.app, 'Codex bridge', stdout).open(); return; }
            const started = stdout.includes('[bridge] started');
            new Notice(`🌉 Bridge ${started ? 'started' : 'already up'} · pid ${pid} · ${queued} queued`, 6000);
        });
    }

    _claudeExec(prompt, onOutput, onDone, timeout = 120_000, onError) {
        const cmd = `claude -p ${JSON.stringify(prompt)}`;
        exec(cmd, { cwd: this.vaultRoot, timeout }, (err, stdout, stderr) => {
            if (err) {
                new Notice(`❌ Error: ${(err.message || stderr || 'Unknown').slice(0, 120)}`, 10000);
                console.error('[JCC]', err);
                if (onError) onError();
                return;
            }
            if (onOutput) onOutput(stdout || '(no output)');
            if (onDone)   onDone();
        });
    }

    // ── Dino game ───────────────────────────────────────────────────────────

    _appendGame() {
        const root = this.containerEl.children[1];
        this._gameSection = root.createDiv('jcc-section jcc-game-section');
        this._initDinoGame(this._gameSection);
    }

    _initDinoGame(container) {
        const hdr = container.createDiv('jcc-game-hdr');
        hdr.createEl('span', { text: '🦕 Dino Break', cls: 'jcc-section-title' });
        const hiEl    = hdr.createEl('span', { text: 'HI 00000', cls: 'jcc-game-meta' });
        const scoreEl = hdr.createEl('span', { text: '00000',    cls: 'jcc-game-meta jcc-game-score' });

        const canvas = container.createEl('canvas', { cls: 'jcc-game-canvas' });
        const W = 260, H = 90;
        canvas.width  = W;
        canvas.height = H;

        const ctx  = canvas.getContext('2d');
        const GY   = H - 14;   // ground y
        const DX   = 28;        // dino fixed x
        const GRAV = 0.40;
        const JV   = -7.0;

        let hi = parseInt(localStorage.getItem('jcc-dino-hi') || '0');
        hiEl.textContent = 'HI ' + String(hi).padStart(5, '0');

        let state = 'idle', dy = 0, dvy = 0, cacti = [];
        let score = 0, speed = 4, frame = 0, nextC = 90, deadTimer = 0;
        const reset = () => {
            state = 'running'; dy = 0; dvy = 0; cacti = [];
            score = 0; speed = 2.0; frame = 0; nextC = 180;
        };

        const jump = () => {
            if (state === 'idle')                      { reset(); return; }
            if (state === 'dead' && deadTimer <= 0)    { reset(); return; }
            if (state === 'running' && dy >= 0)        dvy = JV;
        };

        const update = () => {
            if (state === 'dead') { if (deadTimer > 0) deadTimer--; return; }
            if (state !== 'running') return;

            frame++;
            score = Math.floor(frame / 7);
            speed = 2.0 + Math.floor(score / 180) * 0.35;

            // physics
            dvy += GRAV; dy += dvy;
            if (dy >= 0) { dy = 0; dvy = 0; }

            // spawn cacti
            if (--nextC <= 0) {
                const h = 18 + Math.random() * 20;
                const w = 8  + Math.random() * 8;
                cacti.push({ x: W + 10, h, w });
                nextC = 95 + Math.random() * 90;
            }
            cacti.forEach(c => c.x -= speed);
            cacti = cacti.filter(c => c.x + c.w > -5);

            // collision — forgiving hitbox 12×18, 4px inset on each side
            const dhx = DX + 5, dhy = GY + dy - 18, dhw = 12, dhh = 18;
            for (const c of cacti) {
                if (dhx < c.x + c.w - 2 && dhx + dhw > c.x + 2 &&
                    dhy < GY - c.h + 2   && dhy + dhh > GY - c.h) {
                    state = 'dead'; deadTimer = 90;
                    if (score > hi) {
                        hi = score;
                        localStorage.setItem('jcc-dino-hi', hi);
                        hiEl.textContent = 'HI ' + String(hi).padStart(5, '0');
                    }
                }
            }
            scoreEl.textContent = String(score).padStart(5, '0');
        };

        const drawDino = () => {
            const base = GY + dy;
            const leg  = Math.floor(frame / 5) % 2;
            const col  = state === 'dead' ? '#f87171' : '#a78bfa';
            ctx.fillStyle = col;
            ctx.fillRect(DX,      base - 18, 18, 12); // body
            ctx.fillRect(DX + 7,  base - 28, 14, 12); // head
            ctx.fillRect(DX - 6,  base - 14, 8, 5);   // tail
            ctx.fillStyle = '#fff';
            ctx.fillRect(DX + 17, base - 26, 3, 3);   // eye white
            ctx.fillStyle = '#1a1a2e';
            ctx.fillRect(DX + 18, base - 25, 2, 2);   // eye pupil
            ctx.fillStyle = col;
            if (dy < -2) {                             // tucked legs (jumping)
                ctx.fillRect(DX + 4,  base - 7, 4, 7);
                ctx.fillRect(DX + 12, base - 5, 4, 5);
            } else if (leg === 0) {
                ctx.fillRect(DX + 4,  base - 8, 4, 8);
                ctx.fillRect(DX + 12, base - 4, 4, 4);
            } else {
                ctx.fillRect(DX + 4,  base - 4, 4, 4);
                ctx.fillRect(DX + 12, base - 8, 4, 8);
            }
        };

        const drawCactus = ({ x, h, w }) => {
            ctx.fillStyle = '#4ade80';
            const mx = x + w / 2;
            ctx.fillRect(mx - 3, GY - h, 6, h);                   // trunk
            ctx.fillRect(x, GY - h + Math.floor(h * 0.38), mx - 3 - x, 3);  // left arm
            ctx.fillRect(x, GY - h + Math.floor(h * 0.38) - 5, 3, 8);       // left arm top
            ctx.fillRect(mx + 3, GY - h + Math.floor(h * 0.52), x + w - mx - 3, 3); // right arm
            ctx.fillRect(x + w - 3, GY - h + Math.floor(h * 0.52) - 4, 3, 7);       // right arm top
        };

        const draw = () => {
            ctx.clearRect(0, 0, W, H);

            // ground
            ctx.fillStyle = 'rgba(130,130,150,0.35)';
            ctx.fillRect(0, GY, W, 1.5);

            // scrolling ground texture
            const texOff = (frame * speed * 0.5) % 44;
            ctx.fillStyle = 'rgba(130,130,150,0.2)';
            for (let i = 0; i < 7; i++) {
                const tx = (i * 44 - texOff % 44 + W) % W;
                ctx.fillRect(tx, GY + 2, 12 + (i % 3) * 6, 1);
            }

            cacti.forEach(drawCactus);
            drawDino();

            ctx.textAlign = 'center';
            if (state === 'idle') {
                ctx.fillStyle = 'rgba(160,160,180,0.8)';
                ctx.font = '9px sans-serif';
                ctx.fillText('click or Space to play', W / 2, GY / 2 + 4);
            } else if (state === 'dead') {
                ctx.fillStyle = '#f87171';
                ctx.font = 'bold 11px monospace';
                ctx.fillText('GAME OVER', W / 2, GY / 2 - 3);
                if (deadTimer <= 0) {
                    ctx.fillStyle = 'rgba(160,160,180,0.8)';
                    ctx.font = '9px sans-serif';
                    ctx.fillText('click or Space to restart', W / 2, GY / 2 + 10);
                }
            }
        };

        // Make canvas natively focusable so browser handles focus/blur naturally
        canvas.tabIndex = 0;
        canvas.style.outline = 'none';

        canvas.addEventListener('click', () => { canvas.focus(); jump(); });

        canvas.addEventListener('focus', () => {
            canvas.classList.add('jcc-game-focused');
        });

        canvas.addEventListener('blur', () => {
            canvas.classList.remove('jcc-game-focused');
            if (state === 'running' || state === 'dead') {
                state = 'idle';
                scoreEl.textContent = '00000';
            }
        });

        // Key events fire on the canvas only when it has focus
        canvas.addEventListener('keydown', e => {
            if (e.code === 'Escape') {
                canvas.blur();   // releases focus → triggers blur handler above
                return;
            }
            if (e.code === 'Space' || e.code === 'ArrowUp') {
                e.preventDefault();
                jump();
            }
        });

        let raf;
        const loop = () => { update(); draw(); raf = requestAnimationFrame(loop); };
        raf = requestAnimationFrame(loop);

        this._gameCleanup = () => {
            cancelAnimationFrame(raf);
        };
    }

    // ── Section helper ──────────────────────────────────────────────────────

    _section(root, title) {
        const sec = root.createDiv('jcc-section');
        sec.createEl('div', { text: title, cls: 'jcc-section-title' });
        return sec;
    }
}

// ── Plugin entry point ────────────────────────────────────────────────────────


// ── Report notes get a data attribute, so CSS can target them ────────────────
//
// WHY THIS IS SET IN CODE. The styling must apply to ANALYSIS REPORTS ONLY -
// day files and protocol notes keep Obsidian's default tables. The obvious
// selector, keying off the frontmatter `type: analysis-report`, does not exist:
// Obsidian does not expose arbitrary frontmatter keys as attributes on the
// preview container. A stylesheet written against `[data-type="analysis-report"]`
// would silently never match, and the styling would look "not applied" with
// nothing to debug.
//
// So the attribute is set here, from the metadata cache, on both the preview and
// the live-preview containers of the active leaf. Re-applied on layout and on
// file-open, and cleared when a note is not a report so a stale attribute cannot
// leak the styling onto the next note in the same leaf.

// Presentation types are included alongside analysis-report because a deck shown
// to a PI is read the same way a report is: dense tables, scanned for numbers,
// never edited mid-talk. The alternative — retyping a presentation as
// 'analysis-report' to pick up the styling — would drop it out of the
// "Lab Meetings" view in presentations/presentation-log.base, which filters on
// type == "lab-meeting", and swap its 🔬 for the fallback icon. Widening the set
// here keeps frontmatter meaning what it says.
const JCC_REPORT_TYPES = new Set([
    'analysis-report',
    'lab-meeting',
    'lab-meeting-prep',
    'conference',
    'poster',
    'journal-club',
]);

function jccTagReportViews(app) {
    const leaves = app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
        const view = leaf.view;
        if (!view || !view.file) continue;
        const cache = app.metadataCache.getFileCache(view.file);
        const fmType = cache && cache.frontmatter ? cache.frontmatter.type : null;
        const isReport = JCC_REPORT_TYPES.has(String(fmType));
        // containerEl covers both reading and live-preview modes.
        const el = view.containerEl;
        if (!el) continue;
        if (isReport) el.setAttribute('data-jcc-report', '');
        else el.removeAttribute('data-jcc-report');
    }
}

// ── jcc-matrix: a result matrix, rendered ────────────────────────────────────
//
// WHAT THIS REPLACES. A fixed-width ``` block holding a results grid. It aligns
// only in a monospace font, carries no visual encoding, and Obsidian styles it
// as CODE - which tells the reader it is source, when it is the summary of the
// whole analysis.
//
// A plain markdown table is better but still flat: every cell has equal weight,
// so a -54% and a -7% look alike and the reader must compare digits.
//
// NO HUE, DELIBERATELY. A red/green or red/blue down/up scale is the obvious
// design and it is not available here: this project reserves colour for reagent
// identity, and measuring candidate diverging pairs against the reserved
// palette found collisions for red (0.28 from the terminal-subset colour), blue
// (0.18 from sh2653), teal (0.016), brown (0.27), green (0.14) and orange (0.23
// from sh3418). Rather than hunt for a surviving hue, direction is carried by a
// GLYPH and magnitude by a NEUTRAL INK RAMP. That cannot collide with anything,
// and it survives greyscale printing - the same structural fix used for the
// figure annotation colours.
//
// SYNTAX
//   ```jcc-matrix
//   cols: Tpex | Tex-int | Tex-term
//   composition     | ~unchanged | +6.0 pp | -4.2 pp
//   TIGIT intensity | -20% | -24% | -25%
//   ```
// Optional `title:` line. Cells are free text; the leading signed number, if
// present, drives the glyph and the ramp. A cell with no number renders plain,
// so "~unchanged" stays honest rather than being coerced to zero.

function jccParseMatrix(src) {
    const out = { title: null, cols: [], rows: [] };
    for (const raw of src.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (/^title\s*:/i.test(line)) { out.title = line.replace(/^title\s*:/i, '').trim(); continue; }
        if (/^cols\s*:/i.test(line)) {
            out.cols = line.replace(/^cols\s*:/i, '').split('|').map((c) => c.trim());
            continue;
        }
        const parts = line.split('|').map((c) => c.trim());
        if (parts.length >= 2) out.rows.push({ label: parts[0], cells: parts.slice(1) });
    }
    return out;
}

function jccCellNumber(text) {
    // Leading signed number, percent or pp. Returns null when the cell is prose
    // ("~unchanged"), so a non-numeric cell is never coerced to zero.
    //
    // TWO NORMALISATIONS, both found by testing against the real report text:
    //  * U+2212 MINUS SIGN. The reports are written with typographic minus, so
    //    an ASCII-only pattern returned null for EVERY negative cell - the whole
    //    table would have rendered as unweighted prose and looked merely plain
    //    rather than broken.
    //  * Thousands separators. "1,234" matched as "1" and would have been
    //    ranked as the smallest value in its row instead of the largest.
    const t = String(text).replace(/\u2212/g, '-').replace(/(\d),(\d{3})/g, '$1$2');
    const m = t.match(/^\s*([+-]?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
}

function jccRenderMatrix(src, el) {
    const spec = jccParseMatrix(src);
    const wrap = el.createDiv({ cls: 'jcc-matrix' });
    if (spec.title) wrap.createDiv({ cls: 'jcc-matrix-title', text: spec.title });
    const table = wrap.createEl('table', { cls: 'jcc-matrix-table' });

    if (spec.cols.length) {
        const thead = table.createEl('thead');
        const tr = thead.createEl('tr');
        tr.createEl('th', { cls: 'jcc-matrix-corner' });
        for (const c of spec.cols) tr.createEl('th', { text: c });
    }

    const tbody = table.createEl('tbody');
    for (const row of spec.rows) {
        // MAGNITUDE IS SCALED WITHIN THE ROW, not across the table: the rows are
        // different quantities (percentage points against percent change), so a
        // shared ramp would compare things that are not comparable.
        const mags = row.cells.map(jccCellNumber)
                             .filter((v) => v !== null)
                             .map((v) => Math.abs(v));
        const peak = mags.length ? Math.max(...mags) : 0;
        const tr = tbody.createEl('tr');
        tr.createEl('th', { cls: 'jcc-matrix-rowlab', text: row.label });
        for (const cell of row.cells) {
            const td = tr.createEl('td');
            const v = jccCellNumber(cell);
            if (v === null) {
                td.addClass('jcc-matrix-plain');
                td.setText(cell);
                continue;
            }
            // Ink weight from 0.06 to 0.40: dark enough to rank, light enough
            // that the numeral on top stays readable at every step.
            const frac = peak > 0 ? Math.abs(v) / peak : 0;
            td.style.setProperty('--jcc-ink', String(0.06 + 0.34 * frac));
            td.addClass('jcc-matrix-cell');
            const glyph = v < 0 ? '▼' : (v > 0 ? '▲' : '–');
            td.createSpan({ cls: 'jcc-matrix-glyph', text: glyph });
            td.createSpan({ cls: 'jcc-matrix-val', text: cell });
        }
    }
    return wrap;
}

// ── jcc table zoom ───────────────────────────────────────────────────────────
//
// WHY THIS IS NOT THE MERMAID MODAL. A diagram is a single scalable object: the
// mermaid viewer transforms an <svg>, and scale/pan is the natural control. A
// table is TEXT laid out in a grid. Transform-scaling it blurs glyph rendering
// and freezes the column widths computed at the note's narrow text measure, so a
// 7-column table stays cramped, just bigger. Font size is the correct axis: the
// browser re-lays the grid at each step, so columns actually breathe.
//
// A table is also SELECTABLE, which the diagram is not - these reports exist to
// be read off and copied into a manuscript. So: no drag-pan (it would fight text
// selection), the modal keeps the text selectable, and a click that is really the
// end of a drag-select must NOT open the modal.

const JCC_TABLE_STEPS = [0.95, 1.1, 1.25, 1.45, 1.7, 2.0];

// ── Modal event binding ──────────────────────────────────────────────────────
//
// Modals bind listeners through these rather than through the Component helper,
// for two reasons this plugin has already paid for once each.
//
//  * A MODAL CAN BE HOSTED IN A POPOUT WINDOW. Module-scope `window` and
//    `document` still refer to the MAIN window, so a listener bound to them is
//    watching an object the modal does not live in. That is the failure the
//    presentation modal diagnosed at length: four independent keydown listeners
//    that could not all miss the same event, because the event was being
//    dispatched in a different document. jccModalDoc/jccModalWin resolve the
//    objects this modal is actually in.
//  * Registration through the Component helper is only as dependable as Modal
//    being a Component in the running build. addEventListener with explicit
//    teardown cannot be affected by that either way.
//
// Note what is NOT claimed here: mouse events through the Component helper are
// known to work (the presentation modal's stage clicks fired throughout). These
// helpers exist to remove a latent failure and to make teardown explicit, not
// because every modal listener was broken.
//
// Every jccBind is undone by one jccUnbind(this) in onClose.

function jccModalDoc(modal) {
    return (modal && modal.modalEl && modal.modalEl.ownerDocument) || document;
}

function jccModalWin(modal) {
    return jccModalDoc(modal).defaultView || window;
}

function jccBind(owner, el, type, fn, opts) {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    (owner._off || (owner._off = [])).push(() => {
        try { el.removeEventListener(type, fn, opts); } catch (e) { /* already detached */ }
    });
}

function jccUnbind(owner) {
    (owner._off || []).forEach(f => f());
    owner._off = [];
}

class JccTableZoomModal extends Modal {
    constructor(app, tableEl, isReport) {
        super(app);
        this.srcTable = tableEl;
        this.isReport = isReport;
        this.step = 2;                 // 1.25x — a visible jump without reflowing to absurd
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('jcc-table-modal');
        contentEl.empty();

        // The report table styling is scoped to [data-jcc-report], an attribute on
        // the note's view container. The modal is mounted OUTSIDE that container,
        // so without re-flagging it here the zoomed table would lose exactly the
        // styling the user asked to see enlarged - the same subtree problem the
        // mermaid clone had, but solvable with the attribute rather than by
        // freezing computed styles, because these rules are ours.
        if (this.isReport) modalEl.setAttribute('data-jcc-report', '');

        const stage = contentEl.createDiv({ cls: 'jcc-table-stage' });
        const holder = stage.createDiv({ cls: 'markdown-rendered jcc-table-holder' });
        // A jcc-matrix table's ink ramp is styled via `.jcc-matrix .jcc-matrix-table`,
        // so the clone must keep that ancestor or the shading vanishes in the modal
        // — the enlarged copy would silently lose the encoding it was opened to show.
        // Per-cell --jcc-ink is inline on the cells, so it survives cloning.
        if (this.srcTable.classList.contains('jcc-matrix-table')) {
            holder.addClass('jcc-matrix');
        }
        holder.appendChild(this.srcTable.cloneNode(true));
        this.stage = stage;
        this.holder = holder;

        const bar = contentEl.createDiv({ cls: 'jcc-mermaid-controls' });
        const mk = (label, title, fn) => {
            const b = bar.createEl('button', { text: label, cls: 'jcc-mermaid-btn' });
            b.setAttribute('aria-label', title);
            b.onclick = fn;
            return b;
        };
        mk('A−', 'Smaller', () => this.bump(-1));
        this.readout = bar.createSpan({ cls: 'jcc-mermaid-scale' });
        mk('A+', 'Larger', () => this.bump(1));
        mk('Copy', 'Copy as markdown', () => this.copyMarkdown());

        // KEYBOARD ON THE MODAL'S OWN DOCUMENT, ON CAPTURE.
        //
        // This was bound to containerEl, which only receives a keydown while
        // something inside it holds focus — and nothing in this modal ever takes
        // focus, so +/- silently did nothing. Binding to the document the modal
        // actually lives in fixes both that and the popout-window case.
        jccBind(this, jccModalDoc(this), 'keydown', (e) => {
            if (!this.modalEl || !this.modalEl.isConnected) return;
            // Never steal a keystroke that is being typed into something.
            if (e.target instanceof Element &&
                e.target.closest('input, textarea, [contenteditable="true"]')) return;
            if (e.key === '+' || e.key === '=') { this.bump(1); e.preventDefault(); }
            else if (e.key === '-') { this.bump(-1); e.preventDefault(); }
        }, true);
        // Wheel with a modifier only: a plain wheel must scroll a tall table.
        // passive:false because this one calls preventDefault.
        jccBind(this, stage, 'wheel', (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            this.bump(e.deltaY < 0 ? 1 : -1);
        }, { passive: false });

        this.apply();
    }

    bump(d) {
        this.step = Math.max(0, Math.min(JCC_TABLE_STEPS.length - 1, this.step + d));
        this.apply();
    }

    apply() {
        const f = JCC_TABLE_STEPS[this.step];
        this.holder.style.fontSize = `calc(var(--font-text-size, 16px) * ${f})`;
        if (this.readout) this.readout.setText(`${Math.round(f * 100)}%`);
    }

    copyMarkdown() {
        // Round-trips to markdown rather than copying rendered HTML, so the
        // clipboard content pastes back into a note as a table.
        const t = this.holder.querySelector('table');
        if (!t) return;
        const rowText = (tr) => Array.from(tr.children)
            .map((c) => c.textContent.trim().replace(/\|/g, '\\|'));
        const head = t.querySelector('thead tr');
        const lines = [];
        if (head) {
            const h = rowText(head);
            // Carry the ALIGNMENT through. These reports right-align every numeric
            // column deliberately; a copy that emits bare `---` for each column
            // pastes back left-aligned and the numbers stop lining up, which is
            // the one thing the styling exists to preserve. Read it off the
            // rendered cells' computed text-align rather than guessing.
            const align = Array.from(head.children).map((c) => {
                const a = window.getComputedStyle(c).textAlign;
                if (a === 'right' || a === 'end') return '--:';
                if (a === 'center') return ':-:';
                return ':--';
            });
            lines.push('| ' + h.join(' | ') + ' |');
            lines.push('|' + align.join('|') + '|');
        }
        for (const tr of t.querySelectorAll('tbody tr')) {
            lines.push('| ' + rowText(tr).join(' | ') + ' |');
        }
        navigator.clipboard.writeText(lines.join('\n'));
        new Notice('Table copied as markdown');
    }

    onClose() { jccUnbind(this); this.contentEl.empty(); }
}

// ── Mermaid fullscreen viewer ────────────────────────────────────────────────
//
// Obsidian renders mermaid natively but gives no way to enlarge a diagram: a
// gate tree or a pipeline DAG is drawn to the note's text width and is unreadable
// past a few nodes. This adds a click-to-zoom modal.
//
// WHY THE SVG IS CLONED rather than moved: the rendered <svg> belongs to the
// reading view, and moving it leaves a hole in the note that never repaints when
// the modal closes. cloneNode(true) is cheap for a diagram and leaves the source
// untouched.

// Paint properties that decide how a mermaid diagram LOOKS. Copied from the
// live element to the clone so the modal cannot recolour the diagram.
const JCC_PAINT_PROPS = [
    'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
    'stroke-opacity', 'stroke-linecap', 'color', 'background-color', 'opacity',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
    'marker-end', 'marker-start',
];

function copyComputedPaint(srcRoot, dstRoot) {
    // WHY THIS IS NECESSARY. Obsidian paints mermaid through CSS rules scoped to
    // the note container (e.g. `.markdown-rendered .mermaid ...`) and through
    // theme custom properties resolved on that subtree. Cloning the <svg> into a
    // Modal moves it OUT of that subtree, so those selectors stop matching and
    // the browser falls back to SVG defaults - black fills, hairline strokes, a
    // different type face. The diagram changes colour purely by being enlarged.
    //
    // Rather than trying to replicate Obsidian's selector chain (which is theme-
    // dependent and would silently rot on any theme or app update), read what
    // the element ACTUALLY renders as right now and freeze it inline on the
    // clone. Inline style wins over any stylesheet, so the modal is guaranteed
    // to match the note whatever the theme does.
    //
    // Read from the SOURCE while it is still laid out in the note; both trees
    // are structurally identical, so document order pairs them element-by-element.
    const srcAll = [srcRoot, ...srcRoot.querySelectorAll('*')];
    const dstAll = [dstRoot, ...dstRoot.querySelectorAll('*')];
    if (srcAll.length !== dstAll.length) return;   // defensive: never half-apply
    for (let i = 0; i < srcAll.length; i++) {
        const cs = window.getComputedStyle(srcAll[i]);
        if (!cs) continue;
        const dst = dstAll[i];
        if (!dst.style) continue;                  // e.g. a bare text node
        for (const prop of JCC_PAINT_PROPS) {
            const v = cs.getPropertyValue(prop);
            if (v && v !== 'none' && v !== 'normal') {
                dst.style.setProperty(prop, v);
            }
        }
    }
}

class MermaidZoomModal extends Modal {
    constructor(app, svgEl) {
        super(app);
        this.srcSvg = svgEl;
        this.scale = 1;
        this.tx = 0;
        this.ty = 0;
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('jcc-mermaid-modal');
        contentEl.empty();

        const stage = contentEl.createDiv({ cls: 'jcc-mermaid-stage' });
        // `mermaid` class so any stylesheet rule keyed on it still matches; the
        // inline copy below is the actual guarantee.
        stage.addClass('mermaid');
        const svg = this.srcSvg.cloneNode(true);
        // Freeze the note's rendered appearance onto the clone BEFORE it is
        // appended, so the diagram never repaints on open.
        copyComputedPaint(this.srcSvg, svg);
        // The source svg may carry an inline max-width that pins it to the note's
        // text column; strip it so the clone can fill the modal.
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.style.maxWidth = 'none';
        svg.style.width = '100%';
        svg.style.height = '100%';
        stage.appendChild(svg);
        this.stage = stage;
        this.svg = svg;

        const bar = contentEl.createDiv({ cls: 'jcc-mermaid-controls' });
        const mk = (label, title, fn) => {
            const b = bar.createEl('button', { text: label, cls: 'jcc-mermaid-btn' });
            b.setAttribute('aria-label', title);
            b.onclick = fn;
            return b;
        };
        mk('−', 'Zoom out', () => this.zoom(1 / 1.25));
        this.readout = bar.createSpan({ cls: 'jcc-mermaid-scale', text: '100%' });
        mk('+', 'Zoom in', () => this.zoom(1.25));
        mk('Reset', 'Reset to fit', () => { this.scale = 1; this.tx = 0; this.ty = 0; this.apply(); });

        // Wheel to zoom, drag to pan. Bound to the document this modal actually
        // lives in — see the jccBind comment — and torn down in onClose.
        const doc = jccModalDoc(this);
        jccBind(this, stage, 'wheel', (e) => {
            e.preventDefault();
            this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });
        let dragging = false, ox = 0, oy = 0;
        jccBind(this, stage, 'mousedown', (e) => {
            dragging = true; ox = e.clientX - this.tx; oy = e.clientY - this.ty;
            stage.addClass('jcc-grabbing');
        });
        jccBind(this, doc, 'mousemove', (e) => {
            if (!dragging) return;
            this.tx = e.clientX - ox; this.ty = e.clientY - oy; this.apply();
        });
        jccBind(this, doc, 'mouseup', () => {
            dragging = false; stage.removeClass('jcc-grabbing');
        });
        jccBind(this, stage, 'dblclick', () => {
            this.scale = 1; this.tx = 0; this.ty = 0; this.apply();
        });
        this.scope.register([], 'Escape', () => this.close());
    }

    zoom(f) {
        this.scale = Math.min(8, Math.max(0.2, this.scale * f));
        this.apply();
    }

    apply() {
        this.svg.style.transform =
            `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
        this.readout.setText(`${Math.round(this.scale * 100)}%`);
    }

    onClose() { jccUnbind(this); this.contentEl.empty(); }
}

// ── Presentation mode ────────────────────────────────────────────────────────
//
// WHY THIS EXISTS, AND WHY NOT THE CORE SLIDES PLUGIN.
// Obsidian's core Slides plugin renders each slide at a FIXED logical size and
// clips whatever overflows — silently, with no scrollbar and no warning. For a
// data deck that is the wrong failure: a table drops off the bottom mid-talk and
// nobody notices. The only lever it offers is a per-embed pixel width baked into
// the markdown (`![[fig.png|883]]`), which means every figure rebuild silently
// invalidates every width in the note, and nothing checks it.
//
// This mode inverts that. It MEASURES each slide's content after render and
// scales it to fit the viewport, so:
//   - the markdown stays clean: `![[fig.png]]`, no pixel widths anywhere
//   - a rebuilt figure of any aspect ratio just works, because nothing about its
//     size is stored in the note
//   - a slide can never clip: if content is too tall it is scaled down, and the
//     scale factor is reported so an unreadable slide is visible as a number
//     rather than as missing content.

const JCC_SLIDE_SEP = /^\s*---\s*$/;

function jccSplitSlides(md) {
    // Strip YAML frontmatter, then split on a line that is exactly `---`.
    // Frontmatter is delimited by the SAME token, so it must go first or the
    // first two slides are the frontmatter's own fences.
    let body = md;
    if (body.startsWith('---')) {
        const end = body.indexOf('\n---', 3);
        if (end !== -1) body = body.slice(body.indexOf('\n', end + 1) + 1);
    }
    return body.split('\n').reduce((acc, line) => {
        if (JCC_SLIDE_SEP.test(line)) acc.push([]);
        else acc[acc.length - 1].push(line);
        return acc;
    }, [[]]).map(a => a.join('\n').trim()).filter(s => {
        if (!s.length) return false;
        // A trailing block that is ONLY a callout is speaker notes, not a slide:
        // the author keeps it in the note (visible while editing, collapsed in
        // reading view) without it becoming a blank slide at the end of the talk.
        const lines = s.split('\n').filter(l => l.trim().length);
        return !lines.every(l => l.trim().startsWith('>'));
    });
}

// ── Presentation debug log ───────────────────────────────────────────────────
// I cannot observe the running app, and three rounds of diagnosing keyboard
// failure from the outside produced three wrong theories. This writes what the
// modal actually does to a file in the vault, which IS observable. Append-only,
// tiny, and harmless if left enabled.
let JCC_LOG_ERR = null;
let JCC_LOG_PATH = null;
function jccLog(vaultPath, msg) {
    // Off unless explicitly enabled — see the note on the probe's logger.
    if (typeof window === 'undefined' || !window.JCC_DEBUG) return;
    // A logger that fails silently is worse than no logger: the first version
    // swallowed a TypeError and produced an empty log, which I then read as
    // "the modal never opened". Record WHY it failed so the next reader can see
    // the difference between "nothing happened" and "logging is broken".
    try {
        if (!vaultPath) { JCC_LOG_ERR = 'no vault path'; return; }
        const fsx = require('fs');
        JCC_LOG_PATH = require('path').join(vaultPath, 'jcc_present_debug.log');
        fsx.appendFileSync(JCC_LOG_PATH, `${new Date().toISOString()}  ${msg}\n`);
        JCC_LOG_ERR = null;
    } catch (e) {
        JCC_LOG_ERR = String(e && e.message || e);
    }
}

class JccPresentModal extends Modal {
    constructor(app, slides, filePath, startAt) {
        super(app);
        this.slides = slides;
        this.filePath = filePath || '';
        this.idx = Math.max(0, Math.min(startAt || 0, slides.length - 1));
        // Basedir of the vault on disk, for the debug log.
        // The vault's on-disk path. This plugin already reads `adapter.basePath`
        // (a PROPERTY) elsewhere; my first attempt called `getBasePath()` as a
        // method, which threw, was swallowed by the catch, and left vaultDir null
        // — so the debug log silently never wrote and its ABSENCE proved nothing.
        // Try both shapes, and fall back to the OS temp dir so a log always lands.
        this.vaultDir = null;
        try {
            const ad = app.vault.adapter;
            this.vaultDir = (typeof ad.getBasePath === 'function' ? ad.getBasePath() : null)
                         || ad.basePath || null;
        } catch (e) { /* fall through */ }
        if (!this.vaultDir) {
            try { this.vaultDir = require('os').tmpdir(); } catch (e) { this.vaultDir = null; }
        }
    }

    onOpen() {
        const { modalEl, contentEl } = this;
        modalEl.addClass('jcc-present-modal');
        contentEl.empty();

        this.stage = contentEl.createDiv({ cls: 'jcc-present-stage' });
        this.inner = this.stage.createDiv({ cls: 'jcc-present-inner' });
        // Progress bar: a talk has a shape, and a PI reads "how much is left"
        // from it without being told. One element, no per-slide cost.
        this.progress = contentEl.createDiv({ cls: 'jcc-present-progress' });

        const bar = contentEl.createDiv({ cls: 'jcc-present-bar' });
        this.counter = bar.createSpan({ cls: 'jcc-present-counter' });
        this.fitInfo = bar.createSpan({ cls: 'jcc-present-fit' });
        this.keyInfo = bar.createSpan({ cls: 'jcc-present-key' });
        const mk = (label, fn, title) => {
            const b = bar.createEl('button', { text: label, cls: 'jcc-present-btn' });
            if (title) b.setAttr('aria-label', title);
            b.onclick = (e) => { e.stopPropagation(); fn(); };
            return b;
        };
        mk('‹', () => this.go(-1), 'Previous slide');
        mk('›', () => this.go(1), 'Next slide');
        mk('✕', () => this.close(), 'Exit presentation');

        // Click the stage to advance; click the left eighth to go back. A talk is
        // driven forward far more often than back, so the big target is forward.
        this.registerDomEvent(this.stage, 'click', (e) => {
            if (e.target.closest('a, button, input')) return;
            const r = this.stage.getBoundingClientRect();
            this.go((e.clientX - r.left) < r.width / 8 ? -1 : 1);
        });
        // KEYBOARD — MODAL-SCOPE PATHS. **These do not fire in this Obsidian
        // build.** Navigation is driven by the plugin-level listener in onload();
        // see the note there. They are kept deliberately: they cost nothing (the
        // `_stamp` guard prevents a double-advance if both paths ever fire), and
        // if a future build restores normal event delivery to modals they resume
        // working with no change. Deleting them would mean re-deriving the whole
        // diagnosis if the plugin-level path ever regresses.
        //
        // ORIGINAL NOTE — FOUR INDEPENDENT PATHS, ALL INSTRUMENTED.
        //
        // Three attempts have failed and each diagnosis was a guess, because
        // "nothing happens" looks identical whether the listener never fires,
        // the key name is wrong, or `go()` runs and the re-render fails. This
        // registers every mechanism Obsidian offers AND counts what each one
        // sees, so the footer identifies the broken layer instead of me
        // theorising about it from outside the running app.
        //
        //   winCap  — window, capture phase: first in dispatch order, but an
        //             earlier capture listener calling stopImmediatePropagation
        //             on the same node would still beat it.
        //   docCap  — document, capture: fires after window capture.
        //   scope   — Obsidian's own keymap Scope, active while the modal is on
        //             top. Fails SILENTLY on an unrecognised key name.
        //   stage   — the focused element itself, bubble phase: last resort.
        //
        // `_seen` counts arrivals per path; `_stamp` ensures only the first path
        // to see a given press acts on it, so four registrations never advance
        // four slides.
        this._seen = { winCap: 0, docCap: 0, scope: 0, stage: 0, acted: 0 };
        jccLog(this.vaultDir, `OPEN slides=${this.slides.length} idx=${this.idx} ` +
            `modalEl=${!!this.modalEl} scope=${!!this.scope} stage=${!!this.stage}`);
        this._stamp = -1;

        const KEYS_FWD = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar', 'Right', 'Down'];
        const KEYS_BACK = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'Left', 'Up'];

        const handle = (e, path) => {
            this._seen[path] = (this._seen[path] || 0) + 1;
            this.lastKey = e.key;
            jccLog(this.vaultDir, `KEY path=${path} key=${JSON.stringify(e.key)} ` +
                `code=${e.code} stamp=${Math.round(e.timeStamp)} ` +
                `connected=${!!(this.modalEl && this.modalEl.isConnected)} ` +
                `target=${e.target && e.target.className ? String(e.target.className).slice(0,40) : e.target && e.target.tagName}`);
            if (!this.modalEl || !this.modalEl.isConnected) return false;
            if (e.timeStamp === this._stamp) { this.showKeyInfo(); return false; }
            let fn = null;
            if (KEYS_FWD.includes(e.key)) fn = () => this.go(1);
            else if (KEYS_BACK.includes(e.key)) fn = () => this.go(-1);
            else if (e.key === 'Home') fn = () => this.render(0);
            else if (e.key === 'End') fn = () => this.render(this.slides.length - 1);
            else if (e.key === 'Escape') fn = () => this.close();
            if (!fn) { this.showKeyInfo(); return false; }
            this._stamp = e.timeStamp;
            this._seen.acted++;
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            // Run the action OUTSIDE the event handler. render() is async and an
            // exception inside it would otherwise reject silently and look
            // exactly like a dead key — the ambiguity that cost three rounds.
            window.setTimeout(() => {
                try { fn(); }
                catch (err) {
                    this.keyErr = String(err && err.message || err);
                    this.showKeyInfo();
                }
            }, 0);
            this.showKeyInfo();
            return false;
        };
        this._handleKey = handle;

        // BIND TO THE MODAL'S OWN DOCUMENT, NOT MODULE-SCOPE `window`.
        //
        // The debug log settled this: CMD ran, clicks produced GO lines, and NOT
        // ONE of four independent keydown listeners ever fired. Four listeners
        // cannot all miss an event that reaches the document they are attached
        // to — so the keydowns were going to a DIFFERENT document. Obsidian can
        // host a modal in a popout window; plugin module scope still refers to
        // the MAIN window, so `window.addEventListener` was listening on the
        // wrong object entirely. `ownerDocument.defaultView` is by definition the
        // window this modal lives in.
        this._doc = (this.modalEl && this.modalEl.ownerDocument) || document;
        this._win = this._doc.defaultView || window;
        this._onWinCap = (e) => handle(e, 'winCap');
        this._onDocCap = (e) => handle(e, 'docCap');
        this._win.addEventListener('keydown', this._onWinCap, true);
        this._doc.addEventListener('keydown', this._onDocCap, true);
        // Keep the module-scope pair too: if the modal IS in the main window
        // these are the same objects and the stamp guard makes the duplicate
        // harmless; if it is not, one pair or the other will be the live one.
        if (this._win !== window) {
            this._onWinCap2 = (e) => handle(e, 'winCap');
            window.addEventListener('keydown', this._onWinCap2, true);
        }
        if (this._doc !== document) {
            this._onDocCap2 = (e) => handle(e, 'docCap');
            document.addEventListener('keydown', this._onDocCap2, true);
        }
        jccLog(this.vaultDir,
            `BIND sameWindow=${this._win === window} sameDoc=${this._doc === document} ` +
            `modalInBody=${!!(this.modalEl && this._doc.body && this._doc.body.contains(this.modalEl))} ` +
            `activeEl=${this._doc.activeElement && (this._doc.activeElement.className || this._doc.activeElement.tagName)}`);
        this.registerDomEvent(this.stage, 'keydown', (e) => handle(e, 'stage'));
        ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageDown', 'PageUp',
         'Home', 'End', 'Space', 'Escape'].forEach((k) => {
            try { this.scope.register([], k, (e) => handle(e, 'scope')); }
            catch (err) { /* unrecognised key name: that is what `scope` counting reveals */ }
        });

        // Focus the stage so the modal owns the keyboard from the moment it
        // opens rather than after the first click.
        this.stage.setAttr('tabindex', '-1');
        window.setTimeout(() => this.stage.focus(), 0);

        // Re-fit on resize: the scale depends on the viewport, so a window change
        // or a display swap mid-talk must recompute it rather than keep a stale one.
        jccBind(this, this._win || window, 'resize', () => this.fit());

        this.render(this.idx);
    }

    showKeyInfo() {
        if (!this.keyInfo) return;
        const s = this._seen || {};
        const parts = [`key: ${this.lastKey || '—'}`,
                       JCC_LOG_ERR ? `log:${JCC_LOG_ERR}` : (JCC_LOG_PATH ? 'log:ok' : 'log:—'),
                       `w${s.winCap || 0} d${s.docCap || 0} s${s.scope || 0} e${s.stage || 0} ok${s.acted || 0}`];
        if (this.keyErr) parts.push(`ERR ${this.keyErr}`);
        this.keyInfo.setText(parts.join('  '));
        this.keyInfo.toggleClass('jcc-present-fit-warn', !!this.keyErr);
    }

    go(delta) {
        const n = this.idx + delta;
        jccLog(this.vaultDir, `GO delta=${delta} from=${this.idx} to=${n} ` +
            `bounds=${n >= 0 && n < this.slides.length}`);
        if (n < 0 || n >= this.slides.length) return;
        this.render(n).catch(err =>
            jccLog(this.vaultDir, `RENDER-ERROR ${err && err.message || err}`));
    }

    async render(i) {
        this.idx = i;
        this.inner.empty();
        this.inner.style.transform = 'scale(1)';
        await MarkdownRenderer.render(
            this.app, this.preResolve(this.slides[i]), this.inner,
            this.filePath, this);
        this.resolveEmbeds();
        this.counter.setText(`${i + 1} / ${this.slides.length}`);
        this.progress.style.width =
            `${((i + 1) / this.slides.length) * 100}%`;
        // Images decode asynchronously, so their height is 0 at render time and a
        // fit computed now would always read "fits". Wait for every image, then fit.
        const imgs = Array.from(this.inner.querySelectorAll('img'));
        // Bounded wait: an image that fires NEITHER onload nor onerror would
        // otherwise leave the slide unfitted at scale 1 — i.e. overflowing, the
        // exact failure this mode exists to prevent. Fit anyway after 1.5s.
        await Promise.all(imgs.map(im => im.complete
            ? Promise.resolve()
            : new Promise(res => {
                const done = () => res();
                im.onload = done;
                im.onerror = done;
                setTimeout(done, 1500);
            })));
        // SELF-DIAGNOSTIC. The original failure looked exactly like a slide with
        // no figure on it — a caption and nothing else — with no way to tell a
        // lookup failure from a render failure. Count what actually loaded.
        const broken = imgs.filter(im => !im.naturalWidth).length;
        this.imgInfo = imgs.length
            ? (broken ? `${broken}/${imgs.length} images failed to load` : '')
            : (/!\[|internal-embed/.test(this.slides[i]) ? 'embed did not resolve' : '');
        this.layoutFigures();
        this.chooseFigureLayout();
        this.fit();
        // Decoding can settle a frame later and change the measured height, so
        // re-fit once on the next frame. Cheap, and removes a class of
        // off-by-a-few-percent misfits.
        requestAnimationFrame(() => this.fit());
    }

    preResolve(md) {
        // Rewrite image wikilinks to standard markdown images with a resolved
        // vault resource path, BEFORE rendering.
        //
        // WHY NOT FIX IT IN THE DOM. `MarkdownRenderer.render` emits an
        // `.internal-embed` that already CONTAINS an <img> with an unresolved
        // src, and leaves filling it to Obsidian's embed registry — which never
        // fires in a detached modal container. So the element renders (you see
        // the filename) and the image never loads. Patching that after the fact
        // means guessing at markup that differs between Obsidian versions; a
        // standard markdown image needs no registry at all and cannot regress.
        const IMG = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
        return md.replace(/!\[\[([^\]]+)\]\]/g, (whole, inner) => {
            const linkpath = inner.split('|')[0].split('#')[0].trim();
            if (!IMG.test(linkpath)) return whole;       // note embed, leave alone
            // getFirstLinkpathDest is the same lookup the editor uses, so a bare
            // filename resolves anywhere in the vault exactly as it does in the note.
            const file = this.app.metadataCache.getFirstLinkpathDest(
                linkpath, this.filePath);
            if (!file) return `\`[missing: ${linkpath}]\``;
            const url = this.app.vault.getResourcePath(file);
            return `![${linkpath}](${url})`;
        });
    }

    layoutFigures() {
        // A slide with two or more figures: put them in one flex container and
        // choose ROW or COLUMN by measuring which yields a bigger final image.
        //
        // WHY MEASURE RATHER THAN RULE. "Side by side" is not always right. Two
        // wide strips (aspect ~2.6) side by side each get half the width, so each
        // renders SMALLER than if they were stacked; two tall panels stacked
        // overflow the height and force a big scale-down. Which wins depends on
        // the figures' aspect ratios and the stage's, so the honest answer is to
        // try both and keep the larger — two layout passes, imperceptible cost.
        const groups = [];
        this.inner.querySelectorAll('p').forEach((p) => {
            const imgs = Array.from(p.querySelectorAll('img'));
            if (imgs.length > 1) groups.push({ p, imgs });
        });
        // Also treat consecutive image-only paragraphs as one group: authors write
        // each embed on its own line as often as on one line, and the reader should
        // not get a different layout for a difference they cannot see in the note.
        const solo = Array.from(this.inner.querySelectorAll('p')).filter(p => {
            const imgs = p.querySelectorAll('img');
            return imgs.length === 1 && !p.textContent.trim();
        });
        for (let i = 0; i < solo.length; ) {
            let j = i;
            while (j + 1 < solo.length && solo[j].nextElementSibling === solo[j + 1]) j++;
            if (j > i) {
                const wrap = document.createElement('div');
                solo[i].parentNode.insertBefore(wrap, solo[i]);
                const imgs = [];
                for (let k = i; k <= j; k++) {
                    imgs.push(...solo[k].querySelectorAll('img'));
                    wrap.appendChild(solo[k]);
                }
                groups.push({ p: wrap, imgs });
            }
            i = j + 1;
        }
        if (!groups.length) { this.figGroups = []; return; }
        groups.forEach(g => g.p.addClass('jcc-figrow'));
        this.figGroups = groups;
    }

    chooseFigureLayout() {
        // Try each arrangement, measure the scale the slide would need, keep the
        // one that renders LARGER. Runs after images have loaded, so natural
        // sizes are real rather than zero.
        if (!this.figGroups || !this.figGroups.length) return;
        const avail = this.stage.getBoundingClientRect();
        const scoreFor = (mode) => {
            this.figGroups.forEach(g => {
                g.p.style.flexDirection = mode;
            });
            this.inner.style.transform = 'scale(1)';
            const need = this.inner.getBoundingClientRect();
            if (!need.width || !need.height) return 0;
            return Math.min(1, (avail.height * 0.96) / need.height,
                               (avail.width * 0.96) / need.width);
        };
        const kRow = scoreFor('row');
        const kCol = scoreFor('column');
        // Tie-break toward ROW: side-by-side invites the eye to compare, which is
        // usually why two figures share a slide at all.
        const best = kRow >= kCol * 0.98 ? 'row' : 'column';
        this.figGroups.forEach(g => { g.p.style.flexDirection = best; });
        this.figLayout = `${best} ${Math.round(Math.max(kRow, kCol) * 100)}%`;
    }

    resolveEmbeds() {
        // MarkdownRenderer.render emits `![[fig.png]]` as an .internal-embed
        // PLACEHOLDER and leaves filling it to Obsidian's embed registry, which
        // only fires for embeds inside a real markdown view — not in a detached
        // modal. The span renders (so you see the filename) and no <img> ever
        // appears. Resolve them here instead.
        const IMG = /\.(png|jpg|jpeg|gif|svg|webp|avif)$/i;
        this.inner.querySelectorAll('.internal-embed').forEach((el) => {
            // An <img> being PRESENT does not mean it is resolved: Obsidian
            // inserts one with an empty/relative src and fills it later via the
            // embed registry, which never runs here. Treat it as resolved only
            // if the src actually points at a loadable resource.
            const existing = el.querySelector('img');
            if (existing && /^(app|https?|data|file):/.test(existing.getAttribute('src') || '')) return;
            const src = el.getAttribute('src') || '';
            const linkpath = src.split('|')[0].split('#')[0].trim();
            if (!linkpath || !IMG.test(linkpath)) return;
            // getFirstLinkpathDest is what makes a BARE filename resolve anywhere
            // in the vault — the same lookup the editor uses, so a link that works
            // in the note works here.
            const file = this.app.metadataCache.getFirstLinkpathDest(
                linkpath, this.filePath);
            if (!file) {
                el.setText(`[missing: ${linkpath}]`);
                el.addClass('jcc-present-missing');
                return;
            }
            el.empty();
            el.addClass('jcc-present-resolved');
            const img = el.createEl('img');
            img.src = this.app.vault.getResourcePath(file);
            img.alt = linkpath;
        });
    }

    fit() {
        // Measure the rendered content at scale 1, then shrink to fit BOTH axes.
        // Never scale UP: a small figure blown up is blurry, and the author chose
        // its size. Only ever scale down, and only as far as needed.
        this.inner.style.transform = 'scale(1)';
        const avail = this.stage.getBoundingClientRect();
        const need = this.inner.getBoundingClientRect();
        if (!need.height || !need.width) return;
        const pad = 0.96;
        const k = Math.min(1, (avail.height * pad) / need.height,
                              (avail.width * pad) / need.width);
        this.inner.style.transform = `scale(${k})`;
        // Report the scale so an unreadable slide is a visible number rather than
        // silently-missing content — the exact failure this mode replaces.
        const fitTxt = k < 0.995 ? `fit ${Math.round(k * 100)}%` : '';
        this.fitInfo.setText([fitTxt, this.imgInfo].filter(Boolean).join('  ·  '));
        this.fitInfo.toggleClass('jcc-present-fit-warn', k < 0.7 || !!this.imgInfo);
    }

    onClose() {
        // RELEASE THE CAPTURE LISTENERS BOUND IN onOpen.
        //
        // Up to four keydown listeners are attached by hand above — two objects,
        // doubled again when the modal is in a popout. Nothing removed them, so
        // every presentation left another set attached for the rest of the
        // session, each still holding this deck and still running handle()
        // against a modal the user had closed. The binding strategy up there is
        // deliberate and is unchanged; only its release is new.
        const drop = (target, fn) => {
            if (!target || !fn) return;
            try { target.removeEventListener('keydown', fn, true); }
            catch (e) { /* already detached */ }
        };
        drop(this._win, this._onWinCap);
        drop(this._doc, this._onDocCap);
        drop(window, this._onWinCap2);
        drop(document, this._onDocCap2);
        this._onWinCap = this._onDocCap = this._onWinCap2 = this._onDocCap2 = null;
        jccUnbind(this);
        this.contentEl.empty();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIGURE ANNOTATIONS
//
// Click a figure in a note -> it opens full-screen -> click anywhere ON the
// image to pin a note to that exact spot ("this axis label is wrong", "this
// point is the 2653 outlier, drop it").
//
// Coordinates are stored NORMALISED (0-1) against the figure's vault path, not
// as pixels against a rendered element. Three things depend on that:
//   * the same annotation is correct at any zoom level and any embed width;
//   * a figure embedded in two notes carries one shared set of pins;
//   * regenerating the figure (same filename, new data) KEEPS its annotations,
//     which is the whole point - the annotation is the instruction for the next
//     regeneration, so it has to outlive the file it describes.
//
// The canonical store is JSON (precise, machine-read by /fix-figures). Each
// note also gets a mirrored markdown block so the annotations are visible in
// Obsidian and readable by anything that just reads the note.

const JCC_ANN_DIR   = 'data/figures/_annotations';
const JCC_ANN_FILE  = JCC_ANN_DIR + '/annotations.json';
const JCC_ANN_START = '<!-- figure-annotations:start -->';
const JCC_ANN_END   = '<!-- figure-annotations:end -->';
const JCC_IMG_EXT   = /^(png|jpg|jpeg|gif|webp|bmp|svg|avif)$/i;

function jccEscapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A percentage pair is precise but hard to picture. The region word is what
// makes an annotation usable by someone (or something) looking at the image
// alongside the text.
function jccRegion(x, y) {
    const col = x < 1 / 3 ? 'left' : x < 2 / 3 ? 'center' : 'right';
    const row = y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom';
    if (row === 'middle' && col === 'center') return 'center';
    if (row === 'middle') return `${col} edge`;
    return `${row}-${col}`;
}

function jccWhere(a) {
    return `${Math.round(a.x * 100)}%, ${Math.round(a.y * 100)}% · ${jccRegion(a.x, a.y)}`;
}

// Local time with offset. A lab notebook records when the person at the bench
// wrote it; UTC would silently shift late-evening entries onto the next day.
function jccNowIso() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sg = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
           `${sg}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

function jccAnnId() {
    return 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// Which note is this element sitting in? Needed so an annotation records the
// note it was made from, which is how /fix-figures scopes "the annotations in
// this note".
function jccNotePathForEl(app, el) {
    const leafEl = el.closest('.workspace-leaf');
    let found = '';
    if (leafEl) {
        app.workspace.iterateAllLeaves(leaf => {
            if (found) return;
            if (leaf.containerEl === leafEl && leaf.view && leaf.view.file) {
                found = leaf.view.file.path;
            }
        });
    }
    if (found) return found;
    const af = app.workspace.getActiveFile();
    return af ? af.path : '';
}

// Map a rendered <img> back to its TFile.
//
// TWO PATHS, because Obsidian renders the two embed syntaxes differently:
//   ![[fig.png]]  -> wrapped in .internal-embed whose src attribute is the
//                    LINK TEXT, which the metadata cache can resolve properly
//                    (handles same-name files in different folders).
//   ![](fig.png)  -> a bare <img> whose src is an app://<hash>/<abs path> URL,
//                    so the vault base path has to be stripped back off.
function jccResolveImageFile(app, img) {
    const embed = img.closest('.internal-embed, .image-embed');
    const notePath = jccNotePathForEl(app, img);
    const link = embed && embed.getAttribute('src');
    if (link) {
        const clean = link.split('#')[0].split('|')[0].trim();
        const f = app.metadataCache.getFirstLinkpathDest(clean, notePath || '');
        if (f) return f;
    }
    let raw = img.getAttribute('src') || '';
    if (!raw) return null;
    if (/^https?:/i.test(raw)) return null;   // remote image: no vault file to pin to
    if (/^data:/i.test(raw)) return null;
    try {
        raw = raw.split('?')[0];
        let p = raw;
        if (/^app:\/\//i.test(p))       p = p.replace(/^app:\/\/[^/]+/i, '');
        else if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\//i, '');
        p = decodeURIComponent(p);
        const base = (app.vault.adapter && app.vault.adapter.basePath) || '';
        let rel = base && p.startsWith(base) ? p.slice(base.length) : p;
        rel = rel.replace(/^\/+/, '');
        const f = app.vault.getAbstractFileByPath(rel);
        if (f) return f;
    } catch (e) { /* unresolvable src is not an error worth surfacing */ }
    return null;
}

// ── Store ────────────────────────────────────────────────────────────────────

class JccAnnotationStore {
    constructor(app) {
        this.app = app;
        this.data = { version: 1, annotations: [] };
        this.loaded = false;
        // Writes are serialised. Placing three pins quickly fires three saves,
        // and concurrent adapter.write calls on one file can interleave into a
        // truncated document.
        this._chain = Promise.resolve();
    }

    async load(force = false) {
        if (this.loaded && !force) return this.data;
        const ad = this.app.vault.adapter;
        try {
            if (await ad.exists(JCC_ANN_FILE)) {
                const parsed = JSON.parse(await ad.read(JCC_ANN_FILE));
                if (parsed && Array.isArray(parsed.annotations)) this.data = parsed;
            }
        } catch (e) {
            // Never start writing over a file we failed to parse - the user's
            // annotations may still be in there and recoverable by hand.
            console.error('[jcc] annotations.json unreadable', e);
            try {
                await ad.write(JCC_ANN_FILE + '.corrupt', await ad.read(JCC_ANN_FILE));
            } catch (_) { /* best effort */ }
            new Notice('Figure annotations file was unreadable — started a fresh one, old copy kept as annotations.json.corrupt');
        }
        this.loaded = true;
        // Keep the staleness stamp in step with what we just read, so
        // reloadIfChanged() does not immediately re-read our own load.
        try {
            const st = await this.app.vault.adapter.stat(JCC_ANN_FILE);
            if (st) this._mtime = st.mtime;
        } catch (e) { /* stamp is an optimisation, not correctness */ }
        return this.data;
    }

    async reloadIfChanged() {
        // Cheap staleness check: stat the file and reload only on a new mtime.
        // The badge/pin overlay calls this before every draw, so it must not
        // read the whole file each time - but it MUST notice a write made by
        // the Python CLI or another window, which is what the plain `loaded`
        // flag could never do.
        const ad = this.app.vault.adapter;
        try {
            const st = await ad.stat(JCC_ANN_FILE);
            if (!st) return this.data;
            if (this._mtime === st.mtime) return this.data;
            this._mtime = st.mtime;
            return await this.load(true);
        } catch (e) {
            return this.data;
        }
    }

    save() {
        const ad = this.app.vault.adapter;
        this._chain = this._chain.then(async () => {
            if (!(await ad.exists(JCC_ANN_DIR))) await ad.mkdir(JCC_ANN_DIR);
            await ad.write(JCC_ANN_FILE, JSON.stringify(this.data, null, 2) + '\n');
        }).catch(e => {
            console.error('[jcc] annotation save failed', e);
            new Notice('Could not save figure annotations: ' + e.message);
        });
        return this._chain;
    }

    forFigure(figPath) {
        return this.data.annotations
            .filter(a => a.figure === figPath)
            .sort((a, b) => String(a.created).localeCompare(String(b.created)));
    }

    forNote(notePath) {
        return this.data.annotations
            .filter(a => a.note === notePath)
            .sort((a, b) => String(a.created).localeCompare(String(b.created)));
    }

    openCount(figPath) {
        return this.forFigure(figPath).filter(a => a.status !== 'resolved').length;
    }

    // RELOAD BEFORE EVERY MUTATION. this.data is cached from the first load(),
    // and save() serialises that whole cached object - so anything written to
    // annotations.json by the Python CLI after the plugin loaded was silently
    // clobbered by the next pin. That is exactly what happened: two annotations
    // resolved by the CLI came back as open when the next pin was placed. The
    // reload is cheap (one small JSON) and makes the two writers coexist.
    async reload() { await this.load(true); }

    async add(figPath, notePath, x, y, text) {
        await this.reload();
        const a = {
            id: jccAnnId(),
            figure: figPath,
            note: notePath || '',
            x: Math.round(x * 10000) / 10000,
            y: Math.round(y * 10000) / 10000,
            text: text || '',
            status: 'open',
            created: jccNowIso(),
            updated: jccNowIso(),
        };
        this.data.annotations.push(a);
        this.save();
        return a;
    }

    async update(id, patch) {
        await this.reload();
        const a = this.data.annotations.find(n => n.id === id);
        if (!a) return null;
        Object.assign(a, patch, { updated: jccNowIso() });
        this.save();
        return a;
    }

    async remove(id) {
        await this.reload();
        const i = this.data.annotations.findIndex(n => n.id === id);
        if (i < 0) return false;
        this.data.annotations.splice(i, 1);
        this.save();
        return true;
    }

    buildBlock(anns) {
        // OPEN WORK IN TABLES, RESOLVED WORK CHECKED OFF AND FOLDED.
        // This must stay byte-identical in shape to build_block() in
        // analysis/scripts/figure_annotations.py: BOTH write this block, so if
        // they disagree, whichever synced last silently reverts the other. The
        // Python side is the one Claude Science runs; this is the one a JCC
        // reload runs. Change one, change both.
        const oneLine = (t) => String(t || '')
            .replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');
        const openA = anns.filter(a => a.status !== 'resolved');
        const doneA = anns.filter(a => a.status === 'resolved');
        const lines = [
            JCC_ANN_START,
            '## Figure Annotations',
            '',
            `*${openA.length} open · ${doneA.length} done · ${anns.length} total. ` +
            'Pinned directly on the figures — ' +
            'click a figure to add or edit one. Positions are % from the left and % from ' +
            'the top of the image. Maintained by Jarvis Command Center; run `/fix-figures` ' +
            'to act on these.*',
            '',
        ];
        if (!anns.length) {
            lines.push('*None pinned.*', '', JCC_ANN_END);
            return lines.join('\n');
        }
        const group = (arr) => {
            const m = new Map();
            for (const a of arr) {
                if (!m.has(a.figure)) m.set(a.figure, []);
                m.get(a.figure).push(a);
            }
            for (const list of m.values()) {
                list.sort((a, b) => String(a.created).localeCompare(String(b.created)));
            }
            return m;
        };
        if (openA.length) {
            for (const [fig, list] of group(openA)) {
                // PATH-QUALIFIED, not just the filename. QC figures repeat their
                // names across day folders — D8/qc and D15/qc both hold a
                // QC_08_cd22_tpex.png — so a bare [[name]] can resolve to the wrong
                // day's figure. The alias keeps it readable.
                const figName = fig.split('/').pop();
                lines.push(`### [[${fig}|${figName}]]`, '', '`' + fig + '`', '');
                lines.push('| # | Where on figure | Annotation |');
                lines.push('|---|-----------------|------------|');
                list.forEach((a, i) => {
                    lines.push(`| ${i + 1} | ${jccWhere(a)} | ${oneLine(a.text)} |`);
                });
                lines.push('');
            }
        } else {
            lines.push('> [!check] All annotations resolved',
                       '> Nothing outstanding on this note\'s figures.', '');
        }
        if (doneA.length) {
            // `[!done]-` with the trailing hyphen renders COLLAPSED in Obsidian,
            // so finished work costs one folded line instead of a table.
            const plural = doneA.length === 1 ? 'annotation' : 'annotations';
            lines.push(`> [!done]- ${doneA.length} resolved ${plural}`, '>');
            for (const [fig, list] of group(doneA)) {
                lines.push(`> **${fig.split('/').pop()}**`);
                for (const a of list) {
                    lines.push(`> - [x] ~~${oneLine(a.text)}~~  <small>${jccWhere(a)}</small>`);
                    const why = oneLine(a.resolution);
                    if (why) lines.push(`>     — ${why}`);
                }
                lines.push('>');
            }
            lines.push('');
        }
        lines.push(JCC_ANN_END);
        return lines.join('\n');
    }

    // Mirror this note's annotations into the note itself, between markers.
    // Same convention as the colony-count block, so the note stays hand-editable
    // everywhere except the managed region.
    async syncNote(notePath) {
        if (!notePath) return false;
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (!file || !(file instanceof TFile)) return false;
        const anns = this.forNote(notePath);
        const re = new RegExp(jccEscapeRe(JCC_ANN_START) + '[\\s\\S]*?' + jccEscapeRe(JCC_ANN_END));
        let text = await this.app.vault.read(file);
        const had = re.test(text);
        if (!anns.length) {
            if (!had) return false;
            text = text.replace(re, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
        } else {
            const block = this.buildBlock(anns);
            text = had ? text.replace(re, block)
                       : text.replace(/\s*$/, '') + '\n\n' + block + '\n';
        }
        await this.app.vault.modify(file, text);
        return true;
    }
}

// ── Text annotations ─────────────────────────────────────────────────────────
//
// The figure annotator's counterpart for prose. Select text in a note, pin a
// comment to it, and the comment travels with that text.
//
// WHY THIS IS NOT JUST THE FIGURE STORE WITH A DIFFERENT SHAPE. A figure pin is
// anchored by two numbers against a path, and those numbers stay correct no
// matter what happens inside the image. Prose has no such coordinate. A line
// number breaks on the next edit above it; a character offset breaks on the
// next edit before it; and a report gets edited constantly, which is the whole
// reason for annotating it.
//
// So an anchor here is a QUOTE plus its surroundings — the W3C Web Annotation
// TextQuoteSelector model, the same one Hypothesis uses:
//
//   exact    the selected text itself
//   prefix   the 40 characters before it
//   suffix   the 40 characters after it
//   start    the character offset at pin time, kept only as a hint
//   section  the nearest preceding heading, so the anchor is human-readable
//
// Resolution then has three outcomes, and reporting the third honestly is what
// makes the tool trustworthy:
//
//   anchored  the quote is still at `start` with its prefix and suffix intact
//   moved     the quote is elsewhere in the note; prefix/suffix pick the right
//             occurrence when the same sentence appears more than once
//   stale     the quoted text itself is gone — edited away or rewritten
//
// A stale anchor is NEVER silently re-pointed at the closest surviving text.
// Guessing would put a comment on a sentence the author never commented on,
// which is worse than losing the location: the comment is still readable, still
// carries its quote, and the CLI's `check` command lists exactly these.
//
// The store, the mirrored markdown block and the two-writer discipline are all
// deliberately the same as JccAnnotationStore — see its comment block. The one
// difference is that this store lives in its own file, so a bug here cannot
// corrupt figure annotations and the existing Python CLI keeps working
// untouched.

const JCC_TANN_DIR   = 'data/_annotations';
const JCC_TANN_FILE  = JCC_TANN_DIR + '/text-annotations.json';
const JCC_TANN_START = '<!-- text-annotations:start -->';
const JCC_TANN_END   = '<!-- text-annotations:end -->';
const JCC_TANN_CTX   = 40;    // chars of prefix/suffix stored with each anchor
const JCC_TANN_MAXQ  = 400;   // cap on the stored quote

function jccTAnnId() {
    return 'txt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// Collapse whitespace before comparing. A quote captured from the RENDERED text
// has single spaces where the markdown source may have a line break, so the two
// only match after normalisation. Offsets are computed against the normalised
// string throughout, never mixed with raw ones.
function jccNorm(s) { return String(s || '').replace(/\s+/g, ' '); }

// Map an offset in the NORMALISED text back to the raw source.
//
// Needed because every anchor offset is normalised (that is what lets a
// hard-wrapped source match a rendered line) while anything that reads markdown
// structure — headings, in particular — has to see real line breaks. Getting
// this wrong is silent: jccSectionAt on normalised text can never match `^#`,
// so every annotation would report an empty section and the mirrored block
// would file them all under "(no section)".
function jccRawOffset(src, normIdx) {
    if (normIdx <= 0) return 0;
    let n = 0, prevSpace = false;
    for (let i = 0; i < src.length; i++) {
        if (/\s/.test(src[i])) {
            if (prevSpace) continue;
            prevSpace = true;
        } else {
            prevSpace = false;
        }
        if (n === normIdx) return i;
        n++;
    }
    return src.length;
}

// The heading a NORMALISED offset sits under, for the "where" column. Takes the
// raw source, not the normalised string — see jccRawOffset.
function jccSectionAt(src, normIdx) {
    const before = src.slice(0, jccRawOffset(src, normIdx));
    const heads = before.match(/^#{1,6} .*$/gm);
    if (!heads || !heads.length) return '';
    return heads[heads.length - 1].replace(/^#+\s*/, '').trim();
}

// Find where an anchor currently sits. Returns {status, start, end} with start
// as an index into the NORMALISED note text.
//
// Scoring rather than first-match: a phrase like "the chronic arm" occurs many
// times in one report, so the occurrence whose neighbours match the stored
// prefix/suffix is the right one even when it is not the first or the nearest.
function jccLocateAnchor(noteSrc, ann) {
    const hay = jccNorm(noteSrc);
    const exact = jccNorm(ann.exact);
    if (!exact) return { status: 'stale', start: -1, end: -1 };

    const pre = jccNorm(ann.prefix || '');
    const suf = jccNorm(ann.suffix || '');
    const scoreAt = (i) => {
        let s = 0;
        if (pre) {
            const got = hay.slice(Math.max(0, i - pre.length), i);
            // longest common suffix of the two prefixes
            let k = 0;
            while (k < got.length && k < pre.length &&
                   got[got.length - 1 - k] === pre[pre.length - 1 - k]) k++;
            s += k / pre.length;
        }
        if (suf) {
            const got = hay.slice(i + exact.length, i + exact.length + suf.length);
            let k = 0;
            while (k < got.length && k < suf.length && got[k] === suf[k]) k++;
            s += k / suf.length;
        }
        return s;
    };

    // Fast path: unmoved text. Only accepted if the neighbours agree too, so an
    // edit that happens to leave the same words at the same offset cannot pass.
    const hint = typeof ann.start === 'number' ? ann.start : -1;
    if (hint >= 0 && hay.slice(hint, hint + exact.length) === exact && scoreAt(hint) >= 1.6) {
        return { status: 'anchored', start: hint, end: hint + exact.length };
    }

    const hits = [];
    for (let i = hay.indexOf(exact); i !== -1; i = hay.indexOf(exact, i + 1)) hits.push(i);
    if (!hits.length) return { status: 'stale', start: -1, end: -1 };
    if (hits.length === 1) {
        const only = hits[0];
        return { status: only === hint ? 'anchored' : 'moved', start: only, end: only + exact.length };
    }
    let best = hits[0], bestScore = -1;
    for (const i of hits) {
        // Tie-break on proximity to the remembered offset, which is right far
        // more often than picking the first occurrence.
        const sc = scoreAt(i) - (hint >= 0 ? Math.abs(i - hint) / hay.length * 0.01 : 0);
        if (sc > bestScore) { bestScore = sc; best = i; }
    }
    return { status: best === hint ? 'anchored' : 'moved', start: best, end: best + exact.length };
}

// ── Store ────────────────────────────────────────────────────────────────────

class JccTextAnnotationStore {
    constructor(app) {
        this.app = app;
        this.data = { version: 1, annotations: [] };
        this.loaded = false;
        this._chain = Promise.resolve();
    }

    async load(force = false) {
        if (this.loaded && !force) return this.data;
        const ad = this.app.vault.adapter;
        try {
            if (await ad.exists(JCC_TANN_FILE)) {
                const parsed = JSON.parse(await ad.read(JCC_TANN_FILE));
                if (parsed && Array.isArray(parsed.annotations)) this.data = parsed;
            }
        } catch (e) {
            console.error('[jcc] text-annotations.json unreadable', e);
            try {
                await ad.write(JCC_TANN_FILE + '.corrupt', await ad.read(JCC_TANN_FILE));
            } catch (_) { /* best effort */ }
            new Notice('Text annotations file was unreadable — started a fresh one, old copy kept as text-annotations.json.corrupt');
        }
        this.loaded = true;
        try {
            const st = await ad.stat(JCC_TANN_FILE);
            if (st) this._mtime = st.mtime;
        } catch (e) { /* stamp is an optimisation */ }
        return this.data;
    }

    async reloadIfChanged() {
        const ad = this.app.vault.adapter;
        try {
            const st = await ad.stat(JCC_TANN_FILE);
            if (!st) return this.data;
            if (this._mtime === st.mtime) return this.data;
            this._mtime = st.mtime;
            return await this.load(true);
        } catch (e) { return this.data; }
    }

    save() {
        const ad = this.app.vault.adapter;
        this._chain = this._chain.then(async () => {
            if (!(await ad.exists(JCC_TANN_DIR))) await ad.mkdir(JCC_TANN_DIR);
            await ad.write(JCC_TANN_FILE, JSON.stringify(this.data, null, 2) + '\n');
        }).catch(e => {
            console.error('[jcc] text annotation save failed', e);
            new Notice('Could not save text annotations: ' + e.message);
        });
        return this._chain;
    }

    forNote(notePath) {
        return this.data.annotations
            .filter(a => a.note === notePath)
            .sort((a, b) => String(a.created).localeCompare(String(b.created)));
    }

    openCount(notePath) {
        return this.forNote(notePath).filter(a => a.status !== 'resolved').length;
    }

    // Same reason as the figure store: the Python CLI is a second writer, so the
    // in-memory copy is refreshed before every mutation or a CLI resolve would
    // be clobbered by the next pin.
    async reload() { await this.load(true); }

    async add(notePath, exact, prefix, suffix, start, section, text) {
        await this.reload();
        const a = {
            id: jccTAnnId(),
            note: notePath || '',
            exact: String(exact || '').slice(0, JCC_TANN_MAXQ),
            prefix: String(prefix || ''),
            suffix: String(suffix || ''),
            start: typeof start === 'number' ? start : -1,
            section: section || '',
            text: text || '',
            status: 'open',
            created: jccNowIso(),
            updated: jccNowIso(),
        };
        this.data.annotations.push(a);
        this.save();
        return a;
    }

    async update(id, patch) {
        await this.reload();
        const a = this.data.annotations.find(n => n.id === id);
        if (!a) return null;
        Object.assign(a, patch, { updated: jccNowIso() });
        this.save();
        return a;
    }

    async remove(id) {
        await this.reload();
        const i = this.data.annotations.findIndex(n => n.id === id);
        if (i < 0) return false;
        this.data.annotations.splice(i, 1);
        this.save();
        return true;
    }

    // Re-point every anchor in a note against its current text and persist the
    // new offsets. Run after the note changes, so `start` stays a useful hint
    // and drift is recorded once rather than recomputed on every draw.
    async reanchor(notePath, src) {
        await this.reload();
        let moved = 0, stale = 0;
        for (const a of this.data.annotations) {
            if (a.note !== notePath || a.status === 'resolved') continue;
            const loc = jccLocateAnchor(src, a);
            if (loc.status === 'stale') { a.anchor = 'stale'; stale++; continue; }
            if (loc.status === 'moved') moved++;
            a.anchor = loc.status;
            a.start = loc.start;
            a.section = jccSectionAt(src, loc.start);
        }
        if (moved || stale) this.save();
        return { moved, stale };
    }

    buildBlock(anns, src) {
        // Must stay byte-identical in shape to build_block() in
        // analysis/scripts/text_annotations.py. BOTH write this block; if they
        // disagree, whichever synced last silently reverts the other.
        const oneLine = (t) => String(t || '')
            .replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');
        const quote = (t) => {
            const s = oneLine(t);
            return s.length > 90 ? s.slice(0, 88).trimEnd() + '…' : s;
        };
        const openA = anns.filter(a => a.status !== 'resolved');
        const doneA = anns.filter(a => a.status === 'resolved');
        const lines = [
            JCC_TANN_START,
            '## Text Annotations',
            '',
            `*${openA.length} open · ${doneA.length} done · ${anns.length} total. ` +
            'Pinned to the quoted text — select any passage and run ' +
            '"Annotate selected text". Anchors follow the text when it moves and are ' +
            'flagged stale when the quote itself is edited away. Maintained by Jarvis ' +
            'Command Center; run `/fix-text` to act on these.*',
            '',
        ];
        if (!anns.length) {
            lines.push('*None pinned.*', '', JCC_TANN_END);
            return lines.join('\n');
        }
        if (openA.length) {
            // Grouped by section so the list reads in document order rather than
            // in the order the comments happened to be made.
            const m = new Map();
            for (const a of openA) {
                const k = a.section || '(no section)';
                if (!m.has(k)) m.set(k, []);
                m.get(k).push(a);
            }
            for (const [sec, list] of m) {
                list.sort((a, b) => (a.start || 0) - (b.start || 0));
                lines.push(`**${sec}**`, '');   // bold, not a heading: a heading here would
                                                    // duplicate the note's own outline entries
                lines.push('| # | Quoted text | Comment | Anchor |');
                lines.push('|---|-------------|---------|--------|');
                list.forEach((a, i) => {
                    const st = a.anchor === 'stale' ? '**stale**'
                             : a.anchor === 'moved' ? 'moved' : 'ok';
                    lines.push(`| ${i + 1} | "${quote(a.exact)}" | ${oneLine(a.text)} | ${st} |`);
                });
                lines.push('');
            }
            const staleN = openA.filter(a => a.anchor === 'stale').length;
            if (staleN) {
                lines.push(`> [!warning] ${staleN} anchor${staleN === 1 ? ' no longer matches' : 's no longer match'} the text`,
                           '> The quoted passage was edited or removed, so the comment has lost its place.',
                           '> The comment and its quote are kept — re-pin it, or resolve it if it is done.',
                           '');
            }
        } else {
            lines.push('> [!check] All annotations resolved',
                       '> Nothing outstanding on this note\'s text.', '');
        }
        if (doneA.length) {
            const plural = doneA.length === 1 ? 'annotation' : 'annotations';
            lines.push(`> [!done]- ${doneA.length} resolved ${plural}`, '>');
            for (const a of doneA) {
                lines.push(`> - [x] ~~${oneLine(a.text)}~~  <small>"${quote(a.exact)}"</small>`);
                const why = oneLine(a.resolution);
                if (why) lines.push(`>     — ${why}`);
            }
            lines.push('>', '');
        }
        lines.push(JCC_TANN_END);
        return lines.join('\n');
    }

    async syncNote(notePath) {
        if (!notePath) return false;
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (!file || !(file instanceof TFile)) return false;
        let text = await this.app.vault.read(file);

        // Re-anchor against the note WITHOUT its own mirrored block, or the
        // block's quoted copies become rival matches for every anchor.
        const re = new RegExp(jccEscapeRe(JCC_TANN_START) + '[\\s\\S]*?' + jccEscapeRe(JCC_TANN_END));
        const body = text.replace(re, '');
        await this.reanchor(notePath, body);

        const anns = this.forNote(notePath);
        const had = re.test(text);
        if (!anns.length) {
            if (!had) return false;
            text = text.replace(re, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
        } else {
            const block = this.buildBlock(anns, body);
            text = had ? text.replace(re, block)
                       : text.replace(/\s*$/, '') + '\n\n' + block + '\n';
        }
        await this.app.vault.modify(file, text);
        return true;
    }
}

// ── Capturing a selection ────────────────────────────────────────────────────
//
// The quote is taken from the RENDERED text, but the anchor has to resolve
// against the markdown SOURCE. Rather than maintaining a DOM-to-source offset
// map — which breaks on every embed, callout and table — the rendered selection
// supplies only the quote and its neighbours, and jccLocateAnchor finds that
// quote in the source. Normalising whitespace on both sides is what lets a
// rendered line-wrapped sentence match its hard-wrapped source.
function jccSelectionAnchor(app, notePath, src) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const raw = sel.toString();
    if (!raw.trim()) return null;

    const range = sel.getRangeAt(0);
    const host = range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const container = host && host.closest(
        '.markdown-rendered, .markdown-preview-view, .markdown-source-view, .cm-content');
    if (!container) return null;

    // Offset of the selection within the container's own text, used only to cut
    // prefix/suffix out of the rendered text.
    let renderedStart = 0;
    try {
        const pre = range.cloneRange();
        pre.selectNodeContents(container);
        pre.setEnd(range.startContainer, range.startOffset);
        renderedStart = pre.toString().length;
    } catch (e) { /* fall through with 0 */ }
    const all = container.textContent || '';
    const prefix = all.slice(Math.max(0, renderedStart - JCC_TANN_CTX), renderedStart);
    const suffix = all.slice(renderedStart + raw.length, renderedStart + raw.length + JCC_TANN_CTX);

    const probe = { exact: raw, prefix, suffix, start: -1 };
    const loc = jccLocateAnchor(src, probe);
    if (loc.status === 'stale') return null;   // selection spans rendered-only text
    return {
        exact: jccNorm(raw).slice(0, JCC_TANN_MAXQ),
        prefix: jccNorm(prefix),
        suffix: jccNorm(suffix),
        start: loc.start,
        section: jccSectionAt(src, loc.start),
    };
}

// ── Compose / edit modal ─────────────────────────────────────────────────────

class JccTextAnnotateModal extends Modal {
    constructor(app, store, notePath, anchor, existing, onDone) {
        super(app);
        this.store = store;
        this.notePath = notePath;
        this.anchor = anchor;
        this.existing = existing || null;
        this.onDone = onDone || (() => {});
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('jcc-tann-modal');
        const a = this.existing;
        contentEl.createEl('h3', {
            text: a ? 'Edit annotation' : 'Annotate selected text',
        });

        const q = a ? a.exact : this.anchor.exact;
        const sec = a ? a.section : this.anchor.section;
        if (sec) contentEl.createEl('div', { cls: 'jcc-tann-where', text: sec });
        contentEl.createEl('blockquote', { cls: 'jcc-tann-quote', text: q });

        const ta = contentEl.createEl('textarea', { cls: 'jcc-tann-input' });
        ta.rows = 4;
        ta.placeholder = 'What needs attention here?';
        ta.value = a ? (a.text || '') : '';
        window.setTimeout(() => { ta.focus(); ta.select(); }, 0);

        const bar = contentEl.createDiv({ cls: 'jcc-tann-bar' });
        const commit = async () => {
            const text = ta.value.trim();
            if (!text) { new Notice('Nothing to save — the comment is empty.'); return; }
            if (a) await this.store.update(a.id, { text, status: 'open' });
            else await this.store.add(this.notePath, this.anchor.exact, this.anchor.prefix,
                                      this.anchor.suffix, this.anchor.start,
                                      this.anchor.section, text);
            await this.store.syncNote(this.notePath);
            this.close();
            this.onDone();
        };

        const save = bar.createEl('button', { cls: 'jcc-tann-btn jcc-tann-primary',
                                              text: a ? 'Save' : 'Pin annotation' });
        save.onclick = commit;

        if (a) {
            const res = bar.createEl('button', { cls: 'jcc-tann-btn', text: 'Resolve' });
            res.onclick = async () => {
                await this.store.update(a.id, { status: 'resolved', resolution: '' });
                await this.store.syncNote(this.notePath);
                this.close(); this.onDone();
            };
            const del = bar.createEl('button', { cls: 'jcc-tann-btn jcc-tann-danger', text: 'Delete' });
            del.onclick = async () => {
                await this.store.remove(a.id);
                await this.store.syncNote(this.notePath);
                this.close(); this.onDone();
            };
        }
        const cancel = bar.createEl('button', { cls: 'jcc-tann-btn', text: 'Cancel' });
        cancel.onclick = () => this.close();

        // Cmd/Ctrl-Enter commits, matching the figure annotator.
        ta.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
        });
    }

    onClose() { this.contentEl.empty(); }
}

// ── Highlighting anchors in the rendered note ────────────────────────────────
//
// Per-element rather than whole-document: for each rendered block, look for each
// open annotation's quote inside that block's own text. A quote that spans two
// blocks simply does not highlight — the comment is still listed in the mirrored
// table, so nothing is lost, and the alternative (a document-wide offset map
// rebuilt on every repaint) is both slower and far easier to get wrong.
function jccHighlightAnchors(el, anns) {
    if (!anns.length) return;
    const blocks = el.matches('p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6')
        ? [el] : Array.from(el.querySelectorAll('p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6'));
    for (const block of blocks) {
        if (block.closest('.jcc-tann-block')) continue;          // our own mirrored table
        const flat = jccNorm(block.textContent || '');
        if (!flat) continue;
        for (const a of anns) {
            const needle = jccNorm(a.exact);
            if (!needle || needle.length < 4) continue;
            if (flat.indexOf(needle) === -1) continue;
            if (block.querySelector(`.jcc-tann-hit[data-ann="${a.id}"]`)) continue;
            jccWrapFirst(block, needle, a);
        }
    }
}

// Wrap the first occurrence of `needle` inside `block`, walking text nodes so a
// quote crossing inline markup (bold, code, a link) is still wrapped correctly.
function jccWrapFirst(block, needle, ann) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let acc = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement && n.parentElement.closest('.jcc-tann-hit')) continue;
        nodes.push({ node: n, at: acc.length, text: n.nodeValue });
        acc += n.nodeValue;
    }
    // Offsets are found in the normalised string, then mapped back to the raw
    // one, because collapsing whitespace shifts every index after it.
    const map = [];
    let norm = '';
    let prevSpace = false;
    for (let i = 0; i < acc.length; i++) {
        const ch = acc[i];
        if (/\s/.test(ch)) {
            if (prevSpace) continue;
            norm += ' '; map.push(i); prevSpace = true;
        } else {
            norm += ch; map.push(i); prevSpace = false;
        }
    }
    const ni = norm.indexOf(needle);
    if (ni === -1 || ni >= map.length) return;
    const rawStart = map[ni];
    const rawEnd = ni + needle.length - 1 < map.length ? map[ni + needle.length - 1] + 1 : acc.length;

    const locate = (off) => {
        for (const rec of nodes) {
            if (off >= rec.at && off <= rec.at + rec.text.length) {
                return { node: rec.node, offset: off - rec.at };
            }
        }
        return null;
    };
    const s = locate(rawStart), e = locate(rawEnd);
    if (!s || !e) return;
    try {
        const range = document.createRange();
        range.setStart(s.node, s.offset);
        range.setEnd(e.node, e.offset);
        const span = document.createElement('span');
        span.className = 'jcc-tann-hit' + (ann.anchor === 'moved' ? ' jcc-tann-moved' : '');
        span.setAttribute('data-ann', ann.id);
        span.setAttribute('aria-label', ann.text || '');
        // surroundContents throws when the range partially selects a node, which
        // is exactly the crossing-inline-markup case; extract+insert handles it.
        span.appendChild(range.extractContents());
        range.insertNode(span);
    } catch (err) { /* an unwrappable range is not worth surfacing */ }
}

// ── Full-screen annotator ────────────────────────────────────────────────────

class JccFigureAnnotateModal extends Modal {
    constructor(app, store, figFile, notePath) {
        super(app);
        this.store = store;
        this.fig = figFile;
        this.notePath = notePath || '';
        this.baseW = 1000;
        this.baseH = 700;
        this.fitScale = 1;
        this.scale = 1;
        this.tx = 0;
        this.ty = 0;
        this.annotateMode = true;
        this.pop = null;
        this.selectedId = null;
        this.dirty = false;
        this._off = [];   // manual listener teardown, see _build()
    }

    // Bind a listener and remember how to remove it. Used instead of
    // registerDomEvent - see the comment in _build().
    _on(el, type, fn, opts) { jccBind(this, el, type, fn, opts); }

    onOpen() {
        // Guarded, because a throw part-way through building this modal
        // leaves a window that looks finished but has no working controls,
        // with nothing in the UI to say why.
        try {
            this._build();
        } catch (err) {
            console.error('[jcc] figure annotator failed to open', err);
            new Notice('Figure annotator failed to open — see the developer console');
        }
    }

    _build() {
        const { contentEl, modalEl } = this;
        // The window/document this modal is really in, which is not
        // necessarily the main one — see jccModalDoc.
        const doc = jccModalDoc(this);
        const win = jccModalWin(this);
        modalEl.addClass('jcc-annot-modal');
        contentEl.empty();

        const head = contentEl.createDiv('jcc-annot-head');
        head.createSpan({ cls: 'jcc-annot-title', text: this.fig.name });
        if (this.notePath) {
            head.createSpan({ cls: 'jcc-annot-sub', text: 'in ' + this.notePath.split('/').pop().replace(/\.md$/, '') });
        }

        const body = contentEl.createDiv('jcc-annot-body');
        const stage = body.createDiv('jcc-annot-stage jcc-annot-armed');
        this.stage = stage;

        const canvas = stage.createDiv('jcc-annot-canvas');
        this.canvas = canvas;
        const img = canvas.createEl('img', { cls: 'jcc-annot-img' });
        this.img = img;
        img.draggable = false;
        img.src = this.app.vault.getResourcePath(this.fig);

        const ready = () => {
            // SVGs and some exports report no intrinsic size; the fallback keeps
            // the coordinate space sane rather than dividing by zero.
            this.baseW = img.naturalWidth || 1000;
            this.baseH = img.naturalHeight || 700;
            canvas.style.width = this.baseW + 'px';
            canvas.style.height = this.baseH + 'px';
            this.fit();
            this.renderPins();
        };
        if (img.complete && img.naturalWidth) ready();
        else img.addEventListener('load', ready, { once: true });
        img.addEventListener('error', () => {
            new Notice('Could not load ' + this.fig.path);
            this.close();
        }, { once: true });

        this.side = body.createDiv('jcc-annot-side');

        const bar = contentEl.createDiv('jcc-annot-bar');
        const mk = (label, title, fn, cls) => {
            const b = bar.createEl('button', { text: label, cls: 'jcc-annot-btn' + (cls ? ' ' + cls : '') });
            b.setAttribute('aria-label', title);
            b.onclick = fn;
            return b;
        };
        this.modeBtn = mk('✚ Annotate: on', 'Toggle click-to-annotate', () => this.toggleMode(), 'jcc-annot-mode-on');
        mk('−', 'Zoom out', () => this.zoom(1 / 1.25));
        this.readout = bar.createSpan({ cls: 'jcc-annot-scale', text: '100%' });
        mk('+', 'Zoom in', () => this.zoom(1.25));
        mk('Fit', 'Reset to fit', () => this.fit());
        bar.createSpan({ cls: 'jcc-annot-hint', text: 'click image = pin · drag = pan · scroll = zoom · Esc = close' });

        // EVENT BINDING IS MANUAL HERE, not the Component helper.
        //
        // Modal is not a dependable Component in this build. The presentation
        // modal above documents four listeners registered from inside a modal
        // that were never delivered, which is why its keyboard handling lives at
        // plugin level. When the method is missing outright the failure is worse
        // than silent: the call throws, so every registration after it in this
        // function is skipped - which presents as "the image and the toolbar are
        // both there, but clicking does nothing". Plain addEventListener with
        // explicit teardown in onClose has neither failure mode.
        //
        // Placement also listens for a real 'click' rather than reconstructing
        // one from mouseup, so dropping a pin needs only the event the browser
        // already emits.
        let down = null;
        let dragged = false;

        this._on(stage, 'mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target instanceof Element && e.target.closest('.jcc-pin, .jcc-annot-pop')) return;
            down = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
            dragged = false;
        });
        this._on(doc, 'mousemove', (e) => {
            if (!down) return;
            const dx = e.clientX - down.x, dy = e.clientY - down.y;
            // Under 4px this is a click from an unsteady hand, not a pan.
            if (!dragged && Math.hypot(dx, dy) < 4) return;
            dragged = true;
            stage.addClass('jcc-grabbing');
            this.tx = down.tx + dx;
            this.ty = down.ty + dy;
            this.apply();
        });
        this._on(doc, 'mouseup', () => {
            down = null;
            stage.removeClass('jcc-grabbing');
        });
        this._on(stage, 'click', (e) => {
            if (dragged) { dragged = false; return; }   // this click just ended a pan
            if (e.target instanceof Element && e.target.closest('.jcc-pin, .jcc-annot-pop')) return;
            if (this.pop) { this.closePop(); return; }  // a stray click dismisses the editor
            if (!this.annotateMode) return;
            this.placeAt(e);
        });
        this._on(stage, 'wheel', (e) => {
            e.preventDefault();
            this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });

        // Escape closes the editor first and the modal second. On capture, so it
        // beats Obsidian's own Escape-closes-the-modal handler while a pin is
        // being written; otherwise the whole window would shut on a stray Esc.
        this._on(doc, 'keydown', (e) => {
            if (e.key !== 'Escape' || !this.pop) return;
            e.preventDefault();
            e.stopPropagation();
            this.closePop();
        }, true);
        this._on(win, 'resize', () => this.fit());

        this.renderList();

        // A cached image runs ready() synchronously inside onOpen, when the
        // stage may not have its final flex size yet — so the first fit can be
        // computed against a stale box. Re-fit once the layout has settled.
        requestAnimationFrame(() => { if (this.stage) this.fit(); });
    }

    async onClose() {
        // Detach FIRST. The note sync below is awaited, and document-level
        // listeners left live across that await would keep acting on a modal
        // the user has already dismissed.
        jccUnbind(this);
        this.contentEl.empty();

        // One write per session rather than per keystroke: the JSON store is
        // already current, so the note block only needs to catch up on the way
        // out.
        if (this.dirty && this.notePath) {
            try { await this.store.syncNote(this.notePath); }
            catch (e) { console.error('[jcc] note sync failed', e); }
        }
        if (this.onDone) this.onDone();
    }

    // ── view ──

    fit() {
        if (!this.stage) return;
        const r = this.stage.getBoundingClientRect();
        const pad = 32;
        const s = Math.min((r.width - pad * 2) / this.baseW, (r.height - pad * 2) / this.baseH);
        this.fitScale = (isFinite(s) && s > 0) ? s : 1;
        this.scale = this.fitScale;
        this.tx = 0;
        this.ty = 0;
        this.apply();
    }

    zoom(f) {
        this.scale = Math.min(this.fitScale * 12, Math.max(this.fitScale * 0.25, this.scale * f));
        this.apply();
    }

    apply() {
        if (!this.canvas) return;
        this.canvas.style.transform =
            `translate(-50%, -50%) translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
        // Pins live inside the scaled canvas so they track the image exactly;
        // this counter-scale keeps them a constant size on screen.
        this.canvas.style.setProperty('--jcc-pin-inv', String(1 / this.scale));
        if (this.readout) this.readout.setText(Math.round(this.scale / this.fitScale * 100) + '%');
    }

    toggleMode() {
        this.annotateMode = !this.annotateMode;
        this.modeBtn.setText(this.annotateMode ? '✚ Annotate: on' : '✚ Annotate: off');
        this.modeBtn.toggleClass('jcc-annot-mode-on', this.annotateMode);
        this.stage.toggleClass('jcc-annot-armed', this.annotateMode);
    }

    // ── pins ──

    renderPins() {
        if (!this.canvas) return;
        this.canvas.querySelectorAll('.jcc-pin').forEach(n => n.remove());
        this.store.forFigure(this.fig.path).forEach((a, i) => {
            const pin = this.canvas.createDiv('jcc-pin');
            if (a.status === 'resolved') pin.addClass('jcc-pin-done');
            if (a.id === this.selectedId) pin.addClass('jcc-pin-sel');
            pin.style.left = (a.x * 100) + '%';
            pin.style.top = (a.y * 100) + '%';
            pin.dataset.id = a.id;
            pin.createSpan({ cls: 'jcc-pin-dot', text: String(i + 1) });
            pin.setAttribute('aria-label', a.text || '(empty)');
            pin.onclick = (ev) => {
                ev.stopPropagation();
                this.selectedId = a.id;
                this.openPop(a, pin.getBoundingClientRect());
                this.renderPins();
                this.renderList();
            };
        });
    }

    placeAt(e) {
        // Measure the IMAGE, falling back to the canvas. If the figure has not
        // finished loading, the canvas still has no intrinsic size - and
        // dividing by a zero width yields Infinity, which fails the range check
        // below and returns silently. That is indistinguishable from a dead
        // click, so it gets its own message instead.
        let r = this.img ? this.img.getBoundingClientRect() : null;
        if (!r || !r.width || !r.height) r = this.canvas.getBoundingClientRect();
        if (!r.width || !r.height) {
            new Notice('Figure is still loading — try that click again in a moment.');
            return;
        }
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        if (typeof window !== 'undefined' && window.JCC_DEBUG) {
            console.log('[jcc] placeAt', { x, y, rect: r, client: [e.clientX, e.clientY] });
        }
        if (!isFinite(x) || !isFinite(y)) return;
        // Clicking the dark surround is a miss, not a pin at the edge.
        if (x < 0 || x > 1 || y < 0 || y > 1) return;
        this.openPop({ id: null, x, y, text: '', status: 'open' },
                     { left: e.clientX, top: e.clientY, width: 0, height: 0 });
    }

    focusPin(a) {
        // Centre the view on the pin. The canvas is centred in the stage, so the
        // offset needed is the pin's distance from the image centre, scaled.
        this.tx = -((a.x - 0.5) * this.baseW) * this.scale;
        this.ty = -((a.y - 0.5) * this.baseH) * this.scale;
        this.apply();
    }

    // ── editor popover ──

    closePop() {
        if (this.pop) { this.pop.remove(); this.pop = null; }
    }

    openPop(a, anchorRect) {
        this.closePop();
        const sr = this.stage.getBoundingClientRect();
        const pop = this.stage.createDiv('jcc-annot-pop');
        this.pop = pop;
        pop.onmousedown = (e) => e.stopPropagation();

        pop.createDiv({ cls: 'jcc-annot-pop-where', text: jccWhere(a) });
        const ta = pop.createEl('textarea', { cls: 'jcc-annot-pop-text' });
        ta.value = a.text || '';
        ta.placeholder = 'What needs to change here?';

        const row = pop.createDiv('jcc-annot-pop-row');
        const save = row.createEl('button', { text: a.id ? 'Save' : 'Add', cls: 'jcc-annot-btn jcc-annot-primary' });
        save.onclick = async () => {
            const txt = ta.value.trim();
            if (!txt) { if (a.id) await this.doDelete(a.id); else this.closePop(); return; }
            // AWAITED: the store reloads from disk before mutating, so a pin placed
            // here merges with anything the CLI resolved since the plugin loaded.
            if (a.id) await this.store.update(a.id, { text: txt });
            else { const made = await this.store.add(this.fig.path, this.notePath, a.x, a.y, txt); this.selectedId = made.id; }
            this.dirty = true;
            this.closePop();
            this.renderPins();
            this.renderList();
        };
        if (a.id) {
            const done = row.createEl('button', {
                text: a.status === 'resolved' ? 'Reopen' : 'Resolve',
                cls: 'jcc-annot-btn',
            });
            done.onclick = async () => {
                await this.store.update(a.id, { status: a.status === 'resolved' ? 'open' : 'resolved' });
                this.dirty = true;
                this.closePop();
                this.renderPins();
                this.renderList();
            };
            const del = row.createEl('button', { text: 'Delete', cls: 'jcc-annot-btn jcc-annot-danger' });
            del.onclick = async () => { await this.doDelete(a.id); };
        }
        const cancel = row.createEl('button', { text: 'Cancel', cls: 'jcc-annot-btn' });
        cancel.onclick = () => this.closePop();

        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closePop(); }
        });

        // Anchor at the click / pin, then pull back inside the stage so the
        // editor is never half off-screen at the image edges.
        pop.style.left = Math.max(8, anchorRect.left - sr.left + 14) + 'px';
        pop.style.top = Math.max(8, anchorRect.top - sr.top + 14) + 'px';
        const pr = pop.getBoundingClientRect();
        if (pr.right > sr.right - 8) pop.style.left = Math.max(8, sr.width - pr.width - 8) + 'px';
        if (pr.bottom > sr.bottom - 8) pop.style.top = Math.max(8, sr.height - pr.height - 8) + 'px';

        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    async doDelete(id) {
        await this.store.remove(id);
        if (this.selectedId === id) this.selectedId = null;
        this.dirty = true;
        this.closePop();
        this.renderPins();
        this.renderList();
    }

    // ── sidebar ──

    renderList() {
        const side = this.side;
        if (!side) return;
        side.empty();
        const list = this.store.forFigure(this.fig.path);
        const open = list.filter(a => a.status !== 'resolved').length;

        const h = side.createDiv('jcc-annot-side-head');
        h.createSpan({ text: `Annotations — ${open} open` });
        if (list.length) {
            const sync = h.createEl('button', { text: 'Sync to note', cls: 'jcc-annot-btn jcc-annot-mini' });
            sync.setAttribute('aria-label', 'Write these into the note now');
            sync.onclick = async () => {
                await this.store.syncNote(this.notePath);
                this.dirty = false;
                new Notice('Figure annotations synced into the note');
            };
        }

        if (!list.length) {
            side.createDiv({ cls: 'jcc-annot-empty', text: 'Click anywhere on the figure to pin your first note to it.' });
            return;
        }

        list.forEach((a, i) => {
            const card = side.createDiv('jcc-annot-card');
            if (a.status === 'resolved') card.addClass('jcc-annot-card-done');
            if (a.id === this.selectedId) card.addClass('jcc-annot-card-sel');
            const top = card.createDiv('jcc-annot-card-top');
            top.createSpan({ cls: 'jcc-annot-num', text: String(i + 1) });
            top.createSpan({ cls: 'jcc-annot-where', text: jccWhere(a) });
            card.createDiv({ cls: 'jcc-annot-text', text: a.text || '(empty)' });
            card.onclick = () => {
                this.selectedId = a.id;
                this.focusPin(a);
                this.renderPins();
                this.renderList();
                const pin = this.canvas.querySelector(`.jcc-pin[data-id="${a.id}"]`);
                if (pin) this.openPop(a, pin.getBoundingClientRect());
            };
        });
    }
}

// Picker for "annotate a figure in this note" when the note holds several.
class JccFigurePickModal extends SuggestModal {
    constructor(app, files, onPick) {
        super(app);
        this.files = files;
        this.onPick = onPick;
        this.setPlaceholder('Which figure?');
    }
    getSuggestions(q) {
        const s = q.toLowerCase();
        return this.files.filter(f => f.path.toLowerCase().includes(s));
    }
    renderSuggestion(f, el) {
        el.createDiv({ text: f.name });
        el.createEl('small', { text: f.path });
    }
    onChooseSuggestion(f) { this.onPick(f); }
}

// Pick what to export. Fronted by a SuggestModal rather than a plain "export
// the open note" button because the common case is wanting a protocol PDF while
// looking at an experiment day file that merely links to it.
class JccPdfExportModal extends SuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder('Export as PDF — name, or "all protocols" / "all reports"…');

        const md = app.vault.getMarkdownFiles();
        const byName = (a, b) => a.basename.localeCompare(b.basename);
        const protocols = md.filter(f => f.path.startsWith('protocols/')).sort(byName);
        const proposals = md.filter(f => f.path.startsWith('proposals/')).sort(byName);
        const reports = plugin.jccReportFiles();

        this.items = [];
        // Batches first: picking "everything of this kind" is the common ask, and
        // burying it under twenty individual notes makes it the slowest one.
        if (protocols.length) this.items.push({
            kind: 'batch', run: () => plugin.exportProtocolPdfs(),
            name: `All protocols (${protocols.length})`, sub: 'One PDF each, into a dated folder in Downloads',
        });
        if (reports.length) this.items.push({
            kind: 'batch', run: () => plugin.exportReportPdfs(),
            name: `All reports (${reports.length})`, sub: 'Every note under an experiment\u2019s reports/ folder',
        });
        if (proposals.length) this.items.push({
            kind: 'batch', run: () => plugin.exportFolderPdfs('proposals'),
            name: `All proposals (${proposals.length})`, sub: 'Everything in proposals/',
        });

        const listed = new Set();
        const add = (f, group) => {
            if (listed.has(f.path)) return;
            listed.add(f.path);
            this.items.push({ kind: 'file', file: f, name: f.basename, sub: `${group} · ${f.path}` });
        };
        const active = app.workspace.getActiveFile();
        if (active && active.extension === 'md') add(active, 'Open note');
        proposals.forEach(f => add(f, 'Proposal'));
        reports.forEach(f => add(f, 'Report'));
        protocols.forEach(f => add(f, 'Protocol'));
    }
    getSuggestions(q) {
        const s = q.toLowerCase().trim();
        if (!s) return this.items;
        return this.items.filter(i => (i.name + ' ' + i.sub).toLowerCase().includes(s));
    }
    renderSuggestion(item, el) {
        el.createDiv({ text: item.name });
        el.createEl('small', { text: item.sub });
    }
    onChooseSuggestion(item) {
        if (item.kind === 'batch') item.run();
        else this.plugin.exportNotePdf(item.file);
    }
}

// ── Tracker tables: click a cell, pick a value ───────────────────────────────
//
// WHAT THIS REPLACES. This began as an .xlsx whose only
// real affordance was two data-validation dropdowns: click a Status cell, get
// the five allowed values, pick one. Converted to a markdown table that
// affordance was lost — changing a status meant finding the row in source,
// retyping the string, and hoping the spelling matched the other 21 rows well
// enough that the counts above the table stayed true.
//
// This restores the dropdown against the markdown table itself. There is no
// database and no sidecar file: the table in the note IS the data, exactly as
// before, and a pick rewrites that one cell in place.
//
// THE SCHEMA LIVES IN A ```jcc-tracker FENCE, not in frontmatter. Frontmatter
// is the properties panel, and a five-value enum per column renders there as a
// wall of list rows the user has to scroll past to reach `tags`. The fence sits
// directly above the table it describes, renders as the summary/filter bar the
// spreadsheet had in its top rows, and keeps the note readable as plain text.
//
// Fence grammar — one directive per line:
//     title: Lab Rotation
//     key: Name                        ← column that identifies a row
//     counts: Status                   ← column the summary chips tally
//     Status: Met | Scheduled | ...    ← enum column (the dropdown)
//     Role: Postdoc | ...
//     scGOAT: @toggle ★                ← blank ⇄ mark
//     Date Met: @date
//     Notes: @text
// A column absent from the fence is still clickable and treated as @text.

const JCC_TRACKER_RESERVED = new Set(['title', 'key', 'counts']);

// Parsed fences are cached per note. The post-processor, the summary bar and
// the click handler all need the same schema, and Obsidian re-runs the
// post-processor on every re-render — re-reading and re-parsing the file each
// time would put a disk read behind every scroll.
const JCC_TRACKER_CACHE = new Map();   // path -> { mtime, schema, table }

function jccParseTrackerFence(src) {
    const schema = { title: '', key: '', counts: '', cols: new Map(), order: [] };
    for (const raw of String(src || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const rest = line.slice(i + 1).trim();
        const lower = name.toLowerCase();
        if (JCC_TRACKER_RESERVED.has(lower)) { schema[lower] = rest; continue; }
        let field;
        if (rest.startsWith('@date')) {
            field = { kind: 'date' };
        } else if (rest.startsWith('@toggle')) {
            field = { kind: 'toggle', mark: rest.slice('@toggle'.length).trim() || '✓' };
        } else if (rest.startsWith('@text')) {
            field = { kind: 'text' };
        } else {
            // Anything else is the spreadsheet's data-validation list.
            field = { kind: 'enum', values: rest.split('|').map(v => v.trim()).filter(Boolean) };
        }
        field.name = name;
        schema.cols.set(name.toLowerCase(), field);
        schema.order.push(name);
    }
    return schema;
}

// ── Markdown table read/write ────────────────────────────────────────────────

// Split one table row into cells. Must honour \| — a cell containing an escaped
// pipe is one cell, and a naive split('|') would silently shear the row in two
// and shift every value after it into the wrong column.
function jccSplitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
        if (s[i] === '|') { out.push(cur); cur = ''; continue; }
        cur += s[i];
    }
    out.push(cur);
    return out.map(c => c.trim());
}

function jccIsSepRow(line) {
    const s = (line || '').trim();
    if (!s.startsWith('|')) return false;
    return jccSplitRow(s).every(c => /^:?-{1,}:?$/.test(c));
}

// Locate the tracker table in a note's text. Returns line offsets so the
// rewrite can splice exactly those lines back and leave the rest of the note —
// callouts, prose, the meeting-notes section — byte-identical.
function jccFindTrackerTable(text, schema) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        if (!lines[i].trim().startsWith('|')) continue;
        if (!jccIsSepRow(lines[i + 1])) continue;
        const header = jccSplitRow(lines[i]);
        if (schema && schema.key) {
            const want = schema.key.toLowerCase();
            if (!header.some(h => h.toLowerCase() === want)) continue;
        }
        const sep = jccSplitRow(lines[i + 1]);
        const rows = [];
        let end = i + 2;
        while (end < lines.length && lines[end].trim().startsWith('|')) {
            rows.push(jccSplitRow(lines[end]));
            end++;
        }
        return { start: i, end, header, sep, rows };
    }
    return null;
}

// Re-emit the table with every column padded to its widest cell.
//
// The alternative — patch the one cell and leave the rest of the line alone —
// leaves the source ragged the moment a value gets longer or shorter, which is
// exactly the state this note was in before. Rewriting the block keeps the raw
// markdown as readable as the rendered table, and the alignment markers are
// carried over from the existing separator so a right-aligned column stays
// right-aligned.
function jccRenderTable(t) {
    const n = t.header.length;
    const norm = r => { const c = r.slice(0, n); while (c.length < n) c.push(''); return c; };
    const rows = t.rows.map(norm);
    const head = norm(t.header);
    const width = [];
    for (let c = 0; c < n; c++) {
        width[c] = Math.max(3, head[c].length, ...rows.map(r => r[c].length));
    }
    const line = cells => '| ' + cells.map((v, c) => v.padEnd(width[c])).join(' | ') + ' |';
    const sep = [];
    for (let c = 0; c < n; c++) {
        const m = (t.sep && t.sep[c]) || '---';
        const left = m.startsWith(':'), right = m.endsWith(':');
        const dashes = '-'.repeat(Math.max(3, width[c] - (left ? 1 : 0) - (right ? 1 : 0)));
        sep.push((left ? ':' : '') + dashes + (right ? ':' : ''));
    }
    return [line(head), '| ' + sep.join(' | ') + ' |', ...rows.map(line)].join('\n');
}

// Strip the markdown a cell may carry so a rendered value can be matched back
// to its source cell: [[Ankit Basak|Ankit]] and **Met** must compare equal to
// what the reader clicked on.
function jccCellText(s) {
    // UNESCAPE FIRST. A wikilink alias inside a table cell must be written
    // [[Ankit Basak\|Ankit]] — an unescaped pipe there would end the cell — so
    // stripping links before unescaping would leave the alias pattern
    // unmatched and return the raw source instead of the visible text.
    return String(s || '')
        .replace(/\\\|/g, '|')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .trim();
}

// Apply one edit to the note. `rowIndex` is the row's ordinal in the table and
// `keyValue` is what that row's key cell read at click time; the ordinal is
// used only when the key still agrees, so a table edited in another pane
// between render and click falls back to matching by name rather than writing
// a value into whatever row happens to sit at that index now.
async function jccTrackerEdit(app, sourcePath, rowIndex, keyValue, colName, newValue) {
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!file) { new Notice('Tracker note not found: ' + sourcePath); return false; }
    const schema = (JCC_TRACKER_CACHE.get(sourcePath) || {}).schema || null;
    let ok = false, why = 'table not found';
    await app.vault.process(file, (data) => {
        const t = jccFindTrackerTable(data, schema);
        if (!t) return data;
        const col = t.header.findIndex(h => h.toLowerCase() === String(colName).toLowerCase());
        if (col < 0) { why = 'column not found: ' + colName; return data; }
        const keyCol = schema && schema.key
            ? t.header.findIndex(h => h.toLowerCase() === schema.key.toLowerCase()) : 0;
        let row = -1;
        if (rowIndex >= 0 && rowIndex < t.rows.length &&
            jccCellText(t.rows[rowIndex][keyCol]) === keyValue) {
            row = rowIndex;
        } else {
            row = t.rows.findIndex(r => jccCellText(r[keyCol]) === keyValue);
        }
        if (row < 0) { why = 'row not found: ' + keyValue; return data; }
        while (t.rows[row].length < t.header.length) t.rows[row].push('');
        t.rows[row][col] = String(newValue).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
        ok = true;
        const lines = data.split('\n');
        lines.splice(t.start, t.end - t.start, ...jccRenderTable(t).split('\n'));
        return lines.join('\n');
    });
    if (!ok) new Notice('Could not update the tracker — ' + why);
    return ok;
}

async function jccTrackerAddRow(app, sourcePath, keyValue) {
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!file) return false;
    const schema = (JCC_TRACKER_CACHE.get(sourcePath) || {}).schema || null;
    let ok = false;
    await app.vault.process(file, (data) => {
        const t = jccFindTrackerTable(data, schema);
        if (!t) return data;
        const keyCol = schema && schema.key
            ? Math.max(0, t.header.findIndex(h => h.toLowerCase() === schema.key.toLowerCase())) : 0;
        const row = t.header.map(() => '');
        row[keyCol] = keyValue.replace(/\|/g, '\\|').trim();
        // Seed every enum column with its first listed value, the way a new
        // spreadsheet row starts at the top of its validation list.
        if (schema) {
            t.header.forEach((h, i) => {
                const f = schema.cols.get(h.toLowerCase());
                if (f && f.kind === 'enum' && f.values.length) row[i] = f.values[0];
            });
        }
        t.rows.push(row);
        ok = true;
        const lines = data.split('\n');
        lines.splice(t.start, t.end - t.start, ...jccRenderTable(t).split('\n'));
        return lines.join('\n');
    });
    return ok;
}

// ── Schema + table cache ─────────────────────────────────────────────────────

async function jccTrackerLoad(app, sourcePath) {
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!file) return null;
    const mtime = file.stat ? file.stat.mtime : 0;
    const hit = JCC_TRACKER_CACHE.get(sourcePath);
    if (hit && hit.mtime === mtime) return hit;
    const text = await app.vault.cachedRead(file);
    const m = text.match(/```jcc-tracker\n([\s\S]*?)```/);
    if (!m) { JCC_TRACKER_CACHE.delete(sourcePath); return null; }
    const schema = jccParseTrackerFence(m[1]);
    const table = jccFindTrackerTable(text, schema);
    const entry = { mtime, schema, table };
    JCC_TRACKER_CACHE.set(sourcePath, entry);
    return entry;
}

function jccSlug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Summary + filter bar (the ```jcc-tracker block, rendered) ────────────────

async function jccRenderTrackerBar(app, src, el, sourcePath) {
    const schema = jccParseTrackerFence(src);
    const entry = await jccTrackerLoad(app, sourcePath);
    const table = entry ? entry.table : null;
    const bar = el.createDiv('jcc-tracker-bar');

    const head = bar.createDiv('jcc-tracker-bar-head');
    head.createSpan({ cls: 'jcc-tracker-title', text: schema.title || 'Tracker' });
    const total = table ? table.rows.length : 0;
    head.createSpan({ cls: 'jcc-tracker-total', text: `${total} ${total === 1 ? 'row' : 'rows'}` });

    const add = head.createEl('button', { cls: 'jcc-tracker-add', text: '+ Add' });
    add.setAttr('aria-label', `Add a ${schema.key || 'row'}`);
    add.onclick = (ev) => {
        ev.stopPropagation();
        new InputModal(app, `Add to ${schema.title || 'tracker'}`,
            schema.key || 'Name', async (v) => {
                await jccTrackerAddRow(app, sourcePath, v);
            }).open();
    };

    // Chips tally the `counts:` column, replacing the hand-maintained "22
    // people · 6 met · …" line that went stale on every edit. Clicking one
    // filters the table to that value — the spreadsheet's autofilter.
    const countsCol = schema.counts;
    if (!countsCol || !table) return;
    const idx = table.header.findIndex(h => h.toLowerCase() === countsCol.toLowerCase());
    if (idx < 0) return;
    const field = schema.cols.get(countsCol.toLowerCase());
    const tally = new Map();
    for (const v of (field && field.kind === 'enum' ? field.values : [])) tally.set(v, 0);
    for (const r of table.rows) {
        const v = jccCellText(r[idx]) || '—';
        tally.set(v, (tally.get(v) || 0) + 1);
    }

    const chips = bar.createDiv('jcc-tracker-chips');
    const mk = (label, count, value) => {
        const c = chips.createEl('button', { cls: 'jcc-tracker-chip' });
        if (value !== null) c.setAttr('data-jcc-chip', jccSlug(value));
        c.createSpan({ cls: 'jcc-chip-label', text: label });
        c.createSpan({ cls: 'jcc-chip-count', text: String(count) });
        c.onclick = (ev) => {
            ev.stopPropagation();
            jccTrackerFilter(el, chips, c, idx, value);
        };
        return c;
    };
    const all = mk('All', total, null);
    all.addClass('is-active');
    for (const [v, n] of tally) mk(v, n, v);
}

// Filter by hiding rows in the rendered table. Deliberately DOM-only: a filter
// is a way of looking at the note, not a change to it, and writing filter state
// into the file would put a diff in git every time the view was narrowed.
function jccTrackerFilter(blockEl, chips, chip, colIdx, value) {
    const scope = blockEl.closest('.markdown-preview-view, .markdown-rendered') || blockEl.parentElement;
    const table = scope ? scope.querySelector('table.jcc-tracker-table') : null;
    const already = chip.hasClass('is-active') && value !== null;
    chips.querySelectorAll('.jcc-tracker-chip').forEach(c => c.removeClass('is-active'));
    const active = already ? null : value;
    (already || value === null ? chips.firstElementChild : chip).addClass('is-active');
    if (!table) return;
    table.querySelectorAll('tbody tr').forEach(tr => {
        const cell = tr.children[colIdx];
        const txt = cell ? cell.textContent.trim() : '';
        tr.toggleClass('jcc-row-filtered', active !== null && txt !== active);
    });
}

// ── Decorating the rendered table ────────────────────────────────────────────

async function jccDecorateTrackerTables(app, el, sourcePath) {
    // Obsidian hands the post-processor a section container, but for a
    // single-element section that container can BE the table — querySelectorAll
    // alone would miss it and the tracker would silently render inert.
    const tables = Array.from(el.querySelectorAll('table'));
    if (el.matches && el.matches('table')) tables.unshift(el);
    if (!tables.length) return;
    // GATE ON FRONTMATTER BEFORE READING THE FILE. This post-processor runs for
    // every rendered section in the vault, and jccTrackerLoad reads the note off
    // disk to find its fence — without this check, scrolling any note with a
    // table in it would queue a read per section. The cache only helps after the
    // first one, and the first one is the cost that matters.
    const fmFile = app.vault.getAbstractFileByPath(sourcePath);
    const fm = fmFile ? (app.metadataCache.getFileCache(fmFile) || {}).frontmatter : null;
    if (!fm || fm['jcc-tracker'] !== true) return;
    const entry = await jccTrackerLoad(app, sourcePath);
    if (!entry) return;
    const schema = entry.schema;
    const keyName = (schema.key || '').toLowerCase();
    for (const table of tables) {
        const heads = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
        if (!heads.length) continue;
        if (keyName && !heads.some(h => h.toLowerCase() === keyName)) continue;
        table.addClass('jcc-tracker-table');
        table.setAttr('data-jcc-tracker-src', sourcePath);
        heads.forEach((h, i) => {
            const f = schema.cols.get(h.toLowerCase());
            const th = table.querySelectorAll('thead th')[i];
            if (th && f) th.setAttr('data-jcc-kind', f.kind);
        });
        Array.from(table.querySelectorAll('tbody tr')).forEach((tr, rowIdx) => {
            tr.setAttr('data-jcc-row', String(rowIdx));
            Array.from(tr.children).forEach((td, i) => {
                const h = heads[i] || '';
                td.setAttr('data-jcc-col', h);
                const f = schema.cols.get(h.toLowerCase());
                if (!f) { td.addClass('jcc-cell-text'); return; }
                td.setAttr('data-jcc-kind', f.kind);
                if (f.kind === 'enum') {
                    const v = td.textContent.trim();
                    if (v) {
                        // Wrap, don't restyle the cell: the chip has to be the
                        // width of its text, and a coloured full-width cell
                        // reads as a heat map of the column rather than a value.
                        td.empty();
                        const chip = td.createSpan({ cls: 'jcc-cell-chip', text: v });
                        chip.setAttr('data-jcc-chip', jccSlug(v));
                    }
                }
            });
        });
    }
}

// ── The dropdown ─────────────────────────────────────────────────────────────

function jccTrackerCellMenu(app, menu, ctx, field, current) {
    const commit = (v) => jccTrackerEdit(app, ctx.src, ctx.row, ctx.key, field.name, v);
    if (field.kind === 'enum') {
        for (const v of field.values) {
            menu.addItem(it => it.setTitle(v)
                .setChecked(v === current)
                .onClick(() => commit(v)));
        }
        menu.addSeparator();
        menu.addItem(it => it.setTitle('Clear').setIcon('eraser').onClick(() => commit('')));
    } else if (field.kind === 'toggle') {
        const on = !!current;
        menu.addItem(it => it.setTitle(on ? `Remove ${field.mark}` : `Mark ${field.mark}`)
            .setIcon(on ? 'x' : 'check')
            .onClick(() => commit(on ? '' : field.mark)));
    } else if (field.kind === 'date') {
        const d = (off) => {
            const t = new Date();
            t.setDate(t.getDate() + off);
            return t.toISOString().slice(0, 10);
        };
        menu.addItem(it => it.setTitle('Today · ' + d(0)).setIcon('calendar').onClick(() => commit(d(0))));
        menu.addItem(it => it.setTitle('Tomorrow · ' + d(1)).setIcon('calendar').onClick(() => commit(d(1))));
        menu.addItem(it => it.setTitle('Next week · ' + d(7)).setIcon('calendar').onClick(() => commit(d(7))));
        menu.addItem(it => it.setTitle('Pick a date…').setIcon('calendar-plus').onClick(() => {
            new InputModal(app, `${field.name} — ${ctx.key}`, 'YYYY-MM-DD', v => commit(v)).open();
        }));
        menu.addSeparator();
        menu.addItem(it => it.setTitle('Clear').setIcon('eraser').onClick(() => commit('')));
    } else {
        menu.addItem(it => it.setTitle(current ? 'Edit…' : 'Add…').setIcon('pencil').onClick(() => {
            new TextareaModal(app, `${field.name} — ${ctx.key}`, field.name, 'Save',
                v => commit(v), current).open();
        }));
        if (current) {
            menu.addItem(it => it.setTitle('Clear').setIcon('eraser').onClick(() => commit('')));
        }
    }
}

// Clicking the key cell opens the WHOLE ROW: every field as a submenu, so one
// gesture reaches any value on that person without hunting for the right
// column. This is the interaction the user asked for by name ("click the row
// and get a dropdown"); the per-cell menu is the shortcut, not the main path.
function jccTrackerRowMenu(app, menu, ctx, schema, values) {
    menu.addItem(it => it.setTitle(ctx.key).setIcon('user').setDisabled(true));
    menu.addSeparator();
    let any = false;
    for (const name of schema.order) {
        const field = schema.cols.get(name.toLowerCase());
        if (!field || name.toLowerCase() === (schema.key || '').toLowerCase()) continue;
        const current = values.get(name) || '';
        const label = current ? `${name}: ${current}` : name;
        any = true;
        menu.addItem(it => {
            it.setTitle(label);
            // setSubmenu is 1.4+. Where it is missing the item still has to do
            // something useful, so it opens that one field's menu at the mouse
            // instead of being an inert row.
            if (typeof it.setSubmenu === 'function') {
                jccTrackerCellMenu(app, it.setSubmenu(), ctx, field, current);
            } else {
                it.onClick((ev) => {
                    const sub = new Menu();
                    jccTrackerCellMenu(app, sub, ctx, field, current);
                    // A menu item can also be activated from the keyboard, and
                    // showAtMouseEvent on a KeyboardEvent positions at 0,0.
                    if (ev && typeof ev.clientX === 'number') sub.showAtMouseEvent(ev);
                    else sub.showAtPosition({ x: 200, y: 200 });
                });
            }
        });
    }
    if (!any) menu.addItem(it => it.setTitle('No editable columns declared').setDisabled(true));
}

// ── Protocol PDF export ──────────────────────────────────────────────────────
//
// WHAT THIS REPLACES. Obsidian's own File → Export to PDF prints the *theme*:
// the reading view as it sits on screen, sidebars' typography and all, sized
// for a monitor. It is fine as a personal print-out and wrong as a document you
// hand a collaborator — no version stamp, no page numbers, wikilinks rendered
// as live-looking blue links that go nowhere in a PDF, and callouts that carry
// whichever colours the current theme happened to have.
//
// So this renders the note through Obsidian (which is what gets callouts,
// tables, mermaid and embeds right) and then throws the theme away, styling the
// result as a standalone SOP: a title block carrying the protocol's version and
// last-updated date, a footer that stamps name + version + page N of M on every
// page, and print-safe typography.
//
// HOW IT PRINTS. Obsidian is Electron, so a hidden BrowserWindow loading the
// generated HTML and calling webContents.printToPDF gives real Chromium
// pagination — widows/orphans, break-inside on tables and callouts, and the
// header/footer templates. No pandoc, no wkhtmltopdf, nothing to install.

const JCC_PDF_PAGE = { width: 8.5, height: 11 };   // Letter, inches

// The document design. Deliberately NOT derived from the Obsidian theme: a
// shared PDF has to look the same whichever theme the vault happened to be in.
//
// Type pairing: a warm serif for the title and section heads, a clean sans for
// everything read at the bench. Steps and tables are scanned, not read, so they
// get the sans; the headings carry the "this is a document" weight.
//
// Colour is the lab palette's indigo (#330099) as the single structural accent,
// with the callout hues taken from the same palette so a printed protocol and a
// printed figure look related. Nothing here is a data encoding, so this does not
// collide with the reserved-for-reagent-identity rule.
const JCC_PDF_CSS = `
:root {
  --ink: #16181D;
  --ink-soft: #454A57;
  --ink-faint: #858B99;
  --rule: #DFE2E8;
  --rule-soft: #EDEFF3;
  --accent: #330099;
  --accent-tint: #F2EFFC;
  --pink: #F72585;
  --serif: "Iowan Old Style", Charter, Palatino, Georgia, serif;
  --sans: "Avenir Next", "Helvetica Neue", -apple-system, Helvetica, Arial, sans-serif;
  --mono: "SF Mono", Menlo, "Roboto Mono", monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--sans);
  font-size: 10.2pt;
  line-height: 1.55;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}
p { margin: 0.5em 0; orphans: 3; widows: 3; }

/* ── Title block ─────────────────────────────────────────────────────────── */
.jcc-doc-head { margin-bottom: 22px; }
.jcc-eyebrow {
  font-size: 7.5pt; font-weight: 700; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--accent);
}
.jcc-doc-head h1 {
  font-family: var(--serif);
  font-size: 25pt; line-height: 1.15; font-weight: 600;
  margin: 6px 0 0 0; color: var(--ink); letter-spacing: -0.01em;
  /* Balance the lines and forbid hyphen breaks. Protocol names are full of
     hyphenated compounds ("Low-Copy"), and Chromium will happily break at one,
     leaving a title that reads as a broken word. */
  text-wrap: balance; hyphens: manual;
}
/* Long names would otherwise run to three lines and crowd the metadata. */
.jcc-doc-head h1.jcc-title-long { font-size: 21pt; }
.jcc-doc-head h1.jcc-title-xlong { font-size: 18pt; line-height: 1.2; }
.jcc-doc-rule { height: 2.5px; background: var(--accent); margin: 12px 0 0 0; }
.jcc-meta {
  display: flex; flex-wrap: wrap; gap: 0 30px;
  margin-top: 11px; padding-bottom: 2px;
}
.jcc-meta div { margin-bottom: 6px; }
.jcc-meta dt {
  font-size: 7pt; font-weight: 700; letter-spacing: 0.11em;
  text-transform: uppercase; color: var(--ink-faint); margin: 0 0 1px 0;
}
.jcc-meta dd { margin: 0; font-size: 9.5pt; color: var(--ink); font-weight: 600; }
.jcc-meta dd.jcc-meta-long { font-weight: 400; color: var(--ink-soft); max-width: 118mm; }
.jcc-tagrow { margin-top: 4px; }
.jcc-tag {
  display: inline-block; font-size: 7.5pt; font-weight: 600;
  letter-spacing: 0.03em; color: var(--accent);
  background: var(--accent-tint); border-radius: 999px;
  padding: 2px 8px; margin: 0 4px 4px 0;
}

/* ── Headings ────────────────────────────────────────────────────────────── */
h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }
.jcc-doc-body h1 { font-family: var(--serif); font-size: 18pt; margin: 26px 0 8px; font-weight: 600; }
.jcc-doc-body h2 {
  font-family: var(--serif); font-size: 15pt; font-weight: 600;
  margin: 26px 0 9px; padding-top: 9px;
  border-top: 1px solid var(--rule); color: var(--ink);
}
.jcc-doc-body h3 {
  font-size: 10.5pt; font-weight: 700; letter-spacing: 0.02em;
  margin: 18px 0 5px; color: var(--accent);
}
.jcc-doc-body h4 {
  font-size: 9.5pt; font-weight: 700; letter-spacing: 0.05em;
  text-transform: uppercase; margin: 14px 0 4px; color: var(--ink-soft);
}
/* A section head that lands at the foot of a page takes its first block with
   it — Chromium's break-after:avoid only reaches the immediately next box. */
.jcc-doc-body h2 + *, .jcc-doc-body h3 + * { break-before: avoid; }

/* ── Lists ───────────────────────────────────────────────────────────────── */
ul, ol { margin: 0.45em 0; padding-left: 1.3em; }
li { margin: 0.22em 0; }
li::marker { color: var(--ink-faint); }
ol > li::marker { color: var(--accent); font-weight: 700; }

/* Task lists print as boxes to tick at the bench, not as web checkboxes. */
/* Hanging indent, so a checklist item that wraps lines up under its own text
   rather than sliding back under the box. */
li.task-list-item {
  list-style: none;
  margin-left: -1.15em; padding-left: 1.15em; text-indent: -1.15em;
}
li.task-list-item > * { text-indent: 0; }
input[type="checkbox"] {
  -webkit-appearance: none; appearance: none;
  width: 9.5px; height: 9.5px; margin: 0 7px 0 0;
  border: 1.3px solid var(--ink-faint); border-radius: 2px;
  vertical-align: 1px; background: #fff;
}
input[type="checkbox"]:checked {
  background: var(--accent); border-color: var(--accent);
}

/* ── Tables ──────────────────────────────────────────────────────────────── */
table {
  width: 100%; border-collapse: collapse;
  margin: 12px 0; font-size: 9pt; line-height: 1.42;
}
thead { display: table-header-group; }   /* repeat the head on every page */
th {
  text-align: left; font-size: 7.5pt; font-weight: 700;
  letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--accent); background: var(--accent-tint);
  border-bottom: 1.5px solid var(--accent);
  padding: 6px 9px; vertical-align: bottom;
}
td {
  padding: 6px 9px; vertical-align: top;
  border-bottom: 1px solid var(--rule-soft);
}
tr { break-inside: avoid; }
tbody tr:last-child td { border-bottom: 1px solid var(--rule); }
td strong { font-weight: 700; }
td.jcc-nowrap, th.jcc-nowrap { white-space: nowrap; }

/* ── Callouts ────────────────────────────────────────────────────────────── */
.callout {
  --co: var(--accent);
  break-inside: avoid;
  margin: 13px 0; padding: 9px 13px 10px;
  border: 1px solid var(--rule);
  border-left: 3.5px solid var(--co);
  border-radius: 4px;
  background: color-mix(in srgb, var(--co) 4.5%, #fff);
  font-size: 9.6pt;
}
.callout-title {
  display: flex; align-items: center; gap: 6px;
  font-weight: 700; font-size: 9pt; color: var(--co);
  letter-spacing: 0.015em;
}
.callout-title-inner { font-weight: 700; }
.callout-icon { display: inline-flex; }
.callout-icon svg { width: 12px; height: 12px; stroke: var(--co); }
.callout-content { margin-top: 4px; }
.callout-content > :first-child { margin-top: 0; }
.callout-content > :last-child { margin-bottom: 0; }
.callout-content p { margin: 0.35em 0; }
/* Hues from the lab palette so a printed protocol and a printed figure read as
   one family. Severity climbs pink→rose; neutral information stays indigo. */
.callout[data-callout="warning"], .callout[data-callout="caution"],
.callout[data-callout="attention"]                     { --co: #CC0055; }
.callout[data-callout="danger"], .callout[data-callout="error"],
.callout[data-callout="bug"], .callout[data-callout="failure"],
.callout[data-callout="missing"], .callout[data-callout="fail"] { --co: #A3003F; }
.callout[data-callout="tip"], .callout[data-callout="hint"],
.callout[data-callout="important"]                     { --co: #00AAAA; }
.callout[data-callout="success"], .callout[data-callout="check"],
.callout[data-callout="done"]                          { --co: #00857F; }
.callout[data-callout="example"]                       { --co: #9900CC; }
.callout[data-callout="question"], .callout[data-callout="help"],
.callout[data-callout="faq"]                           { --co: #0066FF; }
.callout[data-callout="quote"], .callout[data-callout="cite"],
.callout[data-callout="abstract"], .callout[data-callout="summary"],
.callout[data-callout="tldr"]                          { --co: #6A7080; }

/* ── Code, quotes, rules, media ──────────────────────────────────────────── */
code {
  font-family: var(--mono); font-size: 0.88em;
  background: #F4F5F8; border: 1px solid var(--rule-soft);
  border-radius: 3px; padding: 0.5px 4px;
}
pre {
  font-family: var(--mono); font-size: 8.6pt; line-height: 1.45;
  background: #F7F8FA; border: 1px solid var(--rule);
  border-radius: 5px; padding: 10px 12px;
  overflow-wrap: anywhere; white-space: pre-wrap;
  break-inside: avoid;
}
pre code { background: none; border: 0; padding: 0; font-size: inherit; }
blockquote {
  margin: 12px 0; padding: 2px 0 2px 14px;
  border-left: 2.5px solid var(--rule);
  color: var(--ink-soft); font-style: italic;
}
hr { border: 0; border-top: 1px solid var(--rule); margin: 20px 0; }
/* A protocol separates its sections with a thematic break AND a heading, and h2
   draws its own rule — together they print as two hairlines a few millimetres
   apart. Whichever comes second yields. */
.jcc-doc-body hr + h2, .jcc-doc-body hr + h3 {
  border-top: 0; padding-top: 0; margin-top: 15px;
}
/* Likewise a rule immediately under a table, whose last row already has one. */
table + hr { margin-top: 8px; }
img, svg { max-width: 100%; height: auto; }
.jcc-doc-body img { border-radius: 4px; break-inside: avoid; display: block; margin: 12px auto; }
.mermaid { text-align: center; margin: 14px 0; break-inside: avoid; }
/* Bounded on BOTH axes. A diagram taller than the page would otherwise be split
   across a page break mid-flow, cutting arrows in half; capping the height makes
   it scale down to fit and, with break-inside:avoid, take its own page. */
.mermaid svg {
  max-width: 100%; max-height: 8.3in;
  width: auto; height: auto;
}

/* A WIDE DIAGRAM GETS A ROTATED PAGE OF ITS OWN.
   A left-to-right flowchart is often 4x wider than tall. Fitted to a 6.9in text
   column its labels render around 5pt — present in the PDF and unreadable on
   paper, which is the failure mode this whole export exists to avoid. Turning it
   a quarter turn onto its own page is the standard print answer: the diagram
   gets the page's 9in dimension instead of its 6.9in one, and the type comes
   back up to size. */
.jcc-wide-figure {
  break-before: page; break-after: page; break-inside: avoid;
  height: 8.9in; margin: 0;
  display: flex; align-items: center; justify-content: center;
}
.jcc-wide-inner {
  width: 8.9in;                 /* after the rotation this is the VERTICAL extent */
  flex: 0 0 auto;               /* a flex item would otherwise shrink back to the column */
  transform: rotate(90deg);
  transform-origin: center center;
}
.jcc-wide-inner svg,
.jcc-wide-inner .mermaid { max-width: none !important; width: 100%; height: auto; }
.jcc-wide-inner .mermaid { margin: 0; }

/* A wikilink is dead in a PDF. Keep the phrase readable and mark it as a
   cross-reference rather than dressing it up as something clickable. */
a.internal-link, a.tag {
  color: var(--ink); text-decoration: none;
  border-bottom: 0.8px dotted var(--ink-faint);
}
a.external-link, a[href^="http"] {
  color: var(--accent); text-decoration: none;
  border-bottom: 0.8px solid color-mix(in srgb, var(--accent) 35%, #fff);
}

/* ── jcc-matrix ──────────────────────────────────────────────────────────
   Reports carry result matrices, and their whole point is the ink ramp: the
   shade of a cell IS the magnitude. Unported, the generic table rules above
   claimed the block and printed it as an ordinary table — the row labels came
   out as uppercase column heads and every shade was lost, because the ramp is
   driven by --mono-rgb-100, an Obsidian theme variable that does not exist in
   the print window. Defining that variable and restating the block's own rules
   restores the encoding. No hue, matching the on-screen block: neutral ink is
   also the only ramp that survives a greyscale printer. */
.jcc-doc-body { --mono-rgb-100: 0, 0, 0; }
.jcc-matrix { margin: 13px 0; break-inside: avoid; }
.jcc-matrix-title {
  font-size: 9pt; font-weight: 700; color: var(--ink);
  margin-bottom: 5px;
}
.jcc-matrix-table {
  border-collapse: separate; border-spacing: 3px;
  width: 100%; font-size: 8.8pt; font-variant-numeric: tabular-nums;
}
.jcc-doc-body .jcc-matrix-table thead th {
  font-size: 7.5pt; font-weight: 700; letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--ink-faint);
  text-align: center; padding: 2px 6px;
  background: none; border: none;
}
.jcc-matrix-corner { width: 1%; }
.jcc-doc-body .jcc-matrix-table th.jcc-matrix-rowlab {
  text-align: left; font-weight: 700; font-size: 8.8pt;
  letter-spacing: 0; text-transform: none; color: var(--ink);
  white-space: nowrap; padding: 3px 9px 3px 1px;
  background: none; border: none;
}
.jcc-doc-body .jcc-matrix-table td {
  text-align: center; padding: 4px 8px;
  border: none; border-radius: 4px; white-space: nowrap;
}
.jcc-doc-body .jcc-matrix-table td.jcc-matrix-cell {
  background: rgba(var(--mono-rgb-100), var(--jcc-ink, 0));
}
.jcc-matrix-glyph { font-size: 0.78em; opacity: 0.55; margin-right: 0.34em; vertical-align: 0.06em; }
.jcc-matrix-val { font-weight: 700; }
.jcc-matrix-plain { color: var(--ink-soft); font-style: italic; font-weight: 400; }

/* Set on any block measured taller than half a page — see
   jccPdfAllowLongBlocksToBreak. A long abstract splits across pages instead of
   leaving the page before it blank. */
.jcc-may-break { break-inside: auto !important; }

/* Obsidian chrome that must not reach the page. */
.frontmatter, .frontmatter-container, .metadata-container,
.collapse-indicator, .edit-block-button, .copy-code-button,
.heading-collapse-indicator, .markdown-preview-pusher, .mod-header, .mod-footer,
.internal-embed > .markdown-embed-link, .embed-title { display: none !important; }
.internal-embed, .markdown-embed { border: 0; padding: 0; margin: 0; }
.markdown-embed-content > .markdown-preview-view { padding: 0; }
`;

function jccPdfEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Slugify for a filename a collaborator will see in their downloads folder.
function jccPdfFileName(title, version) {
    const base = String(title || 'protocol')
        .replace(/[—–]/g, '-')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return version ? `${base}_v${String(version).replace(/[^0-9.]/g, '')}.pdf` : `${base}.pdf`;
}

function jccPdfPrettyDate(v) {
    if (!v) return '';
    const d = new Date(String(v).slice(0, 10) + 'T12:00:00');
    if (isNaN(d)) return String(v);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// The line above the title, naming what kind of document this is.
//
// Frontmatter `type` first, because that is what the vault already uses to
// classify a note; the folder is the fallback for notes that predate it.
const JCC_PDF_EYEBROWS = {
    'protocol': 'Protocol',
    'proposal': 'Proposal',
    'experiment-report': 'Experiment Report',
    'analysis-report': 'Analysis Report',
    'day-report': 'Day Report',
    'methods': 'Methods',
    'lab-meeting': 'Lab Meeting',
    'lab-meeting-prep': 'Lab Meeting',
    'journal-club': 'Journal Club',
    'poster': 'Poster',
    'conference': 'Conference',
    'finding': 'Finding',
    'model': 'Working Model',
};

function jccPdfEyebrow(file, fm) {
    const t = fm && fm.type ? String(fm.type).toLowerCase() : '';
    if (JCC_PDF_EYEBROWS[t]) return JCC_PDF_EYEBROWS[t];
    const p = file.path;
    if (p.startsWith('protocols/')) return 'Protocol';
    if (p.startsWith('proposals/')) return 'Proposal';
    if (p.startsWith('presentations/')) return 'Presentation';
    if (p.startsWith('meetings/')) return 'Meeting Notes';
    if (p.startsWith('rotations/')) return 'Rotation';
    if (/\/reports\//.test(p)) return 'Report';
    if (p.startsWith('experiments/')) return 'Experiment';
    if (p.startsWith('literature/')) return 'Literature';
    return 'Lab Notebook';
}

// Frontmatter keys that are vault plumbing, not document metadata.
const JCC_PDF_SKIP_FM = new Set([
    'tags', 'aliases', 'cssclass', 'cssclasses', 'title', 'jcc-tracker',
    'obsidianuimode', 'type', 'publish', 'permalink', 'position',
]);

// Build the title block. The version and last-updated date are the whole point
// of stamping a protocol PDF — a collaborator holding a printout has to be able
// to tell whether it is the revision being discussed.
function jccPdfHeadHtml(title, fm, eyebrow) {
    const rows = [];
    const push = (label, value, long) => {
        if (value === undefined || value === null || value === '') return;
        rows.push(`<div><dt>${jccPdfEsc(label)}</dt>` +
                  `<dd${long ? ' class="jcc-meta-long"' : ''}>${jccPdfEsc(value)}</dd></div>`);
    };
    push('Version', fm.version !== undefined ? 'v' + fm.version : '');
    push('Last updated', jccPdfPrettyDate(fm['last-updated'] || fm.updated));
    // Anything else the author put in frontmatter, in their own order, so a
    // protocol that tracks `kit` or `instrument` does not lose it.
    for (const [k, v] of Object.entries(fm || {})) {
        const key = k.toLowerCase();
        if (JCC_PDF_SKIP_FM.has(key)) continue;
        if (key === 'version' || key === 'last-updated' || key === 'updated') continue;
        if (v === null || typeof v === 'object') continue;
        const label = k.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
        push(label, v, String(v).length > 40);
    }
    const tags = []
        .concat(fm && fm.tags ? fm.tags : [])
        .filter(t => typeof t === 'string' && t.toLowerCase() !== 'protocol');
    const tagHtml = tags.length
        ? `<div class="jcc-tagrow">${tags.map(t => `<span class="jcc-tag">${jccPdfEsc(t)}</span>`).join('')}</div>`
        : '';
    const sizeCls = title.length > 62 ? ' class="jcc-title-xlong"'
                  : title.length > 42 ? ' class="jcc-title-long"' : '';
    return `<header class="jcc-doc-head">
  <div class="jcc-eyebrow">${jccPdfEsc(eyebrow)}</div>
  <h1${sizeCls}>${jccPdfEsc(title)}</h1>
  <div class="jcc-doc-rule"></div>
  <dl class="jcc-meta">${rows.join('')}</dl>
  ${tagHtml}
</header>`;
}

// Turn every vault image into a data: URI.
//
// The PDF is rendered in a separate BrowserWindow that has no idea what an
// app:// URL is, so an un-inlined figure comes out as a broken-image box. Doing
// it here rather than at print time also makes the generated HTML a single
// self-contained file, which is what makes "save the HTML instead" work.
async function jccPdfInlineImages(app, root) {
    const imgs = Array.from(root.querySelectorAll('img'));
    for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;
        if (/^https?:/i.test(src)) continue;          // remote, leave it
        let file = null;
        try { file = jccResolveImageFile(app, img); } catch (e) { file = null; }
        if (!file) { img.remove(); continue; }
        try {
            const buf = await app.vault.readBinary(file);
            const ext = (file.extension || 'png').toLowerCase();
            const mime = ext === 'svg' ? 'image/svg+xml'
                       : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                       : ext === 'gif' ? 'image/gif'
                       : ext === 'webp' ? 'image/webp' : 'image/png';
            let bin = '';
            const bytes = new Uint8Array(buf);
            const CHUNK = 0x8000;                     // btoa blows the stack on a big spread
            for (let i = 0; i < bytes.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            img.setAttribute('src', `data:${mime};base64,${btoa(bin)}`);
            img.removeAttribute('srcset');
        } catch (e) {
            img.remove();
        }
    }
}

// Mermaid renders asynchronously, so the HTML is snapshotted before the diagram
// exists unless we wait for the <svg> to land. Bounded, because a malformed
// diagram never resolves and a hung export is worse than a missing figure.
async function jccPdfWaitForMermaid(root, timeoutMs) {
    const blocks = () => Array.from(root.querySelectorAll('.mermaid, .block-language-mermaid'));
    if (!blocks().length) return;
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
        const all = blocks();
        if (all.length && all.every(b => b.querySelector('svg'))) return;
        await new Promise(r => window.setTimeout(r, 120));
    }
}

// Let a block that cannot fit on a page stop trying to.
//
// `break-inside: avoid` is right for a warning box and wrong for a page-long
// abstract: Chromium first tries to move the block whole, and when it is taller
// than a page it moves it anyway and then breaks it — so the report opened with
// an almost entirely blank page 1 and the abstract starting on page 2. Height is
// only knowable after layout, so this is decided here rather than in CSS.
//
// The threshold is measured in STAGE pixels and the stage is wider than the
// printed column, so a block reflows taller in the PDF than it measures here.
// The ratio is applied rather than guessed at.
const JCC_PDF_STAGE_W = 800;                       // the offscreen stage, px
const JCC_PDF_COL_W = 6.9 * 96;                    // printed text column, px
const JCC_PDF_PAGE_H = 9.0 * 96;                   // printed text height, px

function jccPdfAllowLongBlocksToBreak(root) {
    const reflow = JCC_PDF_STAGE_W / JCC_PDF_COL_W;         // >1: prints taller
    // Half a page: below this a block is worth keeping whole even if it forces
    // a little white space; above it, moving the block costs more than it saves.
    const limit = (0.5 * JCC_PDF_PAGE_H) / reflow;
    root.querySelectorAll('.callout, pre, .jcc-matrix, table').forEach(el => {
        let h = 0;
        try { h = el.getBoundingClientRect().height; } catch (e) { return; }
        if (h > limit) el.addClass('jcc-may-break');
    });
}

// Drop in-document links whose target is not in the document.
//
// A report opens with its own contents list, and stripping the figure-annotations
// section leaves an entry in that list pointing at a heading that is no longer
// there. Runs over every same-note anchor rather than just that one, so a link to
// any heading that has since been renamed also stops printing as a live-looking
// cross-reference to nothing.
function jccPdfPruneDeadAnchors(root) {
    const headings = new Set();
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => headings.add(h.textContent.trim()));
    root.querySelectorAll('a[href^="#"]').forEach(a => {
        let target = a.getAttribute('href').slice(1);
        try { target = decodeURIComponent(target); } catch (e) { /* keep raw */ }
        if (headings.has(target.trim())) return;
        const li = a.closest('li');
        // Only remove the whole bullet when the link IS the bullet; otherwise a
        // sentence that merely mentions the section would vanish with it.
        if (li && li.textContent.trim() === a.textContent.trim()) li.remove();
        else a.replaceWith(document.createTextNode(a.textContent));
    });
    // A contents list emptied of every entry should not print as a stray bullet.
    root.querySelectorAll('ul, ol').forEach(list => {
        if (!list.querySelector('li')) list.remove();
    });
}

// Managed regions that are working state, not document content.
//
// The figure-annotations block is a private to-do list pinned on the figures —
// "i like how ... can we follow this convention here too", struck through once
// done. It belongs in the vault and not in a PDF going to a collaborator, and
// it is unambiguously identifiable because the plugin writes its own markers.
// Anything else stays: colony counts and the like are data.
const JCC_PDF_STRIP_REGIONS = ['figure-annotations'];

function jccPdfStripManagedRegions(md) {
    let out = md;
    for (const name of JCC_PDF_STRIP_REGIONS) {
        const re = new RegExp('<!--\\s*' + name + ':start\\s*-->[\\s\\S]*?<!--\\s*' + name + ':end\\s*-->\\n?', 'g');
        out = out.replace(re, '');
    }
    return out;
}

// Obsidian's standalone renderer breaks every soft newline.
//
// MarkdownRenderer.render emits <br> for a single newline no matter what the
// vault's "Strict line breaks" setting says — verified: the setting is off here
// and an 822-<br> document came out anyway. These notes are hard-wrapped near
// 100 characters for editing, so the PDF printed one ragged short line per
// source line and the D8 report ran to 120 pages. Reading view joins them; the
// PDF has to agree with what the author sees.
//
// A markdown HARD break is also a <br> and must survive. It is only
// distinguishable in the SOURCE — two trailing spaces, or a trailing backslash
// — so it is tagged there and honoured after rendering. Fenced code is left
// alone: trailing spaces inside a code block are content.
function jccPdfTagHardBreaks(md) {
    const out = [];
    let fence = null;
    for (const line of md.split('\n')) {
        const f = line.match(/^\s*(```+|~~~+)/);
        if (f) {
            if (!fence) fence = f[1][0];
            else if (line.trim().startsWith(fence)) fence = null;
            out.push(line);
            continue;
        }
        if (fence) { out.push(line); continue; }
        out.push(line.replace(/(\S)(?:[ \t]{2,}|\\)$/, '$1<br class="jcc-hard">'));
    }
    return out.join('\n');
}

// Drop the soft-wrap breaks, keep the tagged ones.
function jccPdfJoinSoftBreaks(root) {
    root.querySelectorAll('br').forEach(br => {
        if (br.closest('pre, code')) return;            // literal content
        if (br.classList.contains('jcc-hard')) { br.removeClass('jcc-hard'); return; }
        // A space, not nothing: without it a wrap that fell between two words
        // would glue them together. Runs of whitespace collapse anyway.
        br.replaceWith(document.createTextNode(' '));
    });
}

// Stop short single-token cells from being broken across lines.
//
// Chromium treats every hyphen as a break opportunity, so a narrow column prints
// "2026-" / "09-08" and a version reads as two lines. Applied only to cells that
// are one short token — a long primer sequence still needs to wrap, or it would
// force the whole table wider than the page.
function jccPdfNoWrapShortCells(root) {
    root.querySelectorAll('td, th').forEach(cell => {
        const t = cell.textContent.trim();
        if (!t || t.length > 16 || /\s/.test(t)) return;
        cell.addClass('jcc-nowrap');
    });
}

// Freeze the font a diagram was measured in.
//
// Mermaid sizes every node box by measuring its label in whatever font Obsidian
// resolved at render time, then draws the box at exactly that width. The print
// window is a bare Chromium page with none of Obsidian's font variables, so the
// same label re-renders in a different — usually wider — face and spills past
// its own border: "+ blinatumomab" crossing the rectangle it sits in. Copying
// the resolved stack onto the SVG makes the measuring context and the printing
// context agree.
function jccPdfPinDiagramFonts(root) {
    root.querySelectorAll('.mermaid svg, .block-language-mermaid svg').forEach(svg => {
        const probe = svg.querySelector('.nodeLabel, foreignObject span, text, tspan');
        if (!probe) return;
        let family = '';
        try { family = window.getComputedStyle(probe).fontFamily || ''; } catch (e) { return; }
        if (!family) return;
        // `important`, because mermaid ships a <style> block inside the SVG and
        // an ordinary inline value would lose to a rule that uses !important.
        svg.style.setProperty('font-family', family, 'important');
        svg.querySelectorAll('text, tspan, .nodeLabel, .edgeLabel, foreignObject div, foreignObject span')
            .forEach(n => { if (n.style) n.style.setProperty('font-family', family, 'important'); });
    });
}

// Measure a rendered mermaid block. Returns 0 when it has not drawn yet.
function jccPdfDiagramAspect(block) {
    const svg = block.querySelector('svg');
    if (!svg) return 0;
    try {
        const vb = svg.viewBox && svg.viewBox.baseVal;
        if (vb && vb.width && vb.height) return vb.width / vb.height;
        const r = svg.getBoundingClientRect();
        return r.height ? r.width / r.height : 0;
    } catch (e) { return 0; }
}

// A left-to-right flowchart does not fit a portrait page.
//
// THE ARITHMETIC IS THE ARGUMENT. This protocol's timeline is ~4:1. Fitted to
// the 6.9in text column its node labels land near 3pt. Turning the page a
// quarter turn only buys the difference between 6.9in and 8.9in — 29%, so ~5pt,
// still unreadable. The only move that actually recovers the type size is to
// stop making the diagram's long axis the page's short axis: re-render it
// top-down, where the page has room to spare.
//
// ONLY WHEN IT IS ACTUALLY TOO WIDE, and only for LR/RL flowcharts, and only if
// the re-render is genuinely better — a diagram with wide parallel branches can
// come out worse top-down, and in that case the original is kept. The note is
// never modified; this is a rendering choice made for the printed medium.
async function jccPdfReflowWideDiagrams(app, root, sources, sourcePath, comp) {
    const WIDE = 2.4;
    const blocks = Array.from(root.querySelectorAll('.block-language-mermaid, .mermaid'))
        .filter(b => !b.closest('.jcc-wide-figure'));
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const src = sources[i];
        if (!src) continue;
        const aspect = jccPdfDiagramAspect(block);
        if (!aspect || aspect < WIDE) continue;
        if (!/^\s*(flowchart|graph)\s+(LR|RL)\b/m.test(src)) continue;
        const flipped = src.replace(/^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/m,
            (m, head, dir) => head + (dir === 'LR' ? 'TB' : 'BT'));

        const stage = root.createDiv();
        stage.setAttr('style', 'width:800px;');
        try {
            await MarkdownRenderer.render(app, '```mermaid\n' + flipped + '```', stage, sourcePath, comp);
            await jccPdfWaitForMermaid(stage, 4000);
            const redone = stage.querySelector('.block-language-mermaid, .mermaid');
            const newAspect = redone ? jccPdfDiagramAspect(redone) : 0;
            if (redone && newAspect && newAspect < aspect) {
                block.replaceWith(redone);
            }
        } catch (e) {
            // Keep the original rather than losing the diagram entirely.
        } finally {
            stage.remove();
        }
    }
}

// Anything still too wide after the reflow goes on its own rotated page — the
// 29% is worth having once it is the only gain left, and a diagram alone on a
// landscape page reads as a deliberate figure plate rather than a squeezed one.
function jccPdfRotateWideFigures(root) {
    const WIDE = 2.4;
    root.querySelectorAll('.mermaid, .block-language-mermaid').forEach(block => {
        const svg = block.querySelector('svg');
        if (!svg) return;
        let w = 0, h = 0;
        try {
            const vb = svg.viewBox && svg.viewBox.baseVal;
            if (vb && vb.width && vb.height) { w = vb.width; h = vb.height; }
            else { const r = svg.getBoundingClientRect(); w = r.width; h = r.height; }
        } catch (e) { return; }
        if (!w || !h || w / h < WIDE) return;
        // Mermaid pins an inline max-width to the diagram's natural size, which
        // would cap it well below the rotated page and undo the whole point.
        svg.style.removeProperty('max-width');
        const target = block.parentElement && block.parentElement.classList.contains('block-language-mermaid')
            ? block.parentElement : block;
        const fig = document.createElement('figure');
        fig.className = 'jcc-wide-figure';
        const inner = document.createElement('div');
        inner.className = 'jcc-wide-inner';
        target.parentElement.insertBefore(fig, target);
        inner.appendChild(target);
        fig.appendChild(inner);
    });
}

// Render the note the way Obsidian would, then hand back a standalone document.
async function jccPdfBuildHtml(app, file, opts) {
    const raw = await app.vault.cachedRead(file);
    const cache = app.metadataCache.getFileCache(file) || {};
    const fm = cache.frontmatter || {};

    // Strip frontmatter: it is re-presented as the title block, and rendering it
    // raw would put a YAML table at the top of the document.
    let body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

    // The note's H1 becomes the document title, so it must not also appear as
    // the first heading of the body.
    let title = fm.title || '';
    const h1 = body.match(/^#\s+(.+?)\s*$/m);
    if (h1) {
        if (!title) title = h1[1].trim();
        body = body.replace(h1[0], '');
    }
    if (!title) title = file.basename;

    // Captured before rendering, in document order, so a diagram that has to be
    // re-drawn for print can be rebuilt from its own source.
    const mermaidSrc = Array.from(body.matchAll(/```+\s*mermaid\s*\n([\s\S]*?)```+/g)).map(m => m[1]);

    body = jccPdfStripManagedRegions(body);
    body = jccPdfTagHardBreaks(body);

    const host = document.body.createDiv('jcc-pdf-stage');
    // Off-screen but LAID OUT: mermaid and image sizing need a real width, and
    // display:none would give every element zero height.
    // OFF-SCREEN, BUT OTHERWISE FULLY LIVE. `contain: layout` and `opacity: 0`
    // were both here and both had to go: mermaid sizes each node box by
    // measuring its label against the real DOM, and under either one the
    // measurements came back short, so the longest line in a node printed
    // clipped by its own border. Position is the only thing hiding this.
    host.setAttr('style',
        'position:fixed; left:-20000px; top:0; width:800px; pointer-events:none;');
    const comp = new Component();
    comp.load();
    let html;
    try {
        await MarkdownRenderer.render(app, body, host, file.path, comp);
        jccPdfJoinSoftBreaks(host);
        await jccPdfWaitForMermaid(host, 4000);
        await jccPdfReflowWideDiagrams(app, host, mermaidSrc, file.path, comp);
        jccPdfPinDiagramFonts(host);
        jccPdfPruneDeadAnchors(host);
        jccPdfNoWrapShortCells(host);
        jccPdfAllowLongBlocksToBreak(host);
        jccPdfRotateWideFigures(host);
        await jccPdfInlineImages(app, host);
        // Obsidian leaves interactive affordances in the rendered output.
        host.querySelectorAll(
            '.edit-block-button, .copy-code-button, .collapse-indicator, ' +
            '.heading-collapse-indicator, .markdown-embed-link, .jcc-figure-badge'
        ).forEach(n => n.remove());
        // A collapsed callout would print collapsed, hiding content the reader
        // of a PDF has no way to open.
        host.querySelectorAll('.callout.is-collapsed').forEach(n => {
            n.removeClass('is-collapsed');
            const c = n.querySelector('.callout-content');
            if (c) c.setAttr('style', 'display:block');
        });
        html = host.innerHTML;
    } finally {
        comp.unload();
        host.remove();
    }

    const eyebrow = (opts && opts.eyebrow) || jccPdfEyebrow(file, fm);
    const head = jccPdfHeadHtml(title, fm, eyebrow);

    const doc = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${jccPdfEsc(title)}</title>
<style>${JCC_PDF_CSS}</style>
</head><body>
${head}
<main class="jcc-doc-body">${html}</main>
</body></html>`;

    return { html: doc, title, version: fm.version, fileName: jccPdfFileName(title, fm.version) };
}

// Print a standalone HTML document to a PDF file.
//
// A hidden BrowserWindow, not window.print(): print() would paginate the
// Obsidian window itself, and offers no way to set margins, page size or the
// running footer. printToPDF returns the bytes, so nothing is left on screen
// and a batch export never steals focus.
async function jccPdfPrint(html, outPath, footerLeft) {
    const electron = require('electron');
    const remote = electron.remote || require('@electron/remote');
    if (!remote || !remote.BrowserWindow) throw new Error('Electron remote unavailable');

    const tmp = pathMod.join(os.tmpdir(), `jcc-pdf-${Date.now()}-${Math.floor(Math.random() * 1e6)}.html`);
    fs.writeFileSync(tmp, html, 'utf8');

    const win = new remote.BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
    });
    try {
        await win.loadFile(tmp);
        // Give web fonts and any inline SVG a frame to settle before snapshotting.
        await new Promise(r => setTimeout(r, 260));

        const chrome = (inner) =>
            `<div style="font-family:'Avenir Next','Helvetica Neue',sans-serif;font-size:7.5pt;` +
            `color:#858B99;width:100%;padding:0 16mm;display:flex;` +
            `justify-content:space-between;align-items:center;">${inner}</div>`;

        const data = await win.webContents.printToPDF({
            pageSize: JCC_PDF_PAGE,
            printBackground: true,
            margins: { top: 0.62, bottom: 0.62, left: 0.72, right: 0.72 },
            displayHeaderFooter: true,
            // An empty header still has to be a valid template, or Chromium
            // falls back to printing the page title and URL across the top.
            headerTemplate: '<div></div>',
            footerTemplate: chrome(
                `<span>${jccPdfEsc(footerLeft)}</span>` +
                `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>`),
            generateDocumentOutline: true,
        });
        fs.mkdirSync(pathMod.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, data);
    } finally {
        try { win.destroy(); } catch (e) { /* window may already be gone */ }
        try { fs.unlinkSync(tmp); } catch (e) { /* temp file, best effort */ }
    }
    return outPath;
}

module.exports = class JarvisCommandCenter extends Plugin {
    // The VIEW had this getter; the plugin did not, and two features written
    // as plugin methods quietly read `undefined` off it. consultTribunal ran
    // exec with cwd undefined - Obsidian's own working directory - and failed
    // with "analysis/scripts/tribunal.sh: No such file or directory", which at
    // least announced itself. The export gate failed the dangerous way: it
    // threw inside its try/catch, returned null, and let every unreviewed
    // document through while looking like it was working.
    get vaultRoot() {
        return this.app.vault.adapter.basePath;
    }

    async onload() {
        this.restoreTribunalState();
        // REGISTERED FIRST, DELIBERATELY.
        // These were originally registered at the END of onload(). onload() is a
        // single function: anything that throws part-way through — a changed API,
        // a missing element, a plugin-load race — silently kills every
        // registration after it, and the symptom is a command that simply does
        // not exist in the palette with no error the user ever sees. Presentation
        // is the entry point being debugged, so it goes before anything that
        // could throw.
        try {
            console.log('[jcc] onload build 2026-08-15-A — registering presentation mode');
        } catch (e) { /* console may be absent in some hosts */ }

        // KEYBOARD NAVIGATION — registered at PLUGIN level, on purpose.
        //
        // This is the load-bearing path, not a fallback. Four listeners
        // registered from INSIDE the modal (window capture, document capture,
        // Obsidian's keymap Scope, and the focused element) were all silent in
        // this build, while this plugin-level listener received every keypress.
        // The debug log proved it: five PROBE lines for five presses, zero from
        // any modal-scope listener. So the plugin holds a reference to the live
        // modal and drives it directly. Do not "simplify" this by moving the
        // listener into the modal — that is the arrangement that does not work.
        this.registerDomEvent(document, 'keydown', (e) => {
            if (!document.querySelector('.jcc-present-modal')) return;
            const d = this._liveDeck;
            let acted = '';
            if (d && typeof d.go === 'function') {
                if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar'].includes(e.key)) { d.go(1); acted = 'fwd'; }
                else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { d.go(-1); acted = 'back'; }
                else if (e.key === 'Home') { d.render(0); acted = 'first'; }
                else if (e.key === 'End') { d.render(d.slides.length - 1); acted = 'last'; }
                if (acted) { e.preventDefault(); e.stopPropagation(); }
            }
            // Debug logging is OFF by default: a presentation should not touch
            // the disk on every keystroke. Set `window.JCC_DEBUG = true` in the
            // developer console to turn it back on if this ever regresses.
            if (typeof window !== 'undefined' && window.JCC_DEBUG) {
                try {
                    const dir = this.app.vault.adapter.basePath;
                    require('fs').appendFileSync(
                        require('path').join(dir, 'jcc_present_debug.log'),
                        `${new Date().toISOString()}  KEY ${JSON.stringify(e.key)} ` +
                        `deck=${!!d} acted=${acted || 'none'}\n`);
                } catch (err) { /* never break the app for a log */ }
            }
        });
        this.addCommand({
            id: 'present-note',
            name: 'Present this note (fit to screen)',
            callback: () => this.presentActiveNote(),
        });

        // Also offer it where a user actually looks for it: the tab / file
        // context menu, beside Obsidian's own "Start presentation". Same method,
        // so the two entry points cannot drift apart.
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (!file || !file.path || !file.path.endsWith('.md')) return;
            menu.addItem((item) => {
                item.setTitle('Present (fit to screen)')
                    .setIcon('presentation')
                    .onClick(() => this.presentFile(file));
            });
        }));
        this.addCommand({
            id: 'export-pdf',
            name: 'Export this note as a PDF',
            callback: () => this.exportNotePdf(),
        });

        this.addCommand({
            id: 'export-protocols-pdf',
            name: 'Export all protocols as PDFs',
            callback: () => this.exportProtocolPdfs(),
        });

        this.addCommand({
            id: 'export-reports-pdf',
            name: 'Export all experiment reports as PDFs',
            callback: () => this.exportReportPdfs(),
        });

        this.addCommand({
            id: 'export-proposals-pdf',
            name: 'Export all proposals as PDFs',
            callback: () => this.exportFolderPdfs('proposals'),
        });

        // Beside "Present (fit to screen)" in the tab / file context menu, and
        // on a folder so the whole protocols/ directory can go out at once.
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (!file) return;
            if (file instanceof TFile && file.extension === 'md') {
                menu.addItem(item => item.setTitle('Export as PDF')
                    .setIcon('file-text')
                    .onClick(() => this.exportNotePdf(file)));
            } else if (!(file instanceof TFile)) {
                menu.addItem(item => item.setTitle('Export folder as PDFs')
                    .setIcon('folder-output')
                    .onClick(() => this.exportFolderPdfs(file.path)));
            }
        }));

        this.registerView(VIEW_TYPE, leaf => new CommandCenterView(leaf, this));

        this.addRibbonIcon('microscope', 'Jarvis Command Center', () => this._openView());

        this.addCommand({
            id: 'open-jarvis-command-center',
            name: 'Open Command Center',
            callback: () => this._openView(),
        });

        // Refresh the culture tracker (reparse reagent notes edited outside Obsidian).
        // Hotkey-bindable, and callable from the terminal via
        //   open "obsidian://jcc-refresh-cultures"
        this.addCommand({
            id: 'refresh-cultures',
            name: 'Refresh culture tracker',
            callback: () => this.refreshCultures(),
        });
        this.registerObsidianProtocolHandler('jcc-refresh-cultures', () => this.refreshCultures(true));

        this.app.workspace.onLayoutReady(() => this._openView());
        this.app.workspace.onLayoutReady(() => jccTagReportViews(this.app));
        this.registerEvent(this.app.workspace.on('file-open',
            () => jccTagReportViews(this.app)));
        this.registerEvent(this.app.workspace.on('layout-change',
            () => jccTagReportViews(this.app)));
        // Frontmatter can change while the note is open.
        this.registerEvent(this.app.metadataCache.on('changed',
            () => jccTagReportViews(this.app)));

        // ```jcc-matrix blocks render as a weighted result matrix.
        //
        // A code-block processor is the right hook here (unlike the mermaid
        // zoom, which needed a delegated click): the source is the fence body,
        // it is available synchronously, and Obsidian re-invokes this on every
        // re-render, so the block stays live when the note is edited.
        this.registerMarkdownCodeBlockProcessor('jcc-matrix', (src, el) => {
            try {
                jccRenderMatrix(src, el);
            } catch (e) {
                // Never swallow a malformed block silently - show the source so
                // the author can see what failed rather than an empty gap.
                const pre = el.createEl('pre', { cls: 'jcc-matrix-error' });
                pre.setText('jcc-matrix could not parse this block:\n\n' + src);
            }
        });

        // A tracker note opens in READING VIEW, not Live Preview.
        //
        // This is not a preference — the feature does not exist in Live Preview.
        // There the table belongs to the editor (and, in this vault, to the
        // Advanced Tables plugin, which renders it as its own table-editor
        // widget), so no post-processor decorates it and a click is a caret
        // placement. Obsidian's own `obsidianUIMode: preview` frontmatter loses
        // to the vault's default view mode here, so the plugin does it.
        //
        // Deferred a beat: at file-open the metadata cache has not necessarily
        // parsed the frontmatter of a note being opened for the first time.
        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (!file || file.extension !== 'md') return;
            window.setTimeout(() => {
                try {
                    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter;
                    if (!fm || fm['jcc-tracker'] !== true) return;
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view || view.file !== file) return;
                    if (view.getMode() === 'preview') return;
                    const state = view.getState();
                    state.mode = 'preview';
                    // history:false — this is a rendering choice, not navigation;
                    // it must not add a back-button step to the user's trail.
                    view.setState(state, { history: false });
                } catch (e) { console.error('[jcc] tracker view mode', e); }
            }, 60);
        }));

        // ── TRACKER TABLES ───────────────────────────────────────────────────
        //
        // The ```jcc-tracker fence renders as the summary + filter bar. A
        // code-block processor is right for the same reason it was right for
        // jcc-matrix: the source is the fence body and Obsidian re-invokes it
        // on every re-render, so the counts are recomputed rather than cached
        // into staleness.
        this.registerMarkdownCodeBlockProcessor('jcc-tracker', (src, el, ctx) => {
            jccRenderTrackerBar(this.app, src, el, ctx.sourcePath)
                .catch(e => {
                    console.error('[jcc] tracker bar failed', e);
                    el.createEl('pre', { cls: 'jcc-matrix-error',
                        text: 'jcc-tracker could not render:\n\n' + src });
                });
        });

        // Tag the cells of the tracker table so the click handler knows which
        // column it is in and the enum values can be drawn as chips. Async
        // because the schema lives in the note's own fence, which means a read.
        this.registerMarkdownPostProcessor((el, ctx) => {
            if (!ctx || !ctx.sourcePath) return;
            return jccDecorateTrackerTables(this.app, el, ctx.sourcePath)
                .catch(e => console.error('[jcc] tracker decorate failed', e));
        });

        // Click a cell -> its dropdown. Click the key cell -> the whole row.
        //
        // READING VIEW ONLY, deliberately. In Live Preview the table is a live
        // editor: a click there is a caret placement, and popping a menu over
        // it would make the note impossible to type in.
        this.registerDomEvent(document, 'click', (e) => {
            if (!(e.target instanceof Element)) return;
            const td = e.target.closest('td');
            if (!td) return;
            const table = td.closest('table.jcc-tracker-table');
            if (!table) return;
            if (!td.closest('.markdown-preview-view, .markdown-reading-view')) return;
            // A click that is really the mouse-up of a drag-select must not
            // steal the selection — these cells get copied out constantly.
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.toString().trim()) return;
            if (e.target.closest('a, .internal-link, .external-link, button')) return;

            const src = table.getAttr('data-jcc-tracker-src');
            const entry = JCC_TRACKER_CACHE.get(src);
            if (!entry) return;
            const schema = entry.schema;
            const tr = td.parentElement;
            const heads = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
            const keyIdx = Math.max(0, heads.findIndex(h => h.toLowerCase() === (schema.key || '').toLowerCase()));
            const values = new Map();
            heads.forEach((h, i) => values.set(h, (tr.children[i] || { textContent: '' }).textContent.trim()));
            const ctx = {
                src,
                row: Number(tr.getAttr('data-jcc-row') || -1),
                key: (tr.children[keyIdx] || { textContent: '' }).textContent.trim(),
            };
            const colName = td.getAttr('data-jcc-col') || '';
            const field = schema.cols.get(colName.toLowerCase());

            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();
            if (Array.from(tr.children).indexOf(td) === keyIdx || !field) {
                jccTrackerRowMenu(this.app, menu, ctx, schema, values);
            } else {
                jccTrackerCellMenu(this.app, menu, ctx, field, values.get(colName) || '');
            }
            menu.showAtMouseEvent(e);
        });

        // Click any rendered mermaid diagram to open it full-screen.
        //
        // A POST-PROCESSOR IS NOT ENOUGH ON ITS OWN. Obsidian runs mermaid
        // asynchronously: at post-processor time the <pre class="mermaid"> is
        // usually still source text and the <svg> does not exist yet. So we mark
        // the container here and attach a DELEGATED listener on the document,
        // which fires whenever the svg has appeared by click time - no polling,
        // no MutationObserver, and it survives re-renders.
        this.registerMarkdownPostProcessor((el) => {
            el.querySelectorAll('.mermaid').forEach(n => n.addClass('jcc-mermaid-zoomable'));
        });
        this.registerDomEvent(document, 'click', (e) => {
            const host = e.target instanceof Element
                ? e.target.closest('.mermaid, .jcc-mermaid-zoomable') : null;
            if (!host) return;
            if (host.closest('.jcc-mermaid-modal')) return;   // already zoomed
            const svg = host.querySelector('svg');
            if (!svg) return;                                  // not rendered yet
            new MermaidZoomModal(this.app, svg).open();
        });

        // Click a table in a REPORT to open it enlarged.
        //
        // Delegated on the document for the same reason as the mermaid handler:
        // tables are re-rendered on every preview refresh, and a delegated
        // listener needs no re-attachment.
        //
        // THREE GUARDS, each for a real failure:
        //  * Reports only. Day files keep plain tables, matching the styling
        //    scope - a click-to-zoom on every table in the vault would be an
        //    unwanted behaviour change in notes the user edits constantly.
        //  * Not already inside a zoom modal, or clicking the enlarged table
        //    would open another one on top of itself.
        //  * NOT A TEXT SELECTION. These tables exist to be read off and copied;
        //    a click that is really the mouse-up of a drag-select would steal the
        //    selection and pop a modal. If anything is selected, do nothing.
        this.registerDomEvent(document, 'click', (e) => {
            if (!(e.target instanceof Element)) return;
            const table = e.target.closest('table');
            if (!table) return;
            if (table.closest('.jcc-table-modal, .jcc-mermaid-modal')) return;
            // A tracker table is an input surface, not a figure. Zooming it on
            // click would swallow the cell dropdown, and the two handlers are
            // both delegated on document — stopPropagation from the tracker
            // handler cannot reach this one, so the guard has to live here.
            if (table.hasClass('jcc-tracker-table')) return;
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.toString().trim()) return;
            // A link or an embed inside a cell keeps its own behaviour.
            if (e.target.closest('a, .internal-link, .external-link, button')) return;
            const view = table.closest('[data-jcc-report]');
            if (!view) return;                                 // not a report note
            new JccTableZoomModal(this.app, table, true).open();
        });

        // Exposed on the instance so the tracker can be driven without a mouse:
        // from the developer console, from `obsidian eval`, and from Claude
        // Code updating the roster after a meeting. Same code path as the
        // dropdown, so a scripted edit cannot format the table differently
        // from a clicked one.
        this.tracker = {
            load: (path) => jccTrackerLoad(this.app, path),
            set: (path, key, col, value) => jccTrackerEdit(this.app, path, -1, key, col, value),
            addRow: (path, key) => jccTrackerAddRow(this.app, path, key),
        };

        this.addCommand({
            id: 'tracker-add-row',
            name: 'Tracker: add a row to this note',
            callback: async () => {
                const f = this.app.workspace.getActiveFile();
                if (!f) { new Notice('No active note.'); return; }
                const entry = await jccTrackerLoad(this.app, f.path);
                if (!entry) { new Notice('This note has no ```jcc-tracker block.'); return; }
                new InputModal(this.app, `Add to ${entry.schema.title || 'tracker'}`,
                    entry.schema.key || 'Name',
                    (v) => jccTrackerAddRow(this.app, f.path, v)).open();
            },
        });

        this.addCommand({
            id: 'zoom-first-table',
            name: 'Zoom first table in this note',
            callback: () => {
                // Keyboard path, for a note read without the mouse. Deliberately
                // NOT report-scoped: an explicit command is the user asking, so
                // the report guard (which exists to avoid changing click
                // behaviour vault-wide) does not apply.
                const view = this.app.workspace.getActiveViewOfType(ItemView);
                const root = view && view.containerEl ? view.containerEl : document;
                const t = root.querySelector('.markdown-rendered table');
                if (!t) { new Notice('No rendered table in this note'); return; }
                const isReport = !!t.closest('[data-jcc-report]');
                new JccTableZoomModal(this.app, t, isReport).open();
            },
        });

        this.addCommand({
            id: 'zoom-first-mermaid',
            name: 'Zoom first Mermaid diagram in this note',
            callback: () => {
                const view = this.app.workspace.getActiveViewOfType(
                    require('obsidian').MarkdownView);
                const svg = view && view.containerEl.querySelector('.mermaid svg');
                if (!svg) { new Notice('No rendered Mermaid diagram in this note.'); return; }
                new MermaidZoomModal(this.app, svg).open();
            },
        });

        // ── Figure annotations ───────────────────────────────────────────────
        //
        // Click any figure in a note to open it full-screen, then click a spot
        // on the image to pin a note there. See the JccAnnotationStore comment
        // block above for why coordinates are stored normalised.
        this.annotations = new JccAnnotationStore(this.app);
        this.annotations.load();

        // DELEGATED, AND ON CAPTURE.
        //  * Delegated for the same reason as the mermaid and table handlers:
        //    note content is re-rendered constantly, so a directly-bound
        //    listener would need re-attaching on every repaint.
        //  * On capture because Obsidian has its own click-to-zoom on images;
        //    without capture that handler runs first and this one never sees a
        //    usable event.
        // Alt-click is left alone as the escape hatch back to Obsidian's own
        // behaviour.
        this.registerDomEvent(document, 'click', (e) => {
            if (!(e.target instanceof Element)) return;
            if (e.altKey) return;
            const img = e.target.closest('img');
            if (!img) return;
            // Not inside one of our own full-screen surfaces, and not in the
            // command-center sidebar.
            if (img.closest('.jcc-annot-modal, .jcc-present-modal, .jcc-table-modal, ' +
                            '.jcc-mermaid-modal, .workspace-leaf-content[data-type="jarvis-command-center"]')) return;
            // Note content only. Reading view, live-preview embeds and hover
            // popovers all qualify; a ribbon icon or a settings image does not.
            if (!img.closest('.markdown-rendered, .markdown-preview-view, .internal-embed, ' +
                             '.image-embed, .workspace-leaf-content[data-type="image"]')) return;
            const file = jccResolveImageFile(this.app, img);
            if (!file) return;
            e.preventDefault();
            e.stopPropagation();
            this.openFigureAnnotator(file, jccNotePathForEl(this.app, img));
        }, true);

        // ── Text annotations ─────────────────────────────────────────────────
        //
        // The prose counterpart of the figure annotator. Select text, pin a
        // comment; the comment follows that text through later edits and is
        // flagged when the quote itself is edited away. See the
        // JccTextAnnotationStore comment block for the anchoring model.
        this.textAnnotations = new JccTextAnnotationStore(this.app);
        this.textAnnotations.load();

        const jccActiveNotePath = () => {
            const f = this.app.workspace.getActiveFile();
            return f ? f.path : '';
        };

        const jccPinSelection = async () => {
            const notePath = jccActiveNotePath();
            if (!notePath) { new Notice('No note is open.'); return; }
            const file = this.app.vault.getAbstractFileByPath(notePath);
            if (!file) return;
            const src = await this.app.vault.read(file);
            const anchor = jccSelectionAnchor(this.app, notePath, src);
            if (!anchor) {
                new Notice('Select some text in the note first. ' +
                           '(A selection that spans a figure or a table border cannot be anchored.)');
                return;
            }
            new JccTextAnnotateModal(this.app, this.textAnnotations, notePath, anchor, null,
                                     () => this.app.workspace.trigger('jcc:text-annotations-changed')).open();
        };

        this.addCommand({
            id: 'annotate-selected-text',
            name: 'Annotate selected text',
            callback: jccPinSelection,
        });

        this.addCommand({
            id: 'sync-text-annotations',
            name: 'Re-anchor and sync text annotations in this note',
            callback: async () => {
                const notePath = jccActiveNotePath();
                if (!notePath) { new Notice('No note is open.'); return; }
                const file = this.app.vault.getAbstractFileByPath(notePath);
                const src = await this.app.vault.read(file);
                const { moved, stale } = await this.textAnnotations.reanchor(notePath, src);
                await this.textAnnotations.syncNote(notePath);
                new Notice(`Text annotations synced — ${moved} moved, ${stale} stale.`);
            },
        });

        // Right-click on a selection is where a reader reaches first.
        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
            if (!editor.getSelection()) return;
            menu.addItem((item) => item
                .setTitle('Annotate selected text')
                .setIcon('message-square')
                .onClick(jccPinSelection));
        }));

        // Highlight anchored passages, and click a highlight to edit its comment.
        this.registerMarkdownPostProcessor((el, ctx) => {
            const notePath = (ctx && ctx.sourcePath) || jccActiveNotePath();
            if (!notePath) return;
            this.textAnnotations.reloadIfChanged().then(() => {
                const open = this.textAnnotations.forNote(notePath)
                    .filter(a => a.status !== 'resolved' && a.anchor !== 'stale');
                jccHighlightAnchors(el, open);
            });
        });

        this.registerDomEvent(document, 'click', (e) => {
            if (!(e.target instanceof Element)) return;
            const hit = e.target.closest('.jcc-tann-hit');
            if (!hit) return;
            const id = hit.getAttribute('data-ann');
            const notePath = jccActiveNotePath();
            const a = this.textAnnotations.data.annotations.find(n => n.id === id);
            if (!a) return;
            e.preventDefault();
            e.stopPropagation();
            new JccTextAnnotateModal(this.app, this.textAnnotations, notePath, null, a,
                                     () => this.app.workspace.trigger('jcc:text-annotations-changed')).open();
        }, true);

        // A LINK to an image opens the annotator IN PLACE instead of navigating
        // to that image's own view.
        //
        // One fix for two complaints, because both come from the navigation
        // rather than from the figure:
        //  * Following a figure link and coming back lands at the TOP of a long
        //    report rather than where you were. Obsidian restores the scroll
        //    offset while the note's figures still have no height, so it is
        //    clamped against a document that is briefly far shorter than it is
        //    about to become; the images then load and grow underneath it.
        //    Not navigating at all means there is nothing to restore.
        //  * Obsidian's image view has no fit-to-window, so a full-size figure
        //    cannot be seen whole. The annotator opens fitted, and zooms.
        //
        // THIS HOOKS THE NAVIGATION, NOT THE DOM. Two DOM attempts failed here:
        // first a click listener, then mousedown at window capture. Neither can
        // win, and the reason is registration order rather than phase — for
        // listeners on the same node in the same phase the browser fires them in
        // the order they were added, and Obsidian core binds its link handler
        // long before any plugin is loaded. So core always navigated first and
        // the annotator needed a second click on the image it had opened.
        //
        // openLinkText is the funnel every internal link click passes through,
        // whatever rendered it, so wrapping it takes the decision before a view
        // is ever created. Clicking a file in the file explorer does NOT come
        // through here — that calls openFile directly — which is why the image
        // view still gets the fit-to-pane styling as a fallback.
        const ws = this.app.workspace;
        const origOpenLinkText = ws.openLinkText;
        // openLinkText normally lives on the prototype, so assigning to the
        // instance shadows it rather than replacing it. Record which it was, so
        // unload can put the object back exactly as it found it instead of
        // leaving a permanent own-property copy behind on every reload.
        const hadOwnOpenLinkText = Object.prototype.hasOwnProperty.call(ws, 'openLinkText');
        const patchedOpenLinkText = (linktext, sourcePath, newLeaf, openViewState) => {
            try {
                // newLeaf set means cmd/shift-click asking for a tab or split;
                // that is an explicit request for a real view, so honour it.
                if (!newLeaf) {
                    const href = String(linktext || '').split('#')[0].split('|')[0].trim();
                    const file = this.app.metadataCache.getFirstLinkpathDest(href, sourcePath || '')
                              || this.app.vault.getAbstractFileByPath(href);
                    if (file && JCC_IMG_EXT.test(file.extension || '')) {
                        this.openFigureAnnotator(file, sourcePath);
                        return Promise.resolve();
                    }
                }
            } catch (err) {
                console.error('[jcc] figure link interception failed', err);
            }
            return origOpenLinkText.call(ws, linktext, sourcePath, newLeaf, openViewState);
        };
        ws.openLinkText = patchedOpenLinkText;
        // Restore only if it is still ours, so unloading does not clobber a
        // wrapper another plugin installed on top of this one.
        this.register(() => {
            if (ws.openLinkText !== patchedOpenLinkText) return;
            if (hadOwnOpenLinkText) ws.openLinkText = origOpenLinkText;
            else delete ws.openLinkText;
        });

        this.addCommand({
            id: 'annotate-figure',
            name: 'Annotate a figure in this note',
            callback: () => this.annotateFigureInActiveNote(),
        });

        this.addCommand({
            id: 'sync-figure-annotations',
            name: 'Sync figure annotations into this note',
            callback: async () => {
                const f = this.app.workspace.getActiveFile();
                if (!f) { new Notice('No active note.'); return; }
                await this.annotations.load();
                const ok = await this.annotations.syncNote(f.path);
                new Notice(ok ? 'Figure annotations synced into the note'
                              : 'No figure annotations recorded for this note');
            },
        });

        this.addCommand({
            id: 'copy-figure-annotations',
            name: 'Copy this note’s figure annotations (for Claude)',
            callback: () => this.copyFigureAnnotations(),
        });

        // Badge the inline figure with its open-annotation count. Deferred by a
        // beat in each case because the images are not in the DOM yet at the
        // moment these events fire.
        this.registerEvent(this.app.workspace.on('layout-change',
            () => setTimeout(() => this.refreshFigureBadges(), 200)));
        this.registerEvent(this.app.workspace.on('file-open',
            () => setTimeout(() => this.refreshFigureBadges(), 300)));
        this.registerMarkdownPostProcessor(
            () => setTimeout(() => this.refreshFigureBadges(), 120));

        // ── LIVE REFRESH ─────────────────────────────────────────────────────
        //
        // Keeps an open report in step with what Claude has just written to it,
        // instead of needing the tab clicked off and back on.
        //
        // TWO DIFFERENT STALENESS PROBLEMS, which need different treatment:
        //  * A REGENERATED FIGURE does not change the note at all, so nothing
        //    prompts a re-render and the old picture stays on screen. Only the
        //    <img> needs swapping.
        //  * A REWRITTEN NOTE — an annotation block, a table — needs the
        //    preview rebuilt.
        //
        // DRIVEN OFF VAULT EVENTS, NOT A CLAUDE CODE HOOK. The reagents refresh
        // uses a PostToolUse hook matching Edit|Write|MultiEdit, which cannot
        // work here: /fix-figures regenerates figures by running a python script
        // under Bash, and no Edit or Write tool call ever happens. The vault
        // fires modify for any change it observes, whoever made it.
        this.registerEvent(this.app.vault.on('modify', (file) => {
            try {
                if (!file || !file.path) return;
                if (JCC_IMG_EXT.test(file.extension || '')) {
                    this.refreshFigureSrc(file);
                    return;
                }
                if (file.extension !== 'md') return;
                // Debounced per path: a script rewriting a note can fire modify
                // several times in quick succession.
                if (!this._mdRefresh) this._mdRefresh = new Map();
                window.clearTimeout(this._mdRefresh.get(file.path));
                this._mdRefresh.set(file.path, window.setTimeout(() => {
                    this._mdRefresh.delete(file.path);
                    this.refreshNote(file.path, true);
                }, 400));
            } catch (e) {
                console.error('[jcc] live refresh failed', e);
            }
        }));

        this.addCommand({
            id: 'refresh-note',
            name: 'Refresh this note (re-render and reload figures)',
            callback: () => this.refreshNote(null, false),
        });
        this.registerObsidianProtocolHandler('jcc-refresh-note', () => this.refreshNote(null, true));


    }


    // ── PDF export ───────────────────────────────────────────────────────────

    // Where a shared PDF goes.
    //
    // NOT into the vault: these are derived artefacts of the note, they would be
    // committed on every re-export, and the point of making one is to attach it
    // to an email. Downloads is where a collaborator-bound file belongs, and it
    // is the folder the user's file picker already opens in.
    _pdfOutDir(sub) {
        // A subfolder, not Downloads itself: this vault's Downloads holds
        // thousands of files, and a protocol you want to re-send next month has
        // to be findable without remembering its exact name.
        const base = pathMod.join(os.homedir(), 'Downloads', 'Jarvis PDFs');
        return sub ? pathMod.join(base, sub) : base;
    }

    // Returns the standalone HTML without printing it. Useful for inspecting the
    // document the PDF is made from, and for handing someone the HTML instead.
    async buildNoteHtml(file) {
        const target = file || this.app.workspace.getActiveFile();
        if (!target || target.extension !== 'md') return null;
        return jccPdfBuildHtml(this.app, target, {});
    }

    async exportNotePdf(file) {
        const target = file || this.app.workspace.getActiveFile();
        if (!target || target.extension !== 'md') {
            new Notice('Open a note to export it as a PDF.');
            return null;
        }
        const why = unreviewedForExport(this.vaultRoot, target.path);
        if (why && !window.confirm(
                `${target.basename} is ${why}.\n\n` +
                `This is the point where it stops being a draft and becomes something ` +
                `someone else reads. Run /codex-review on it first?\n\n` +
                `OK = export anyway    ·    Cancel = stop and review it`)) {
            new Notice('Export cancelled — run /codex-review on it first.');
            return null;
        }
        const notice = new Notice(`Rendering ${target.basename}…`, 0);
        try {
            const built = await jccPdfBuildHtml(this.app, target, {});
            const out = pathMod.join(this._pdfOutDir(), built.fileName);
            const footer = built.version
                ? `${built.title}  ·  v${built.version}`
                : built.title;
            await jccPdfPrint(built.html, out, footer);
            notice.hide();
            new Notice(`PDF saved — ${built.fileName}`, 6000);
            // Reveal rather than open: the next thing the user does with it is
            // drag it into an email, not read it.
            try { require('electron').shell.showItemInFolder(out); } catch (e) {}
            return out;
        } catch (e) {
            notice.hide();
            console.error('[jcc] pdf export failed', e);
            new Notice('PDF export failed — ' + (e && e.message ? e.message : e), 8000);
            return null;
        }
    }

    // Batch. Sequential on purpose: each export spins up a BrowserWindow, and
    // eighteen of them at once is how you get an unresponsive app.
    //
    // Takes an explicit file list rather than a folder, because reports are not
    // in one folder — they sit under each experiment's own reports/ directory,
    // so "all reports" is a set the caller assembles, not a path prefix.
    async exportPdfBatch(files, label) {
        if (!files || !files.length) { new Notice('Nothing to export.'); return; }
        // One prompt for the batch, not one per file: a dialog that appears
        // eleven times is a dialog that gets clicked through without reading.
        const unreviewed = files
            .map(f => ({ f, why: unreviewedForExport(this.vaultRoot, f.path) }))
            .filter(x => x.why);
        if (unreviewed.length && !window.confirm(
                `${unreviewed.length} of ${files.length} document(s) have not been reviewed at ` +
                `their current text:\n\n` +
                unreviewed.slice(0, 8).map(x => `  • ${x.f.basename} — ${x.why}`).join('\n') +
                (unreviewed.length > 8 ? `\n  • …and ${unreviewed.length - 8} more` : '') +
                `\n\nOK = export anyway    ·    Cancel = stop and review them`)) {
            new Notice('Export cancelled — run /codex-review first.');
            return;
        }
        const outDir = this._pdfOutDir(`${label}-pdf-${todayStr()}`);
        const notice = new Notice('Exporting…', 0);
        const failed = [];
        // Filenames come from note TITLES, and two notes in a batch can share one
        // — an experiment's day reports, say. Without this the second silently
        // overwrites the first and the batch still reports success.
        const used = new Set();
        let n = 0;
        for (const f of files) {
            notice.setMessage(`Exporting ${++n}/${files.length} — ${f.basename}`);
            try {
                const built = await jccPdfBuildHtml(this.app, f, {});
                const footer = built.version ? `${built.title}  ·  v${built.version}` : built.title;
                let name = built.fileName;
                for (let i = 2; used.has(name); i++) {
                    name = built.fileName.replace(/\.pdf$/, `-${i}.pdf`);
                }
                used.add(name);
                await jccPdfPrint(built.html, pathMod.join(outDir, name), footer);
            } catch (e) {
                console.error('[jcc] pdf export failed for ' + f.path, e);
                failed.push(f.basename);
            }
        }
        notice.hide();
        // Name what did not make it. A batch that quietly drops two protocols
        // and still says "done" is worse than one that fails loudly.
        new Notice(failed.length
            ? `${files.length - failed.length}/${files.length} exported. Failed: ${failed.join(', ')}`
            : `${files.length} PDFs saved to ${pathMod.basename(outDir)}`, 9000);
        try { require('electron').shell.showItemInFolder(outDir); } catch (e) {}
    }

    // Every note under a folder.
    exportFolderPdfs(folder) {
        const dir = (folder || 'protocols').replace(/\/+$/, '');
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(dir + '/'))
            .sort((a, b) => a.basename.localeCompare(b.basename));
        if (!files.length) { new Notice(`No notes found in ${dir}/`); return; }
        return this.exportPdfBatch(files, pathMod.basename(dir));
    }

    // Kept as its own name because CLAUDE.md and the command palette both use it.
    exportProtocolPdfs(folder) { return this.exportFolderPdfs(folder || 'protocols'); }

    // Reports are scattered across experiments/<TC_XXX>/reports/, so they are
    // collected by path shape rather than from a single directory.
    jccReportFiles() {
        return this.app.vault.getMarkdownFiles()
            .filter(f => /(^|\/)reports\//.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    exportReportPdfs() { return this.exportPdfBatch(this.jccReportFiles(), 'reports'); }

    // ── Live refresh ─────────────────────────────────────────────────────────

    // Reload every rendered copy of a figure that has just changed on disk.
    //
    // Obsidian resolves an image to app://<id>/<path>?<mtime>. Once that <img>
    // is in the document it keeps the URL it was handed, so a figure a script
    // has just rewritten still shows the OLD picture — the note itself never
    // changed, so nothing triggers a re-render. Handing the element a freshly
    // resolved path, which carries the new mtime, swaps the picture in place
    // and leaves the rest of the document alone, so the reader keeps their
    // scroll position.
    refreshFigureSrc(file) {
        let fresh;
        try { fresh = this.app.vault.getResourcePath(file); } catch (e) { return 0; }
        let n = 0;
        document.querySelectorAll('.markdown-rendered img, .internal-embed img, ' +
                                  '.workspace-leaf-content[data-type="image"] img').forEach(img => {
            let f = null;
            try { f = jccResolveImageFile(this.app, img); } catch (e) { return; }
            if (!f || f.path !== file.path) return;
            img.src = fresh;
            n++;
        });
        return n;
    }

    // Rebuild the reading view of a note. Called automatically when the file
    // changes, and by hand from the command / orb button / protocol URI.
    // ── Consult the Tribunal ────────────────────────────────────────────────

    // Three judges, and the point is that they are not one mind. Claude writes
    // it, Codex checks the claims against the evidence, and Gemini reads it
    // cold - shown neither Claude's reasoning nor Codex's findings. Two agents
    // that talk to each other converge; the defect that survives is the one
    // they agree on.
    //
    // It runs detached because Codex takes minutes and Obsidian must not sit
    // there frozen. The verdicts land in .claude/tribunal/<stamp>/ and Claude
    // reads them from there - deliberately NOT applied by anything automatic.
    // The row shows its own state, because a Notice is a thing you miss. It
    // lives on the PLUGIN, not the view: the sidebar can be closed and
    // reopened mid-run, and a run whose progress vanished with the panel would
    // look like it never happened.
    setTribunalState(st) {
        this.tribunalState = st;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            if (leaf.view && typeof leaf.view._paintTribunal === 'function') {
                leaf.view._paintTribunal();
            }
        }
    }

    consultTribunal(file) {
        // Clicking a sidebar button can leave no "active file" in some layouts,
        // and refusing at that point looks like a dead button. Fall back to the
        // last markdown file that was open, which is the document the row was
        // naming anyway.
        let target = file || this.app.workspace.getActiveFile();
        if (!target || target.extension !== 'md') {
            const recent = (this.app.workspace.getLastOpenFiles() || [])
                .find(p => p.endsWith('.md'));
            const f = recent && this.app.vault.getAbstractFileByPath(recent);
            if (f && f.extension === 'md') target = f;
        }
        if (!target || target.extension !== 'md') {
            new Notice('Open the document you want judged.');
            return;
        }
        if (this.tribunalState?.status === 'running') {
            new Notice(`⚖️ Already sitting on ${this.tribunalState.name}. One at a time.`, 6000);
            return;
        }
        const rel = target.path;

        // DETACHED, so the judgment survives the app that asked for it. As a
        // child of Obsidian this died whenever Obsidian did - quit the app
        // before bed and you would wake to a half-finished review and no sign
        // of it. Now Obsidian is only the thing that started it and the thing
        // that reads the result; closing it costs nothing.
        const logPath = pathMod.join(this.vaultRoot, '.claude', 'tribunal', 'last-run.log');
        try { fs.mkdirSync(pathMod.dirname(logPath), { recursive: true }); } catch { /* */ }
        const log = fs.openSync(logPath, 'a');
        const child = spawn('bash', ['analysis/scripts/tribunal.sh', rel], {
            cwd: this.vaultRoot,
            detached: true,
            stdio: ['ignore', log, log],
        });
        child.unref();

        this.setTribunalState({ status: 'running', name: target.basename,
                                path: target.path, startedAt: Date.now() });
        new Notice(`⚖️ The Tribunal convenes on ${target.basename}…\n` +
                   `Codex first, then a blinded cold read. Several minutes.\n` +
                   `Switch files freely, or quit — it runs on its own now.`, 8000);

        // The completion signal is a file on disk, not a callback: a detached
        // process reports to nobody, and a file is also what is still there
        // tomorrow morning when the Notice is long gone.
        const before = this._lastSittingStamp();
        const poll = window.setInterval(() => {
            const now = this._lastSittingStamp();
            if (!now || now === before) return;
            window.clearInterval(poll);
            this.setTribunalState({ status: 'done', name: target.basename,
                                    dir: `.claude/tribunal/${now}`, endedAt: Date.now() });
            new Notice(`⚖️ Verdicts in on ${target.basename}.\n` +
                       `.claude/tribunal/${now}\n` +
                       `Ask Claude to read them — findings are not instructions.`, 30000);
        }, 15_000);
        this.registerInterval(poll);
    }

    // The stamp of the most recent completed sitting, or null. Read from the
    // file tribunal.sh writes, so it is correct across restarts.
    _lastSittingStamp() {
        try {
            const f = pathMod.join(this.vaultRoot, '.claude', 'tribunal', 'latest.json');
            const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
            return (j.dir || '').split('/').pop() || null;
        } catch { return null; }
    }

    // On load the panel should already know what happened overnight.
    restoreTribunalState() {
        try {
            const f = pathMod.join(this.vaultRoot, '.claude', 'tribunal', 'latest.json');
            const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
            this.tribunalState = {
                status: 'done',
                name: (j.files || '').split('/').pop() || 'a document',
                dir: j.dir,
                endedAt: Date.parse(j.finished_at) || Date.now(),
            };
        } catch { /* nothing has been judged yet */ }
    }

    refreshNote(path, silent) {
        if (!path) {
            const af = this.app.workspace.getActiveFile();
            path = af ? af.path : null;
        }
        if (!path) {
            if (!silent) new Notice('No note is open to refresh.');
            return 0;
        }
        let n = 0;
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const view = leaf.view;
            if (!view || !view.file || view.file.path !== path) return;
            // READING VIEW ONLY. Re-rendering under an active edit would fight
            // the editor and move the cursor out from under the typist.
            try {
                if (typeof view.getMode === 'function' && view.getMode() !== 'preview') return;
            } catch (e) { return; }
            const pm = view.previewMode;
            if (!pm || typeof pm.rerender !== 'function') return;
            // Hold the scroll position across the rebuild, and put it back a
            // second time once the figures have sized themselves — until they
            // load, the document is shorter than it will be and the offset gets
            // clamped toward the top.
            let scroll = null;
            try { scroll = pm.getScroll ? pm.getScroll() : null; } catch (e) { /* not available */ }
            pm.rerender(true);
            if (scroll != null && typeof pm.applyScroll === 'function') {
                const put = () => { try { pm.applyScroll(scroll); } catch (e) { /* view went away */ } };
                setTimeout(put, 50);
                setTimeout(put, 450);
            }
            n++;
        });
        if (!silent) {
            new Notice(n ? `🔄 Refreshed ${path.split('/').pop()}`
                         : 'Nothing to refresh — this note is not in reading view.');
        }
        return n;
    }

    // ── Figure annotations ───────────────────────────────────────────────────

    async openFigureAnnotator(file, notePath) {
        // One annotator at a time. Several routes now lead here — an embedded
        // figure, a link, the image view — and two of them firing for a single
        // gesture would stack a second modal on top of the first.
        if (document.querySelector('.jcc-annot-modal')) return;
        // Only a markdown note can carry the mirrored annotation block. Reaching
        // a figure from the image's OWN view reports that image as the enclosing
        // file, which would attribute the annotation to something that cannot
        // hold it — better to record no note than a wrong one.
        const note = (notePath && notePath.endsWith('.md')) ? notePath : '';
        await this.annotations.load();
        const m = new JccFigureAnnotateModal(this.app, this.annotations, file, note);
        m.onDone = () => setTimeout(() => this.refreshFigureBadges(), 150);
        m.open();
    }

    async annotateFigureInActiveNote() {
        const note = this.app.workspace.getActiveFile();
        if (!note) { new Notice('Open a note first.'); return; }
        // Read the figures from the metadata cache rather than the DOM, so this
        // works from a note that is open in edit mode with nothing rendered.
        const cache = this.app.metadataCache.getFileCache(note) || {};
        const refs = [...(cache.embeds || []), ...(cache.links || [])];
        const seen = new Set();
        const figs = [];
        for (const r of refs) {
            const f = this.app.metadataCache.getFirstLinkpathDest(
                String(r.link).split('#')[0].split('|')[0].trim(), note.path);
            if (!f || seen.has(f.path)) continue;
            if (!JCC_IMG_EXT.test(f.extension || '')) continue;
            seen.add(f.path);
            figs.push(f);
        }
        if (!figs.length) { new Notice('No figures embedded in this note.'); return; }
        await this.annotations.load();
        if (figs.length === 1) { this.openFigureAnnotator(figs[0], note.path); return; }
        new JccFigurePickModal(this.app, figs,
            f => this.openFigureAnnotator(f, note.path)).open();
    }

    // Hand the open annotations to Claude without making the user retype them.
    async copyFigureAnnotations() {
        const note = this.app.workspace.getActiveFile();
        if (!note) { new Notice('Open a note first.'); return; }
        await this.annotations.load();
        const anns = this.annotations.forNote(note.path).filter(a => a.status !== 'resolved');
        if (!anns.length) { new Notice('No open figure annotations in this note.'); return; }
        const byFig = new Map();
        for (const a of anns) {
            if (!byFig.has(a.figure)) byFig.set(a.figure, []);
            byFig.get(a.figure).push(a);
        }
        const out = [
            `Figure annotations from ${note.path} — please apply these to the figures.`,
            'Positions are % from the left and % from the top of the image.',
            '',
        ];
        for (const [fig, list] of byFig) {
            out.push(fig);
            list.forEach((a, i) => out.push(`  ${i + 1}. [${jccWhere(a)}] ${a.text}`));
            out.push('');
        }
        await navigator.clipboard.writeText(out.join('\n'));
        new Notice(`Copied ${anns.length} annotation${anns.length === 1 ? '' : 's'} to the clipboard`);
    }

    // Show an open-annotation count on the figure as it sits in the note, so a
    // pending change is visible without opening anything.
    refreshFigureBadges() {
        window.clearTimeout(this._badgeTimer);
        this._badgeTimer = window.setTimeout(() => this._doRefreshFigureBadges(), 80);
    }

    async _doRefreshFigureBadges() {
        const store = this.annotations;
        if (!store) return;
        // RE-READ BEFORE DRAWING. This overlay used to render from the in-memory
        // cache, which load() returns without touching disk. So a resolution
        // written by the Python CLI left the file and the note's markdown block
        // correct while the PIN the user actually looks at stayed open - the
        // fix for the mutation path did not cover the read path.
        // Gated on mtime so this is not a disk read per render: only reload when
        // the file actually changed under us.
        try { await store.reloadIfChanged(); } catch (e) { /* draw stale rather than not at all */ }
        document.querySelectorAll('.markdown-rendered img, .internal-embed img').forEach(img => {
            const host = img.closest('.internal-embed, .image-embed') || img.parentElement;
            if (!host) return;
            let f = null;
            try { f = jccResolveImageFile(this.app, img); } catch (e) { /* ignore */ }
            const n = f ? store.openCount(f.path) : 0;
            if (n > 0) host.setAttribute('data-jcc-ann', String(n));
            else host.removeAttribute('data-jcc-ann');
        });
    }

    async presentActiveNote() {
        const { MarkdownView } = require('obsidian');
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) { new Notice('Open a note to present.'); return; }
        // Resume at the slide the cursor is in, so re-entering after an edit
        // returns the author to where they were rather than to slide 1.
        let startAt = 0;
        try {
            const md0 = view.editor.getValue();
            const line = view.editor.getCursor().line;
            startAt = Math.max(0, md0.split('\n').slice(0, line + 1)
                .filter(l => /^\s*---\s*$/.test(l)).length - 1);
        } catch (e) { /* reading view has no editor; start at 0 */ }
        return this.presentFile(view.file, startAt);
    }

    async presentFile(file, startAt) {
        const md = await this.app.vault.read(file);
        const slides = jccSplitSlides(md);
        if (!slides.length) {
            new Notice('No slides found — separate them with a --- line.');
            return;
        }
        // Keep a reference so the plugin-level key probe can drive it. The probe
        // is the only keydown path the debug log proves fires in this app; every
        // listener registered from inside the modal stayed silent.
        this._liveDeck = new JccPresentModal(this.app, slides, file.path, startAt || 0);
        // Give the modal a way to clear the reference when it closes, so a stale
        // deck cannot be driven by the probe after the presentation ends.
        this._liveDeck._onDispose = () => { this._liveDeck = null; };
        this._liveDeck.open();
        new Notice(`Presenting ${slides.length} slides — jcc present mode`);
    }

    // Fix the stale Bases culture tracker after external edits (Claude Code in the
    // terminal). Two problems are handled: (1) Obsidian's metadata cache doesn't
    // reparse externally-edited notes — a no-op rewrite via vault.process fires
    // 'modify' → reparse; (2) an already-open Bases view does NOT auto-rerender on
    // cache changes — so we force-rebuild the base leaf after the cache settles.
    async refreshCultures(silentOnEmpty = false) {
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith('reagents/'));
        if (!files.length) {
            if (!silentOnEmpty) new Notice('No reagent notes found to refresh.');
            return;
        }
        let n = 0;
        try {
            for (const f of files) {
                if (this.app.vault.process) {
                    await this.app.vault.process(f, data => data);
                } else {
                    await this.app.vault.modify(f, await this.app.vault.read(f));
                }
                n++;
            }
            // Let the metadata cache finish reparsing before we repaint views.
            await new Promise(res => setTimeout(res, 350));

            // Repaint any open Bases view (detected by .base file or 'bases' type).
            let repainted = 0;
            this.app.workspace.iterateAllLeaves(leaf => {
                let st = null;
                try { st = leaf.getViewState(); } catch (e) { return; }
                const file = (st && st.state && st.state.file) || '';
                const type = (st && st.type) || '';
                const isBase = (typeof file === 'string' && file.endsWith('.base')) || type === 'bases';
                if (!isBase) return;
                repainted++;
                if (typeof leaf.rebuildView === 'function') {
                    leaf.rebuildView();
                } else {
                    const saved = leaf.getViewState();
                    leaf.setViewState({ type: 'empty', state: {} })
                        .then(() => leaf.setViewState(saved, { focus: false }));
                }
            });

            // Re-render the JCC panel(s) from the now-fresh cache.
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
                if (leaf.view && typeof leaf.view.render === 'function') await leaf.view.render();
            }
            new Notice(`🔄 Culture tracker refreshed — reparsed ${n} note${n === 1 ? '' : 's'}${repainted ? `, repainted ${repainted} base view${repainted === 1 ? '' : 's'}` : ''}.`);
        } catch (e) {
            new Notice(`Refresh failed: ${e.message}`);
        }
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    }

    async _openView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }
};

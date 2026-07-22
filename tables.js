// Fallback scrollY calculation if the table isn't visible at init time or the
// (Originalverhalten wiederhergestellt: Scrollbereich so groß wie der
//  verfügbare Wrapper-Platz; bei wenigen Zeilen füllt DataTables den Rest mit
//  den Diagonal-Streifen.)
function calcScrollY() {
    const panel = document.querySelector('#mainContent .bulma-panel');
    if (!panel) return 300;
    const tableWrapper = panel.querySelector('.table-wrapper');
    if (!tableWrapper) return 300;
    const wrapperHeight = tableWrapper.getBoundingClientRect().height;
    const thead = tableWrapper.querySelector('thead');
    const theadHeight = thead ? thead.getBoundingClientRect().height : 41;
    const infoEl = tableWrapper.querySelector('.dt-info');
    const infoHeight = infoEl ? infoEl.getBoundingClientRect().height : 20;
    return Math.max(Math.floor(wrapperHeight - theadHeight - infoHeight), 100);
}
// =============================
// FeatureRegistry
// =============================
class FeatureRegistry {

    static registry = {};

    static register(name, feature) {
        this.registry[name] = feature;
    }

    static resolve(name) {
        return this.registry[name];
    }
}

// =============================
// Features
// =============================
FeatureRegistry.register('custombuttons', {
    name: 'custombuttons',

    init(ctx) {
        this.map = ctx.config.buttonsMap || {};
        this.root = document.querySelector(ctx.config.buttonsRoot) || document.body;

        this.handler = (e) => {
            const el = e.target.closest('[data-btn]');
            if (!el) return;

            const action = el.dataset.btn;
            const fn = this.map[action];

            if (typeof fn === 'function') {
                fn(ctx, el, e);
            }
        };

        this.root.addEventListener('click', this.handler);
    },

    destroy() {
        if (this.root && this.handler) {
            this.root.removeEventListener('click', this.handler);
        }

        this.root = null;
        this.handler = null;
        this.map = null;
    }
});

FeatureRegistry.register('reset', {
    name: 'reset',

    init(ctx) {

        this.handler = () => {

            $('#minDate,#maxDate,#customSearch').val('');

            ctx.filterStore?.clear?.();

            ctx.table.search('').columns().search('');

            // Scroller-Tabellen (z. B. events.js): war vorher gescrollt, bleibt
            // der Scroller nach einem reinen draw() an der alten Scroll-Position
            // stehen — er lädt/rendert zwar die Top-Zeilen, positioniert sie aber
            // nicht sichtbar, bis man erneut scrollt ("blank bis zum Scrollen").
            // Nach dem Redraw daher an den Anfang scrollen und den Scroller über
            // ein natives scroll-Event neu positionieren lassen (= für den Nutzer
            // scrollen). one() feuert genau einmal.
            if (ctx.config?.scroller) {
                const container = ctx.table.table().container();
                const body = container && container.querySelector('.dt-scroll-body');
                ctx.table.one('draw', () => {
                    const dt = ctx.table;
                    // Offizielle Scroller-API bevorzugen — sie positioniert an
                    // Zeile 0 und lädt serverseitig das Top-Fenster nach.
                    try {
                        if (dt.scroller && typeof dt.scroller.toPosition === 'function') {
                            dt.scroller.toPosition(0, false);
                            return;
                        }
                    } catch (_) { /* Fallback unten */ }
                    // Fallback: manuell an den Anfang scrollen + Scroller über ein
                    // natives scroll-Event neu positionieren (= für den Nutzer scrollen).
                    if (body) {
                        body.scrollTop = 0;
                        body.dispatchEvent(new Event('scroll'));
                    }
                });
            }
            ctx.table.draw();

        };

        this.$btn = $('[data-reset-table="' + ctx.config.tableSelector + '"]');

        this.$btn
            .off('click.reset')
            .on('click.reset', this.handler);
    },

    destroy() {
        if (this.$btn && this.handler) {
            this.$btn.off('click.reset', this.handler);
        }
        this.$btn = null;
        this.handler = null;
    }
});

FeatureRegistry.register('filters', {
    name: 'filters',

    init(ctx) {
        const filters = new Filters({
            table: ctx.table,
            schema: ctx.config.filters,
            rules: createRulesFromSchema(ctx.config.filters),
            container: '#FilterChips',
            registry: window.filterSourceRegistry,
            serverSide: !!ctx.config.serverSide,
            // serverSide chip sources come from the unfiltered full dataset,
            // fetched once via the controller's allRowsProvider.
            allRowsLoader: ctx.config.serverSide
                ? () => ctx.fetchAllRows({ includeFilters: false })
                : null,
        });

        // Backwards-compat: all three historic references point at the same
        // unified instance so existing external callers keep working.
        ctx.filters = ctx.filterStore = ctx.FilterBridge = filters;

        ctx.config.filters.forEach(f => {
            if (f.type === 'date-range') {

                $(f.from).off('change.filters').on('change.filters', e => {
                    filters.setValue('minDate', e.target.value);
                });

                $(f.to).off('change.filters').on('change.filters', e => {
                    filters.setValue('maxDate', e.target.value);
                });
            }
        });

        // Vordefinierte Filter-Vorauswahl aus den Export-Einstellungen beim
        // Öffnen der Tabelle anwenden. Die Tabelle bleibt Single Source of
        // Truth — der Export exportiert weiterhin die Live-Ansicht; die
        // Vorauswahl setzt nur den Anfangszustand der Chips. Danach kann der
        // Nutzer frei togglen.
        // Nur fuer Tabellen mit Export-Einstellungen (in TABLE_KEY_MAP) eine
        // Vorauswahl laden — sonst wuerde get_export_columns.php fuer
        // unbekannte Tabellen mit 422 antworten (Konsolenfehler).
        const presetKey = (typeof ExportSettings !== 'undefined')
            ? Object.entries(ExportSettings.TABLE_KEY_MAP || {})
                .find(([, v]) => v === ctx.config._name)?.[0]
            : null;
        if (presetKey && typeof ExportSettings.loadConfig === 'function') {
            const settingsKey = presetKey;
            Promise.resolve(ExportSettings.loadConfig(settingsKey))
                .then(cfg => {
                    const preset = cfg?.filters;
                    if (!preset || typeof preset !== 'object') return;
                    const entries = Object.entries(preset)
                        .filter(([, v]) => Array.isArray(v) && v.length);
                    if (!entries.length) return;
                    filters.chipsReady.then(() => {
                        entries.forEach(([col, vals]) => {
                            vals.forEach(v => {
                                if (!filters.has(col, String(v))) filters.set(col, String(v));
                            });
                        });
                    });
                })
                .catch(() => { /* noop — ohne Vorauswahl weiter */ });
        }
    },

    destroy(ctx) {
        ctx.filters?.destroy?.();

        try { delete ctx.filterStore; } catch (e) {}
        try { delete ctx.FilterBridge; } catch (e) {}
        try { delete ctx.filters; } catch (e) {}
    }
});

FeatureRegistry.register('export', {
    name: 'export',

    init(ctx) {

        // Icons den Export-Eintraegen voranstellen (CSV/Excel/PDF). Zentral
        // hier statt im je Tabelle duplizierten Markup, damit es nicht driftet.
        // Idempotent: bereits versehene Eintraege werden uebersprungen.
        const exportMenu = document.getElementById('exportMenu');
        if (exportMenu) {
            const EXPORT_ICONS = { csv: 'file-text', excel: 'file-spreadsheet', pdf: 'file-type' };
            let injected = false;
            exportMenu.querySelectorAll('[data-action]').forEach((item) => {
                const icon = EXPORT_ICONS[item.dataset.action];
                if (!icon || item.querySelector('.export-item-icon')) return;
                const span = document.createElement('span');
                span.className = 'bulma-icon bulma-is-small export-item-icon';
                span.setAttribute('aria-hidden', 'true');
                span.innerHTML = `<i data-lucide="${icon}"></i>`;
                item.insertBefore(span, item.firstChild);
                injected = true;
            });
            if (injected && window.lucide?.createIcons) lucide.createIcons();
        }

        const btn = document.querySelector('[data-target="exportMenu"]');
        if (btn && !btn._bound) {
            btn._bound = true;
            this._btn = btn;
            this._btnHandler = (e) => {
                ctx.dropdown.toggle(
                    document.getElementById('exportMenu'),
                    e.currentTarget
                );
            };

            btn.addEventListener('click', this._btnHandler);
        }

        this.handler = (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;

            const action = el.dataset.action;

            const map = {
                csv: '.buttons-csv',
                excel: '.buttons-excel',
                pdf: '.buttons-pdf'
            };

            const btnSel = map[action];
            if (btnSel) {
                // Only override the default DataTables Buttons behaviour when
                // BOTH serverSide is on AND advancedExport is configured —
                // in that case we fetch the full filtered dataset from the
                // server and run table.js's own export functions over it.
                // Without advancedExport there is no JS export path to use,
                // so fall through to the native button (exports current page).
                if (ctx.config.serverSide && ctx.config.advancedExport) {
                    ctx.exportAll(action);
                } else {
                    ctx.table.button(btnSel).trigger();
                }
            }

            ctx.dropdown.closeAll();
        };

        document.body.addEventListener('click', this.handler);
    },

    destroy() {
        if (this._btn && this._btnHandler) {
            this._btn.removeEventListener('click', this._btnHandler);
            try { this._btn._bound = false; } catch (e) {}
            this._btn = null;
            this._btnHandler = null;
        }

        document.body.removeEventListener('click', this.handler);
        this.handler = null;
    }
});

FeatureRegistry.register('search', {
    name: 'search',

    init(ctx) {
        const input = document.getElementById('customSearch');
        if (input) {
            ctx.searchEngine = new SearchEngine(
                ctx.table,
                input
            );
        }
    },

    destroy(ctx) {
        ctx.searchEngine?.destroy?.();
    }
});

FeatureRegistry.register('colvis', {
    name: 'colvis',

    init(ctx) {
        const btn = document.querySelector('[data-target="colvisMenu"]');
        if (!btn || btn._bound) return;

        btn._bound = true;
        this._btn = btn;

        this.onVisibility = () => {
            ctx._colvis?.sync();
        };

        this._btnHandler = (e) => {
            ctx.dropdown.toggle(
                document.getElementById('colvisMenu'),
                e.currentTarget,
                {
                    onOpen: () => {

                        const menu = document.getElementById('colvisMenu');

                        if (!ctx._colvis) {
                            ctx._colvis = new ColvisComponent(ctx.table, menu);
                        }

                        ctx.table.off('column-visibility.dt', this.onVisibility);
                        ctx.table.on('column-visibility.dt', this.onVisibility);

                        ctx._colvis.sync();
                    }
                }
            );
        };

        btn.addEventListener('click', this._btnHandler);
    },

    destroy(ctx) {
        if (this._btn && this._btnHandler) {
            this._btn.removeEventListener('click', this._btnHandler);
            try { this._btn._bound = false; } catch (e) {}
            this._btn = null;
            this._btnHandler = null;
        }

        ctx.table?.off('column-visibility.dt', this.onVisibility);
        this.onVisibility = null;
    }
});

FeatureRegistry.register('pagination', {
    name: 'pagination',

    init(ctx) {
        const container = document.getElementById('customPagination');
        if (!container) return;

        this.render = () => {

            const table = ctx.table;
            const info = table.page.info();

            const current = info.page;
            const pages = info.pages;

            let pagesHtml = '';

            const range = 2; // wie viele Seiten links/rechts sichtbar

            const start = Math.max(0, current - range);
            const end = Math.min(pages - 1, current + range);

            // erste Seite + ellipsis
            if (start > 0) {
                pagesHtml += this.pageLink(0, current);

                if (start > 1) {
                    pagesHtml += `<li><span class="bulma-pagination-ellipsis">&hellip;</span></li>`;
                }
            }

            // sichtbarer Bereich
            for (let i = start; i <= end; i++) {
                pagesHtml += this.pageLink(i, current);
            }

            // letzte Seite + ellipsis
            if (end < pages - 1) {
                if (end < pages - 2) {
                    pagesHtml += `<li><span class="bulma-pagination-ellipsis">&hellip;</span></li>`;
                }

                pagesHtml += this.pageLink(pages - 1, current);
            }

            container.innerHTML = `
                <nav class="bulma-pagination bulma-is-centered bulma-is-small" role="navigation" aria-label="pagination">

                    <a class="bulma-pagination-previous"
                       ${current === 0 ? 'disabled' : ''}
                       data-action="prev">
                       Zurück
                    </a>

                    <a class="bulma-pagination-next"
                       ${current === pages - 1 ? 'disabled' : ''}
                       data-action="next">
                       Weiter
                    </a>

                    <ul class="bulma-pagination-list">
                        ${pagesHtml}
                    </ul>

                </nav>
            `;
        };

        this.pageLink = (i, current) => {
            return `
                <li>
                    <a class="bulma-pagination-link ${i === current ? 'bulma-is-current' : ''}"
                       data-page="${i}">
                        ${i + 1}
                    </a>
                </li>
            `;
        };

        this.click = (e) => {

            const table = ctx.table;

            const prev = e.target.closest('[data-action="prev"]');
            const next = e.target.closest('[data-action="next"]');
            const page = e.target.closest('[data-page]');

            if (prev) table.page('previous').draw(false);
            if (next) table.page('next').draw(false);

            if (page) {
                table.page(parseInt(page.dataset.page)).draw(false);
            }
        };

        container.addEventListener('click', this.click);

        ctx.table.on('draw.dt', this.render);

        this.render();
    },

    destroy(ctx) {

        const container = document.getElementById('customPagination');
        if (!container) return;

        container.removeEventListener('click', this.click);
        ctx.table?.off('draw.dt', this.render);
    }
});

// =============================
// TableUI
// =============================
class TableUI {

    static tables = {};
    static instances = {};
    static activeInstance = null;
    static activeName = null;

    static register(name, config) {
        config._name = name;
        this.tables[name] = config;
    }

    static async init(name, { force = false } = {}) {
        const config = this.tables[name];
        if (!config) throw new Error(`Table "${name}" not registered`);

        // swallow rapid duplicate force-inits for the same table (≤ 50 ms)
        const now = Date.now();
        if (force && this.activeName === name && this._lastInitAt && (now - this._lastInitAt) < 50) {
            return this.activeInstance;
        }

        if (!force && this.activeName === name && this.activeInstance) {
            return this.activeInstance;
        }

        if (this._initializing === name) return this._pending;

        if (this.activeInstance) {
            this.activeInstance.destroy();
            this.activeInstance = null;
            this.activeName = null;
        }

        const instance = new TableController(config);
        this._initializing = name;
        this._pending = instance;
        try {
            instance.init();
            this.instances[name] = instance;
            this.activeInstance = instance;
            this.activeName = name;
            this._lastInitAt = Date.now();
        } finally {
            this._initializing = null;
            this._pending = null;
        }

        return instance;
    }
}

// Zentrales Filter-Eingabefeld (Suche/Datum) mit Bulma-Icon (has-icons-left).
// Ersetzt das frühere custom .icon-label-Markup und wird von allen Tabellen-
// Modulen genutzt, damit Such-/Datumsfelder überall identisch aussehen.
//   id   – Input-id (z. B. 'customSearch', 'minDate')
//   icon – lucide-Icon-Name (z. B. 'search', 'calendar-arrow-down')
TableUI.filterInput = function ({ id, icon, type = 'text', placeholder = '' }) {
    const ph = placeholder ? ` placeholder="${escapeHtml(String(placeholder))}"` : '';
    return `<div class="date-row bulma-control bulma-has-icons-left">`
        + `<input class="bulma-input bulma-is-small" type="${escapeHtml(String(type))}" id="${escapeHtml(String(id))}"${ph}>`
        + `<span class="bulma-icon bulma-is-small bulma-is-left"><i data-lucide="${escapeHtml(String(icon))}"></i></span>`
        + `</div>`;
};

TableUI.theme = {

    badge(type) {
        const map = {
            success: 'badge success',
            warning: 'badge warning',
            danger: 'badge danger',
            info: 'badge info'
        };

        return map[type] || 'badge';
    },

    // Status-Tag in einer beliebigen Farbe (heller Tint, neutrale Schrift) —
    // gleicher Look wie die Filter-Chips. KEINE Farben hier fest verdrahtet.
    colorBadge(label, color) {
        const c = (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) ? color : '#8c8c8c';
        return `<span class="badge badge-chip" style="--chip-color:${escapeHtml(c)}">${escapeHtml(String(label))}</span>`;
    },

    // Steuert, ob Status-Tags in den Tabellen als farbiger Tag oder nur als
    // reiner Text gezeigt werden — UNABHÄNGIG von den Filter-Chips (die über die
    // `filters`-Definition gesteuert werden). Globaler Standard; pro Tabelle über
    // optionBadge(..., { showTag:false }) überschreibbar.
    showTags: true,

    // Status-Tag, dessen Farbe aus DENSELBEN (Filter-)Optionen der Tabelle kommt
    // wie die Chips (value/label/color). So sind Chips UND Tags aus EINER Quelle
    // gefärbt (in der Tabellen-Definition, nicht hier). `label` optional — sonst
    // das Label der Option. `cfg.showTag` überschreibt pro Aufruf den globalen
    // Schalter (false -> nur Text, kein Tag).
    optionBadge(options, value, label, cfg) {
        const opt = (options || []).find(o => String(o.value) === String(value));
        const text = label != null ? label : (opt ? opt.label : value);
        const show = (cfg && cfg.showTag != null) ? cfg.showTag : this.showTags;
        if (show === false) return escapeHtml(String(text));
        return this.colorBadge(text, opt && opt.color);
    },

    // Tag mit der Kassenfarbe — gleicher Stil wie Chips/Status-Tags: heller
    // Farb-Tint, neutrale (nicht farbige) Schrift. Ohne gültige Farbe neutral.
    kasseBadge(name, color) {
        const label = escapeHtml(name != null && name !== '' ? String(name) : '–');
        const c = (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : null;
        if (!c) return `<span class="badge muted">${label}</span>`;
        return `<span class="badge badge-chip" style="--chip-color:${c}">${label}</span>`;
    },

    money(value) {
        if (value === null || value === undefined || value === '') return '';

        const num = Number(value);

        if (isNaN(num)) return value; // ← wichtig für Text!

        return new Intl.NumberFormat('de-CH', {
            style: 'currency',
            currency: window.APP_CURRENCY || 'CHF',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(num);
    }
};

// =============================
// Filters — unified filter state + bridge + chip UI
// =============================
//
// Merges the historic FilterStore / FilterBridge / FilterSystem trio into a
// single object. Backwards-compatible with the old API:
//   - `setValue(col, v)` / `set(col, v)` / `toggle(col, v)` / `get(col)` /
//     `has(col, v)` / `clear(col?)` / `subscribe` / `unsubscribe` / `toParams`
//   - `renderState()` is still called by anyone that used to call it; now
//     also runs automatically on every state change.
//
// One internal representation: every column stores a `Set<string>`. Single-
// value columns are just a Set with 0 or 1 entry. This fixes the old bug
// where `setValue` stored a scalar and `get()` ran `Array.from()` over it.
class Filters {
    constructor({
        table = null,
        schema = [],
        rules = [],
        container = null,
        registry = null,
        serverSide = false,
        allRowsLoader = null,
    } = {}) {
        this.table         = table;
        this.schema        = schema;
        this.rules         = rules;
        this.container     = container ? $(container) : null;
        this.registry      = registry;
        this.serverSide    = !!serverSide;
        this.allRowsLoader = allRowsLoader;

        this.state     = new Map();    // Map<column, Set<string>>
        this.listeners = new Set();

        this._pending         = false;
        this._boundTable      = null;
        this._chipClickBound  = false;
        this._xhrHandler      = null;

        // Resolves the first time _renderChips() actually paints the chip
        // strip. TableController.init() awaits this before flipping the
        // ready-promise, so the loader overlay stays up until chips have
        // rendered AND the post-chip scrollY recompute has happened — no
        // visible table-height jump after the spinner hides. If the
        // schema has no source-derived chips at all there's nothing to
        // wait for, so resolve immediately.
        this.chipsReady = new Promise(resolve => {
            this._resolveChipsReady = resolve;
        });
        const hasSources = (this.schema || []).some(f => f.source);
        if (!hasSources) {
            this._resolveChipsReady();
            this._resolveChipsReady = null;
        }

        this._registerClientSideFilter();
        this._bindChipClicks();
        this._bindTableSource();
        this._onChange = () => this._scheduleSync();
        this.subscribe(this._onChange);
    }

    // ---------- state API ----------

    // Overwrite column with a single value (or clear it when empty).
    setValue(column, value) {
        if (value === null || value === undefined || value === '') {
            this.state.delete(column);
        } else {
            this.state.set(column, new Set([String(value)]));
        }
        this.emit();
    }

    // Toggle a value in/out of the column's Set.
    set(column, value) {
        const v = String(value);
        if (!this.state.has(column)) this.state.set(column, new Set());
        const s = this.state.get(column);
        if (s.has(v)) s.delete(v); else s.add(v);
        if (!s.size) this.state.delete(column);
        this.emit();
    }
    toggle(column, value) { this.set(column, value); }

    get(column) {
        return Array.from(this.state.get(column) || []);
    }

    has(column, value) {
        return this.state.get(column)?.has(String(value)) || false;
    }

    clear(column = null) {
        if (column) this.state.delete(column);
        else this.state.clear();
        this.emit();
    }

    subscribe(fn)   { this.listeners.add(fn); }
    unsubscribe(fn) { this.listeners.delete(fn); }
    emit()          { this.listeners.forEach(fn => fn(this)); }

    // Serialises the current filter state for the server ajax payload.
    // Every column becomes an array; empty columns are omitted.
    toParams() {
        const out = {};
        for (const [col, set] of this.state.entries()) {
            if (!set || !set.size) continue;
            const arr = Array.from(set);
            // Convenience: columns with a single value are flattened to a
            // scalar so backends can handle them without an `is_array` check.
            out[col] = arr.length === 1 ? arr[0] : arr;
        }
        return out;
    }

    // ---------- bridge: client-side ext.search + draw scheduling ----------

    _registerClientSideFilter() {
        if (this.serverSide) return;

        // _globalFn matches instances per ROW on every draw; cache the
        // table's root node here because table().node() constructs a
        // fresh DataTables API object on every call.
        this._tableNode = this.table?.table?.().node?.() ?? null;

        if (!Filters._registered) {
            Filters._instances = [];
            Filters._globalFn  = (settings, data, index, rowData) => {
                const inst = Filters._instances.find(
                    i => i._tableNode === settings.nTable
                );
                if (!inst) return true;
                return inst.rules.every(r => r(rowData, inst));
            };
            $.fn.dataTable.ext.search.push(Filters._globalFn);
            Filters._registered = true;
        }
        Filters._instances.push(this);
    }

    _scheduleSync() {
        if (this._pending) return;
        this._pending = true;
        requestAnimationFrame(() => {
            this._pending = false;
            // Keep chip highlights in sync with the store.
            this._renderChipState();
            // Trigger a redraw. In client-side mode this re-runs ext.search;
            // in serverSide mode it fires a fresh ajax with the new filter
            // params in the body.
            if (!this.table) return;
            if (this.table.settings()[0]._bAjaxDataGet) return;
            this.table.page('first').draw(false);
        });
    }

    // Back-compat: old callers sometimes call renderState() directly.
    renderState() { this._renderChipState(); }

    // ---------- chip UI ----------

    _bindChipClicks() {
        if (!this.container || this._chipClickBound) return;
        this._chipClickBound = true;
        this.container.on('click.filters', '.filter-chip', (e) => {
            const el = $(e.currentTarget);
            this.toggle(el.data('column'), String(el.data('value')));
        });
    }

    _bindTableSource() {
        if (!this.container || !this.schema?.length) return;

        const renderFromRows = (rows) => {
            if (!rows) return;
            const sources = {};
            for (const f of this.schema) {
                if (!f.source) continue;
                let resolved = this.registry?.resolve(f.source, rows, this);

                if (!resolved || resolved.length === 0 ) {
                    resolved = autoResolve(f.source, rows);
                }

                sources[f.source] = resolved;
            }
            this._renderChips(sources);
        };

        if (this.serverSide && typeof this.allRowsLoader === 'function') {
            // chips built once from the unfiltered full dataset
            Promise.resolve(this.allRowsLoader())
                .then(rows => renderFromRows(rows || []))
                .catch(err => {
                    if (err?.name === 'AbortError') return;
                    console.error('Chip source load failed', err);
                    // Unblock chipsReady waiters even on failure so the
                    // table loader doesn't hang forever.
                    this._resolveChipsReady?.();
                    this._resolveChipsReady = null;
                });
            return;
        }

        // client-side: derive chip sources from the in-memory ajax response
        this._boundTable = this.table;
        this._xhrHandler = (e, settings, json) => {
            if (!json?.data) return;
            renderFromRows(json.data);
        };
        this.table.on('xhr.dt', this._xhrHandler);

        const data = this.table.ajax?.json?.();
        if (data?.data) renderFromRows(data.data);
    }

    _renderChips(sources = {}) {
        if (!this.container) return;

        // Drop chips where the schema's `value()` produced nothing usable.
        // Catches: (a) source-derived rows with no kasse/paymenttype/... ,
        // (b) options-derived schemas that include a `null` placeholder,
        // (c) backends that return the literal string "null" (PDO + nullable
        // columns when concatenated server-side).
        const isMeaningful = c =>
            c.value != null &&
            c.value !== '' &&
            String(c.value).toLowerCase() !== 'null';

        const chips = [];
        for (const f of this.schema) {
            if (f.source) {
                const data = sources[f.source] || [];
                chips.push(...data
                    .map(item => ({
                        column: f.column,
                        value:  f.value(item),
                        label:  f.label(item),
                        color:  f.color(item),
                    }))
                    .filter(isMeaningful)
                );
            }
            if (f.options) {
                chips.push(...f.options
                    .map(o => ({
                        column: f.column,
                        value:  o.value,
                        label:  o.label,
                        color:  o.color,
                    }))
                    .filter(isMeaningful)
                );
            }
        }

        // escapeHtml on every interpolation: labels/values come from DB
        // content (Kassen-/Zahlungsart-Namen) and must not inject HTML.
        // Styling wie die Produktgruppen-Chips der Auswertung: Pille mit
        // integriertem Farbpunkt, Aktiv-/Inaktiv-Zustand über die Klasse
        // `selected` (kein Inline-Styling). --chip-color je Chip gesetzt.
        this.container.html(
            chips.map(c => {
                const color = String(c.color ?? '') || '#888888';
                return `<span class="filter-chip filter-chip--dot"`
                    + ` style="--chip-color:${escapeHtml(color)}"`
                    + ` data-column="${escapeHtml(String(c.column))}"`
                    + ` data-value="${escapeHtml(String(c.value))}"`
                    + ` data-color="${escapeHtml(String(c.color ?? ''))}">`
                    + `<span class="filter-chip-dot"></span>`
                    + `${escapeHtml(String(c.label))}</span>`;
            }).join('')
        );

        this._renderChipState();

        // Two dispatches because mixed listeners exist in the codebase:
        //   - jQuery .trigger() reaches $(this.container).on(...) handlers
        //   - native dispatchEvent() reaches document.addEventListener(...)
        //     listeners (e.g. _setupAutoScrollY's scrollY recompute).
        // jQuery's .trigger() does NOT cross the bridge into native
        // listeners, so the recompute path was previously dead.
        this.container.trigger('filters:rendered');
        const el = this.container[0];
        if (el) {
            el.dispatchEvent(new CustomEvent('filters:rendered', { bubbles: true }));
        }

        this._resolveChipsReady?.();
        this._resolveChipsReady = null;
    }

    _renderChipState() {
        if (!this.container) return;
        // Farbe/Zustand kommen aus CSS (--chip-color + Klasse `selected`),
        // daher hier nur noch die Klasse umschalten.
        this.container.find('.filter-chip').each((_, el) => {
            const $el  = $(el);
            const active = this.has($el.data('column'), String($el.data('value')));
            $el.toggleClass('selected', active);
        });
    }

    // ---------- lifecycle ----------

    destroy() {
        // Unblock anyone awaiting chipsReady (e.g. TableController.init.dt
        // gating on it) so a destroy that races chip-loading doesn't
        // hang the loader overlay.
        this._resolveChipsReady?.();
        this._resolveChipsReady = null;

        this.unsubscribe(this._onChange);

        if (!this.serverSide && Filters._registered) {
            Filters._instances = Filters._instances.filter(i => i !== this);
            if (Filters._instances.length === 0 && Filters._globalFn) {
                const idx = $.fn.dataTable.ext.search.indexOf(Filters._globalFn);
                if (idx > -1) $.fn.dataTable.ext.search.splice(idx, 1);
                Filters._registered = false;
                Filters._globalFn = null;
            }
        }

        if (this.container && this._chipClickBound) {
            this.container.off('click.filters', '.filter-chip');
            this._chipClickBound = false;
        }

        if (this._boundTable && this._xhrHandler) {
            this._boundTable.off('xhr.dt', this._xhrHandler);
            this._xhrHandler = null;
            this._boundTable = null;
        }

        this.state.clear();
        this.listeners.clear();
        this.table = null;
    }
}


FeatureRegistry.register('advancedExport', {
    name: 'advancedExport',

    async init(ctx) {

        const cfg = ctx.config.advancedExport;
        if (!cfg) return;

        if (typeof ExportSettings !== 'undefined') {
            // Nur fuer Tabellen mit Export-Einstellungen (in TABLE_KEY_MAP),
            // sonst antwortet get_export_columns.php mit 422.
            const settingsKey = Object.entries(ExportSettings.TABLE_KEY_MAP || {})
                .find(([, v]) => v === ctx.config._name)?.[0];
            if (settingsKey) {
                ctx._exportSettingsKey = settingsKey;
                try {
                    const saved = await ExportSettings.loadConfig(settingsKey);
                    ExportSettings.applyExportSettings(settingsKey, saved);
                } catch (_) { /* noop */ }
            }
        }

        ctx._advancedExport = {
            run: async (type, allRows = null) => {

                // Per-run copy of the shared config: per-format overrides
                // (extra columns, column selection, colour) apply to this
                // run only, so concurrent exports or a throwing exporter
                // can never leave patched state on the registered config.
                const runCfg = { ...cfg };

                if (cfg._perFormatExtras?.[type]) {
                    runCfg.extraColumns = cfg._perFormatExtras[type];
                }

                const colOverride = cfg._perFormatColumns?.[type];
                if (colOverride) {
                    // Spalten auf die gespeicherte Liste filtern
                    runCfg._activeColumnKeys = colOverride;
                } else {
                    delete runCfg._activeColumnKeys;
                }

                if (cfg._colorOverride) {
                    runCfg.excelAlpha = cfg._colorOverride.excelAlpha ?? 0;
                    runCfg.pdfAlpha   = cfg._colorOverride.pdfAlpha   ?? 0;
                }

                // Export-Einstellungen: per-format Auswahl dynamischer
                // Spalten ({ source: [keys] } | null = alle). Gesetzt von
                // ExportSettings.applyExportSettings, gefiltert in
                // buildExportData.
                runCfg._activeDynamicKeys = cfg._perFormatDynamic?.[type] ?? null;

                // PDF-Schriftgrösse (nur PDF relevant) aus den Export-
                // Einstellungen an den PDF-Builder durchreichen.
                runCfg._pdfFontSize = cfg._perFormatPdfFontSize?.[type] ?? 'normal';

                // "Leere Spalten erzeugen" (pro Format): bei aktivem Switch
                // das volle Key-Universum laden (alle möglichen dynamischen
                // Spalten), damit buildExportData auch leere Spalten erzeugt.
                runCfg._dynamicIncludeEmpty = !!(cfg._perFormatDynamicEmpty?.[type]);
                if (runCfg._dynamicIncludeEmpty
                    && ctx._exportSettingsKey
                    && typeof ExportSettings !== 'undefined'
                ) {
                    const def = ExportSettings.TABLE_DEFS?.[ctx._exportSettingsKey];
                    // Universum je Quelle laden (group_payment_stats,
                    // group_quantities, …) — pro Quelle die eigenen Keys.
                    const sources = (def?.dynamic?.sources
                        ?? (def?.dynamic?.loadKeys ? [def.dynamic] : []))
                        .filter(d => d && typeof d.loadKeys === 'function');
                    const universe = {};
                    for (const d of sources) {
                        try {
                            const keys = await d.loadKeys();
                            if (Array.isArray(keys)) universe[d.source] = keys;
                        } catch (_) { /* noop — degradiert auf Daten-Keys */ }
                    }
                    if (Object.keys(universe).length) {
                        runCfg._dynamicKeyUniverse = universe;
                    }
                }

                // Resolve the effective rowset for the export:
                // - If `allRows` was explicitly provided, use it.
                // - In serverSide mode fetch the full filtered dataset from
                //   the server so exports respect the current chips/filters.
                // - In client-side mode read the currently-applied filtered
                //   rows directly from the live DataTable (most robust).
                let effectiveRows = allRows;
                if (!effectiveRows) {
                    if (ctx.config?.serverSide) {
                        try {
                            effectiveRows = await ctx.fetchAllRows({ includeFilters: true }).catch(() => null);
                        } catch (_) { effectiveRows = null; }
                    } else {
                        try {
                            effectiveRows = ctx.table
                                .rows({ search: 'applied', order: 'applied' })
                                .data()
                                .toArray();
                        } catch (_) {
                            effectiveRows = null;
                        }
                    }
                }

                const { header, body, totals, dynamicKeys, dynamicDefs, columnsCount, columns, extraRange, extraColumns } =
                    buildExportData(ctx, runCfg, effectiveRows);

                // attach company settings (cached) so filename prefixing works
                let company = {};
                try {
                    company = await fetchCompanySettingsCached();
                } catch (_) { /* noop */ }

                const enrichedCfg = {
                    ...runCfg,
                    _filters:      ctx.filterStore?.toParams?.() || {},
                    _columns:      columns,
                    _extraRange:   extraRange,
                    _extraColumns: extraColumns,
                    _dynamicColumns: dynamicDefs || [],
                    _totals:       totals || null,
                    _company:      company || {}
                };

                if (type === 'excel') {
                    exportExcel(header, body, dynamicKeys, columnsCount, enrichedCfg);
                }
                if (type === 'csv') {
                    exportCSV(header, body, dynamicKeys, columnsCount, enrichedCfg);
                }
                if (type === 'pdf') {
                    exportPDF(header, body, dynamicKeys, columnsCount, enrichedCfg);
                }
            }
        };
    },

    destroy(ctx) {
        if (ctx._advancedExport) {
            delete ctx._advancedExport;
        }
    }
});



// =============================
// Search ENGINE
// =============================
class SearchEngine {
    constructor(table, input) {
        this.table = table;

        const debounced = debounce((val) => {
            this.table.search(val).draw(false);
        }, 300);

        this.handler = (e) => debounced(e.target.value);

        input.addEventListener('input', this.handler);

        this.destroy = () => {
            input.removeEventListener('input', this.handler);
        };
    }
}

// =============================
// DROPDOWN ENGINE — app-wide singleton
// =============================
//
// The DOM has a single viewport and (by our UX convention) at most one open
// menu at a time, so the engine is a singleton: one set of global listeners
// regardless of how many TableControllers are alive. Per-controller use
// simply holds a reference to the shared instance.
//
// Responsibilities:
//   - open / close / toggle a menu positioned next to a trigger button
//   - close on outside click, Escape, scroll (capture phase, passive)
//   - reposition on resize
//   - portal the menu to <body> on open and restore its original parent on
//     close, so CSS/jQuery bindings anchored to the original ancestor keep
//     working between openings
//
// Convention: trigger buttons carry `[data-target]`; menus carry
// `.dropdown-menu` and are flagged `.open` while visible.
class DropdownEngine {
    constructor() {
        this.activeMenu    = null;
        this.activeTrigger = null;
        this._origParent   = null;   // remember where the menu lived before we portalled it
        this._origNextSib  = null;

        this._click  = this._handleClick.bind(this);
        this._key    = this._handleKey.bind(this);
        this._resize = this._reposition.bind(this);
        this._scroll = this._handleScroll.bind(this);

        document.addEventListener('click', this._click);
        document.addEventListener('keydown', this._key);
        window.addEventListener('resize', this._resize);
        // capture phase so we catch scrolls on any ancestor;
        // passive so we don't block scrolling.
        window.addEventListener('scroll', this._scroll, { capture: true, passive: true });
    }

    _handleClick(e) {
        if (!this.activeMenu) return;
        const onMenu = e.target.closest('.dropdown-menu.open');
        const onBtn  = e.target.closest('[data-target]');
        if (!onMenu && !onBtn) this.closeAll();
    }

    _handleKey(e) {
        if (e.key === 'Escape') this.closeAll();
    }

    _handleScroll() {
        // Close on scroll rather than chase the trigger — simpler + fewer
        // layout thrash issues than recomputing position on every frame.
        this.closeAll();
    }

    toggle(menu, button, options = {}) {
        if (!menu || !button) return;

        if (this.activeMenu && this.activeMenu !== menu) this.close(this.activeMenu);

        if (menu.classList.contains('open')) { this.close(menu); return; }

        this.open(menu, button);
        requestAnimationFrame(() => options.onOpen?.());
    }

    open(menu, button) {
        // portal to body, remembering where it came from
        this._origParent  = menu.parentNode;
        this._origNextSib = menu.nextSibling;
        document.body.appendChild(menu);

        menu.classList.add('open');
        menu.style.position = 'fixed';

        this.activeMenu    = menu;
        this.activeTrigger = button;
        this._position(menu, button);
    }

    close(menu) {
        if (!menu) return;
        menu.classList.remove('open', 'top', 'right');

        // restore to original DOM location so css + delegated handlers on the
        // original ancestor keep working next time the menu opens.
        if (this._origParent) {
            this._origParent.insertBefore(menu, this._origNextSib || null);
        }

        // Notify consumers that this menu just closed — every closure path
        // (toggle, outside-click, Escape, scroll, another menu opening) goes
        // through here, so a single event covers them all. Used by
        // wireKasseDropdown to keep aria-expanded in sync on the trigger.
        menu.dispatchEvent(new CustomEvent('dropdown:close', { bubbles: true }));

        this.activeMenu    = null;
        this.activeTrigger = null;
        this._origParent   = null;
        this._origNextSib  = null;
    }

    closeAll() {
        if (this.activeMenu) this.close(this.activeMenu);
    }

    _position(menu, button) {
        const M    = 8;                       // Mindestabstand zu jedem Viewport-Rand
        const rect = button.getBoundingClientRect();
        const vw   = window.innerWidth;
        const vh   = window.innerHeight;

        menu.style.zIndex = 99999;

        // The engine drives position purely via inline top/left on a fixed box.
        // Neutralise any bottom/right the flip CSS (.dropdown-menu.top) sets —
        // otherwise an inline `top` + the class's `bottom: calc(100% + 6px)`
        // both apply, the fixed box gets stretched between them and collapses
        // to ~0 height (Items sichtbar, aber Hintergrund/Rahmen auf 0-Hoehe
        // → "kein Hintergrund"). maxHeight/overflow werden weiter unten je nach
        // Platz neu gesetzt, hier erst zuruecksetzen, damit die Messung stimmt.
        menu.style.bottom    = 'auto';
        menu.style.right     = 'auto';
        menu.style.maxHeight = 'none';
        menu.style.overflowY = '';

        const menuWidth  = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;

        // Horizontal: linksbuendig zum Trigger; reicht der Platz rechts nicht,
        // rechtsbuendig kippen. Danach IMMER in den Viewport klemmen (mit
        // Rand), damit das Menue nie am Bildschirmrand klebt oder abgeschnitten
        // wird (Action-Spalte sitzt ganz rechts → vorher Rand-kleben).
        let left = rect.left;
        if (left + menuWidth > vw - M) left = rect.right - menuWidth;
        left = Math.min(left, vw - menuWidth - M);
        left = Math.max(left, M);
        menu.style.left = `${left}px`;

        // Vertikal: unter den Trigger; passt es nicht, nach oben kippen — sonst
        // auf die Seite mit mehr Platz. Reicht auch dort die Hoehe nicht, Hoehe
        // deckeln und das Menue intern scrollen lassen, statt es vom Viewport
        // schieben zu lassen (halb sichtbare letzte Zeile).
        const below = vh - rect.bottom - M;
        const above = rect.top - M;
        let top, flipped;
        if (menuHeight <= below || below >= above) {
            flipped = false;
            top = rect.bottom;
            if (menuHeight > below) { menu.style.maxHeight = `${below}px`; menu.style.overflowY = 'auto'; }
        } else {
            flipped = true;
            const h = Math.min(menuHeight, above);
            top = rect.top - h;
            if (menuHeight > above) { menu.style.maxHeight = `${above}px`; menu.style.overflowY = 'auto'; }
        }
        top = Math.max(top, M);
        menu.style.top = `${top}px`;

        menu.classList.toggle('top',   flipped);
        menu.classList.toggle('right', left !== rect.left);
    }

    _reposition() {
        if (this.activeMenu && this.activeTrigger) {
            this._position(this.activeMenu, this.activeTrigger);
        }
    }

    // Tear down the singleton. In practice the app only calls this on full
    // page unload (e.g. SPA teardown); TableController.destroy() does NOT
    // call it, since other controllers may still need the dropdown.
    destroy() {
        document.removeEventListener('click', this._click);
        document.removeEventListener('keydown', this._key);
        window.removeEventListener('resize', this._resize);
        window.removeEventListener('scroll', this._scroll, { capture: true });
        this.closeAll();
    }
}

// Shared instance — every TableController references this rather than
// instantiating its own engine.
const Dropdown = new DropdownEngine();

// =============================
// TABLE CONTROLLER
// =============================
class TableController {
    constructor(config) {
        this.config = config;
        this.table = null;

        // Client-side mode uses dataProvider to fetch + cache the full dataset
        // once. In serverSide mode it is unused (the ajax function builds its
        // own request each draw).
        this.dataProvider = new TableDataProvider(
            (opts) => (config.dataLoader ? config.dataLoader(opts) : Promise.resolve([]))
        );

        // serverSide mode: a second provider dedicates itself to the
        // "give me the entire (optionally filtered) dataset" endpoint used
        // by chip sources and JS exports. Cache is keyed by the filter hash
        // so switching filters re-fetches, but two simultaneous calls with
        // the same filters share one in-flight request.
        this.allRowsProvider = new TableDataProvider(
            (opts) => {
                if (typeof config.allRowsLoader === 'function') {
                    return config.allRowsLoader(opts);
                }
                return Promise.resolve([]);
            }
        );

        // shared singleton (see DROPDOWN ENGINE section);
        // no per-controller lifecycle to manage.
        this.dropdown = Dropdown;

        this._bound = false;
        this._actionHandler = null;
    }

    // Fetches the entire filtered (or unfiltered) dataset from the server.
    // Used in serverSide mode for chip sources and JS exports. In client-side
    // mode falls back to the cached dataProvider data.
    async fetchAllRows({ includeFilters = true, force = false, signal } = {}) {
        if (!this.config.serverSide) {
            // Client-side already has everything in memory.
            return this.dataProvider.fetch({ force });
        }

        const filters = includeFilters
            ? (this.filterStore?.toParams?.() || {})
            : {};

        // Bypass the simple cache when the filter payload differs from the
        // last request. Cheapest correctness: invalidate on every call.
        const key = JSON.stringify(filters);
        if (this._allRowsKey !== key) {
            this.allRowsProvider.invalidate();
            this._allRowsKey = key;
        }

        return this.allRowsProvider.fetch({
            force,
            // TableDataProvider ignores extra opts but passes them through,
            // so the user-supplied allRowsLoader receives filters + signal.
            _passthrough: { filters, signal }
        }).then(rows => rows || []);
    }

    // Runs the JS export functions (exportCSV / exportExcel / exportPDF)
    // against the full filtered dataset instead of the current page. Only
    // used in serverSide mode; client-side already has every row cached in
    // the live DataTable so the existing advancedExport path sees them all.
    async exportAll(type) {
        try {
            const rows = await this.fetchAllRows({ includeFilters: true });
            // _advancedExport.run() wendet alle Patches (perFormatExtras,
            // colorOverride etc.) korrekt an.
            await this._advancedExport?.run(type, rows);
        } catch (err) {
            if (err?.name === 'AbortError') return;
            console.error('exportAll failed', err);
        }
    }

    async init() {
        if (this._initialized) return;
        this._initialized = true;
        // Resolves once init.dt has fired AND the first ajax response
        // has been rendered. Callers (loadXTable) await this before
        // hiding the global page loader so the spinner stays on screen
        // until the table is fully populated.
        this.ready = new Promise((resolve) => { this._resolveReady = resolve; });
        this.render();
        await yieldToBrowser();
        this._scrollY = calcScrollY();

        // ── ExportSettings vor DataTable-Init laden ───────────────────────
        // Nur fuer Tabellen mit Export-Einstellungen (in TABLE_KEY_MAP),
        // sonst antwortet get_export_columns.php mit 422.
        if (typeof ExportSettings !== 'undefined' && this.config.advancedExport) {
            const name      = this.config._name ?? '';
            const exportKey = Object.entries(ExportSettings.TABLE_KEY_MAP || {})
                .find(([, v]) => v === name)?.[0];
            if (exportKey) {
                try {
                    const cfg = await ExportSettings.loadConfig(exportKey);
                    ExportSettings.applyExportSettings(exportKey, cfg);
                } catch (_) {}
            }
        }
        // ─────────────────────────────────────────────────────────────────

        this.initTable();
        this.bindCore();
        this.bindResizeEvents();
    }

    render() {
        $('#mainContent').html(TableUI.templates[this.config.template]());
    }

    renderIcons(root = document) {
        if (!window.lucide) return;

        window.lucide.createIcons({
            root
        });
    }

    initTable() {
        if ($.fn.DataTable.isDataTable(this.config.tableSelector)) {
            $(this.config.tableSelector).DataTable().destroy();
            $(this.config.tableSelector).empty();
        }
        const ctx = this;
        const serverSide = !!this.config.serverSide;

        const ajaxFn = serverSide
            ? (data, cb /*, settings */) => {
                // DataTables hands us its native params object (draw, start,
                // length, search, order, columns). We merge in our custom
                // filter state from FilterStore as an extra `filters` field
                // and POST the whole payload. The server replies with the
                // standard { draw, recordsTotal, recordsFiltered, data } shape.
                const body = {
                    ...data,
                    filters: this.filterStore?.toParams?.() || {}
                };

                if (this._mainRequest) this._mainRequest.abort();
                this._mainRequest = new AbortController();

                const url = this.config.dataUrl || '';
                const loader = typeof this.config.dataLoader === 'function'
                    ? this.config.dataLoader
                    : (opts) => apiFetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(opts.body),
                        signal: opts.signal
                      }).then(r => r.json());

                Promise.resolve(loader({ body, signal: this._mainRequest.signal }))
                    .then(j => cb({
                        draw: data.draw,
                        recordsTotal: j.recordsTotal ?? (j.data?.length || 0),
                        recordsFiltered: j.recordsFiltered ?? (j.data?.length || 0),
                        data: j.data || []
                    }))
                    .catch(err => {
                        if (err?.name === 'AbortError') return;
                        console.error('Data load failed', err);
                        cb({ draw: data.draw, recordsTotal: 0, recordsFiltered: 0, data: [] });
                    });
            }
            : (data, cb) => {
                this.dataProvider.fetch({ force: false })
                    .then(rows => cb({ data: rows || [] }))
                    .catch(err => {
                        if (err?.name === 'AbortError') return;
                        console.error('Data load failed', err);
                        cb({ data: [] });
                    });
            };
        
        const columns = applyTagColumns(this.config.columns(this), this.config.filters);

        this.table = $(this.config.tableSelector).DataTable({
            buttons: [],
            serverSide,
            dom: 'rti',
            responsive: true,
            scrollY: this._scrollY || 300,
            scrollCollapse: true,
            processing: this.config.processing || false,
            scroller: this.config.scroller || false,
            paging: this.config.paging || false,
            // Default order only when the table actually has a 4th column.
            order: this.config.order ?? (columns.length > 3 ? [[3, 'desc']] : []),
            autoWidth: false,
            fixedHeader: this.config.fixedHeader || false,
            // `??` — `|| true` would force deferRender on for every table.
            deferRender: this.config.deferRender ?? true,
            language: {
              lengthMenu: "_MENU_ Einträge",
              zeroRecords: "Keine Einträge gefunden",
              info: "_START_ - _END_ / _TOTAL_ Einträgen",
              infoEmpty: "0 - 0 / 0 Einträgen",
              infoFiltered: "(_MAX_ gefiltert)",
              search: "Suchen:",
              loadingRecords: "Lade...",
              processing: svgspinnerCenter,
              emptyTable: "Keine Daten vorhanden"
            },

            ajax: ajaxFn,
            columns,
            createdRow: this.config.createdRow || (() => {}),
            pageLength: this.config.pageLength || null
        });
        this._setupAutoScrollY();
        this._setupInfoRow();
        this.table._ctx = this;

        this.table.on('init.dt', async () => {

            this.table._ctx = this;

            // Native DataTables buttons are only triggered through the
            // export feature's non-advanced path (table.button().trigger());
            // serverSide+advancedExport goes through ctx.exportAll instead,
            // so skip building the button set (and its DOM) there.
            const features = this.config.features || [];
            if (features.includes('export') && !(serverSide && this.config.advancedExport)) {
                new $.fn.dataTable.Buttons(this.table, {
                    buttons: buildExportButtons(this.table)
                });
            }

            this.recalc();
            this.config.onInit?.(this);
            this._injectMobileFilterToggle();

            await this.initFeatures();

            // Signal external waiters (loadXTable) that the table is
            // fully built and the first ajax payload has been rendered,
            // so the global page loader can be hidden. Wait until chips
            // have actually painted (Filters.chipsReady) so that the
            // post-chip scrollY recompute fires before the overlay
            // hides — otherwise the user briefly sees the table at the
            // wrong height and then a layout jump.
            const chipsReady = this.filters?.chipsReady || Promise.resolve();
            chipsReady.then(() => {
                // Timing-Fix: der in init() berechnete scrollY entsteht oft,
                // BEVOR das Flex-/100dvh-Layout final gesettlet ist (v.a. auf
                // Mobile, wo der Filterblock eingeklappt ist und 'filters:
                // rendered' keine relevante Umlayoutung ausloest). Dann bleibt
                // der Scrollbody zu klein (Diagonal-Streifen enden vor dem
                // Kartenrand) bis ein spaeteres Relayout (z.B. Filter auf/zu)
                // greift. Daher hier nach dem naechsten Reflow (doppeltes rAF)
                // neu messen — noch BEVOR der Loader ausgeblendet wird, sodass
                // kein sichtbarer Sprung entsteht.
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    this.applyScrollY();
                    this._resolveReady?.();
                    this._resolveReady = null;
                }));
                // Sicherheitsnetz: das Nachsettlen der mobilen Browserleiste
                // (100dvh aendert sich, wenn die URL-Bar ein-/ausblendet) feuert
                // u.U. erst nach dem Ausblenden des Loaders — daher ein spaeter
                // Recalc. applyScrollY ist no-op, wenn sich nichts geaendert hat.
                setTimeout(() => this.applyScrollY(), 350);
            });

            requestAnimationFrame(() => {
                this.renderState();
                this.renderIcons();
                     
            });
        });
        
        
        this.table.on('draw.dt', () => {
            this.renderIcons(this.table.table().node()); // scoped
        
        });

    }
    _setupAutoScrollY() {
        let raf1 = null;
        let raf2 = null;

        const schedule = () => {
            if (raf1) cancelAnimationFrame(raf1);
            if (raf2) cancelAnimationFrame(raf2);
            raf1 = requestAnimationFrame(() => {
                raf2 = requestAnimationFrame(() => {
                    if (!this.table || !document.body.contains(this.table.table().node())) return;
                    this.applyScrollY();
                });
            });
        };

        document.addEventListener('filters:rendered', schedule);
        this.table.on('draw.dt', schedule);
        this.table.on('xhr.dt', schedule);
        // scrollY ist jetzt viewport-basiert -> auch bei Fenster-Resize/Rotation
        // neu berechnen (der ResizeObserver am Wrapper feuert dabei nicht
        // zwingend, wenn der Wrapper inhaltsgrößenbestimmt ist).
        window.addEventListener('resize', schedule);

        // Observe .table-wrapper directly — that's the element calcScrollY
        // measures. Observing the outer .bulma-panel was insufficient
        // because the panel has a fixed outer height; chip rows growing
        // inside it redistribute space without resizing the panel itself,
        // so the RO never fires. .table-wrapper IS the thing that shrinks
        // when chips appear above it, so observe it directly.
        const wrapper = document.querySelector('#mainContent .table-wrapper');
        if (wrapper && window.ResizeObserver) {
            this._ro = new ResizeObserver(schedule);
            this._ro.observe(wrapper);
        }

        // No immediate schedule() — the initial scrollY was already
        // computed in init() before initTable(). The real post-chip recalc
        // comes from xhr.dt / draw.dt / filters:rendered / RO once the
        // first chips have rendered. Calling schedule() here just queues
        // a recompute against an empty (no-chip) layout that re-runs the
        // exact same calculation init() just did, then short-circuits.


        // Cleanup merken — wird in destroy() aufgerufen
        this._cleanupAutoScrollY = () => {
            if (raf1) cancelAnimationFrame(raf1);
            if (raf2) cancelAnimationFrame(raf2);
            document.removeEventListener('filters:rendered', schedule);
            window.removeEventListener('resize', schedule);
            this.table?.off('draw.dt', schedule);
            this.table?.off('xhr.dt', schedule);
            this._ro?.disconnect();
            this._ro = null;
        };
    }

    _setupInfoRow() {
        const selector = this.config.infoContainer;
        if (!selector) return;

        const target = document.querySelector(selector);
        if (!target) return;

        this.table.one('init.dt', () => {
            const infoEl = this.table.table().container()
                .querySelector('.dt-info');
            if (!infoEl) return;

            // Original verstecken – DataTables/Scroller schreibt weiter hinein
            infoEl.style.display = 'none';

            // Mirror im Ziel-Container
            const mirror = document.createElement('div');
            mirror.className = 'dt-info';
            target.appendChild(mirror);

            // Jede Änderung am Original sofort spiegeln
            this._infoObserver = new MutationObserver(() => {
                mirror.textContent = infoEl.textContent;
            });
            this._infoObserver.observe(infoEl, {
                childList: true,
                subtree: true,
                characterData: true
            });

            // Initialwert setzen
            mirror.textContent = infoEl.textContent;
        });
    }

    applyScrollY() {
        // Guard: nach Navigation/Destroy ist die Tabelle weg — verhindert
        // Fehler aus den verzoegerten Settle-Recalcs (rAF/Timeout).
        if (!this.table || !document.body.contains(this.table.table().node())) return;
        const scrollBody = this.table.table().container()
            .querySelector('.dt-scroll-body');
        if (!scrollBody) return;

        const newY = calcScrollY();
        // 1px tolerance: subpixel layouts (high-DPI, browser zoom) can
        // produce off-by-one diffs that aren't worth a re-layout.
        if (Math.abs((this._scrollY ?? 0) - newY) >= 2) {
            this._scrollY = newY;
            scrollBody.style.setProperty('height', newY + 'px', 'important');
            scrollBody.style.setProperty('max-height', newY + 'px', 'important');
        }
        // Spaltenbreiten IMMER neu ausrichten — auch bei reiner BREITEN-
        // Änderung (Menü auf/zu, Parent-Resize), sonst werden die Spalten
        // nach rechts aus dem Container geschoben.
        this.table.columns.adjust();
    }

    async initFeatures() {

        this._activeFeatures = [];
        const features = this.config.features || [];

        for (const name of features) {

            const feature = FeatureRegistry.resolve(name);
            if (!feature) continue;

            const instance = Object.create(feature);
            instance.ctx = this;

            await instance.init?.(this);
            this._activeFeatures.push(instance);
        }
    }
    renderState() {
        this.filters?.renderState?.();
    }   

    bindCore() {

        const $table = $(this.config.tableSelector);
        const $body = $table.find('tbody');

        $body
            .off('click', '.js-dropdown')
            .off('click', this.config.actionToggleSelector)
            .on('click', '.js-dropdown, ' + this.config.actionToggleSelector, (e) => {

                e.stopPropagation();

                const btn = e.target.closest('.js-dropdown, ' + this.config.actionToggleSelector);
                if (!btn) return;

                const menu = document.getElementById(btn.dataset.target);
                if (!menu) return;

                this.dropdown.toggle(menu, btn);
            });

        // ACTION HANDLER
        //
        // Resolves the underlying row data and forwards it as a 4th arg to
        // the configured action handler. Two lookup paths because mobile
        // dropdown menus are portaled out of the <tr> by the DropdownEngine
        // when opened, so .closest('tr') won't find anything for menu-item
        // clicks — fall back to looking the row up by its data-id.
        this._actionHandler = (e) => {

            // Responsive darf IMMER durch
            if (e.target.closest('td.dtr-control')) return;

            const el = e.target.closest('.action-btn, .dt-menu-item');
            if (!el) return;

            const actionType = el.dataset.action;

            const action = this.config.actions?.find(a =>
                a.type === actionType
            );

            if (!action) return;

            const $el = $(el);
            let row = null;

            if (this.table) {
                const $tr = $el.closest('tr');
                if ($tr.length && $.contains(this.table.table().node(), $tr[0])) {
                    // Inline desktop click — element still inside the table.
                    row = this.table.row($tr).data() || null;
                } else {
                    // Mobile menu item — portaled to <body>. Look up the row
                    // by id stamped on the element by renderActions().
                    const id    = $el.data('id');
                    const idKey = this.config.idKey || 'id';
                    if (id != null) {
                        // rows(fn) scans in place — no toArray() copy of the
                        // whole dataset per click. Loose equality so numeric
                        // ids in data-* attrs (strings from jQuery) match
                        // number rows.
                        const matches = this.table
                            .rows((_, data) => data?.[idKey] == id)
                            .data();
                        row = matches.length ? matches[0] : null;
                    }
                }
            }

            action.handler($el, this.table, this, row);
        };

        document.body.addEventListener('click', this._actionHandler);
        
    }

    recalc() {
        if (!this.table) return;

        this.table.columns.adjust();

        if (this.table.responsive && this.table.responsive.recalc) {
            this.table.responsive.recalc();
        }
    }

    // Aktionsspalte: Inline-Icons (Desktop) <-> Kontextmenü (Mobile) beim
    // Resize umschalten. renderActions() entscheidet den Modus zur Renderzeit
    // (_isMobileForActions, <=680px); ohne dieses Nachziehen bliebe der beim
    // ersten Draw gewählte Modus bis zum nächsten Reload/Redraw bestehen.
    // Es werden NUR die Aktions-Zellen der aktuellen Seite neu gerendert
    // (cell.render('display') ruft die Spalten-Renderfunktion erneut auf) —
    // kein draw()/Server-Fetch, Paging/Sortierung/Suche bleiben unberührt.
    _refreshActionCellsIfThresholdCrossed() {
        if (!this.table) return;
        const mob = _isMobileForActions();
        if (mob === this._lastActionsMobile) return; // Schwelle nicht überschritten
        this._lastActionsMobile = mob;
        this.dropdown?.closeAll?.();
        this.table.cells({ page: 'current' }).every(function () {
            const node = this.node();
            if (!node || !node.querySelector) return;
            // Nur Zellen mit Aktions-Markup (Inline-Icons oder Menü) anfassen.
            if (!node.querySelector('.dt-actions, .dt-action-menu')) return;
            const html = this.render('display');
            if (typeof html === 'string') node.innerHTML = html;
        });
    }

    bindResizeEvents() {
        // Ausgangszustand merken, damit nur echte Schwellen-Wechsel neu rendern.
        this._lastActionsMobile = _isMobileForActions();

        this._resizeHandler = debounce(() => {
            if (!document.body.contains(this.table?.table().node())) return;
            this._refreshActionCellsIfThresholdCrossed();
            this.recalc();
        }, 150);

        this._windowResize = () => {
            this.dropdown.closeAll();
            this._resizeHandler();
        };

        window.addEventListener('resize', this._windowResize);
        window.addEventListener('orientationchange', this._resizeHandler);
    }

    destroy() {

            // =========================
            // 0. UNBLOCK READY-WAITERS
            // =========================
            // If destroy() runs before init.dt fired (e.g. an aborted
            // ajax response, or a force-reinit that supersedes us), any
            // external `await ctx.ready` would hang forever and lock
            // setActiveMenu's isSwitching guard. Resolve here so callers
            // unblock and reach their finally blocks.
            this._resolveReady?.();
            this._resolveReady = null;

            // =========================
            // 1. FEATURES
            // =========================
            this._activeFeatures?.forEach(f => f.destroy?.(this));
            this._activeFeatures = [];

            // =========================
            // 2. DROPDOWN
            // =========================
            // (Filter + search teardown is handled by their features above.)
            // NOTE: the dropdown engine is a shared singleton. Do not destroy
            // it here — other controllers may still be using it. Only close
            // any menu we left open.
            this.dropdown?.closeAll?.();

            // =========================
            // 3. DATA TABLE EVENTS
            // =========================
            if (this.table) {
                this.table.off('init.dt');
                this.table.off('xhr.dt');
            }

            // =========================
            // 4. DOM EVENTS (table scoped)
            // =========================
            const $table = $(this.config.tableSelector);
            $table.find('tbody').off();

            // =========================
            // 5. GLOBAL ACTION HANDLER
            // =========================
            document.body.removeEventListener('click', this._actionHandler);

            // =========================
            // 6. DATA TABLE DESTROY (FIXED)
            // =========================
            this.table?.clear?.();
            this.table?.destroy?.(true);

            this.table = null;

            // =========================
            // 7. RESIZE HANDLERS
            // =========================
            if (this._windowResize) {
                window.removeEventListener('resize', this._windowResize);
            }
            if (this._resizeHandler) {
                window.removeEventListener('orientationchange', this._resizeHandler);
            }

            // =========================
            // 8. ABORT IN-FLIGHT REQUESTS
            // =========================
            // serverSide ajax can have a request in flight at destroy time
            // (e.g. user navigates away mid-fetch); abort it to avoid a stale
            // callback firing against a destroyed table.
            if (this._mainRequest) {
                try { this._mainRequest.abort(); } catch (e) {}
                this._mainRequest = null;
            }
            this.dataProvider?.abortController?.abort?.();
            this.allRowsProvider?.abortController?.abort?.();

            this._cleanupAutoScrollY?.();

            this._infoObserver?.disconnect();
            this._infoObserver = null;

            // =========================
            // 9. RELEASE CACHED DATA + REGISTRY SLOT
            // =========================
            // Destroyed controllers used to linger in TableUI.instances
            // with their full cached datasets — drop both so navigating
            // through many tables doesn't accumulate every dataset in RAM.
            this.dataProvider?.clear?.();
            this.allRowsProvider?.clear?.();
            if (TableUI.instances[this.config._name] === this) {
                delete TableUI.instances[this.config._name];
            }
        }

    // Mobil platzsparend: blendet Chips + Datum/Suche hinter einen "Filter"-
    // Button im Panel-Heading. Auf Tablet/Desktop ist der Button ausgeblendet
    // (CSS) und die Filter immer sichtbar. Generisch für alle Tabellen, die das
    // Standard-.panel-card-Layout nutzen.
    _injectMobileFilterToggle() {
        const $panel = $(this.config.tableSelector).closest('.panel-card');
        if (!$panel.length) return;
        if (!$panel.find('.filter-column, .date-filter').length) return; // nichts zu togglen

        const $group = $panel.find('.bulma-panel-heading .bulma-field.bulma-has-addons').first();
        if (!$group.length || $group.find('.mobile-filter-toggle').length) return; // schon vorhanden

        const $ctrl = $(
            '<p class="bulma-control bulma-is-hidden-tablet">' +
              '<button type="button" class="bulma-button bulma-is-small bulma-is-dark mobile-filter-toggle" title="Filter">' +
                '<span class="bulma-icon bulma-is-small"><i data-lucide="sliders-horizontal"></i></span>' +
                // Gleiche Struktur wie die anderen Toolbar-Buttons (Label-Span,
                // auf Mobile versteckt) -> identisches Padding/Icon-Verhalten.
                '<span class="bulma-is-hidden-mobile">Filter</span>' +
              '</button>' +
            '</p>'
        );
        $group.prepend($ctrl);
        const self = this;
        $ctrl.find('button').on('click', function () {
            const open = $panel.toggleClass('filters-open').hasClass('filters-open');
            $(this).toggleClass('bulma-is-active', open);
            // Der Filterblock veraendert die verfuegbare Hoehe; der
            // ResizeObserver am Wrapper feuert dabei nicht zuverlaessig ->
            // nach dem Layout-Update explizit neu rechnen + Scroller messen.
            requestAnimationFrame(() =>
                requestAnimationFrame(() => self._recomputeAfterLayout()));
        });
    }

    // Hoehe neu berechnen und den Scroller (falls aktiv) neu vermessen — nach
    // Layout-Aenderungen, die der ResizeObserver nicht erfasst (z. B. mobiler
    // Filterblock auf/zu).
    _recomputeAfterLayout() {
        if (!this.table) return;
        this.applyScrollY();
        try {
            const dt = this.table;
            if (dt.scroller && typeof dt.scroller.measure === 'function') {
                dt.scroller.measure(false); // Viewport/Zeilenhoehe neu vermessen
            }
        } catch (_) { /* Scroller nicht aktiv */ }
        try { this.table.columns.adjust().draw(false); } catch (_) {}
    }

    reload(resetPaging = false) {
        // client-side: invalidate the cached dataset so the reload re-fetches.
        // serverSide: ajax is always fresh; just invalidate the chip-source
        // cache so chips reflect any new rows on the next fetch.
        this.dataProvider.invalidate();
        this.allRowsProvider.invalidate();
        this._allRowsKey = null;
        this.table.ajax.reload(null, resetPaging);
    }

}

// =============================
// createRulesFromSchema
// ============================= 
function createRulesFromSchema(schema) {

    const rules = [];

    for (const f of schema) {

        // -------------------------
        // STANDARD COLUMN FILTER
        // -------------------------
        if (f.column && !f.type) {
            rules.push((row, store) => {
                const selected = store.get(f.column);
                return !selected.length || selected.includes(String(row[f.column]));
            });
        }

        // -------------------------
        // DATE RANGE FILTER
        // -------------------------
        if (f.type === 'date-range') {
            const fromSel = f.from;
            const toSel = f.to;

            // The rule runs once per ROW on every draw, but the picker
            // values are row-invariant: resolve the inputs once (re-resolve
            // only after a page swap replaced them) and memoize the moment
            // parsing on the raw input strings. Previously this cost up to
            // 4 moment parses + 2 jQuery lookups per row.
            let fromEl = null, toEl = null;
            let rangeKey = null, min = null, max = null;

            rules.push((row, store) => {
                if (!fromEl || !fromEl.isConnected) fromEl = document.querySelector(fromSel);
                if (!toEl   || !toEl.isConnected)   toEl   = document.querySelector(toSel);

                const minVal = fromEl ? fromEl.value : '';
                const maxVal = toEl   ? toEl.value   : '';

                const key = minVal + '|' + maxVal;
                if (key !== rangeKey) {
                    rangeKey = key;
                    const mMin = moment(minVal, 'DD.MM.YYYY', true);
                    const mMax = moment(maxVal, 'DD.MM.YYYY', true);
                    min = mMin.isValid() ? mMin.startOf('day').valueOf() : null;
                    max = mMax.isValid() ? mMax.endOf('day').valueOf()   : null;
                }

                // No active range — skip the per-row date parse entirely.
                if (!min && !max) return true;

                const dateRaw = row.datum || row[f.column];

                // Server datetimes are UTC. Compare as absolute milliseconds
                // against the local-day [min, max] range derived above.
                const utc = parseUtc(dateRaw);
                const date = utc ? utc.getTime() : NaN;

                if (!date) return true;

                return (!min || date >= min) && (!max || date <= max);
             });
        }
    }

    return rules;
}

// =============================
// createRulesFromSchema
// ============================= 
class ColvisComponent {
    constructor(table, menu) {
        this.table = table;
        this.menu = menu;

        this.build();
    }

    build() {
        this.menu.innerHTML = '';

        this.table.columns().every((i) => {

            const column = this.table.column(i);
            const header = column.header();

            if (header.classList.contains('no-colvis')) return;

            const item = document.createElement('div');
            item.className = 'dropdown-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';

            const label = document.createElement('span');
            label.textContent = header.textContent;

            item.appendChild(checkbox);
            item.appendChild(label);

            item.addEventListener('click', (e) => {
                if (e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                }

                column.visible(checkbox.checked);
            });

            checkbox.addEventListener('change', (e) => {
                column.visible(e.target.checked);
            });

            this.menu.appendChild(item);
        });

        this.sync(); 
        this.addReset();
    }

    sync() {
        const inputs = Array.from(this.menu.querySelectorAll('input'));

        this.table.columns().every((i) => {
            const column = this.table.column(i);
            const header = column.header();

            if (header.classList.contains('no-colvis')) return;

            const input = inputs.shift();
            if (input) {
                input.checked = column.visible();
            }
        });
    }
    
    addReset() {
        const divider = document.createElement('div');
        divider.className = 'dropdown-divider';

        const reset = document.createElement('div');
        reset.className = 'dropdown-item reset';
        reset.textContent = 'Zurücksetzen';

        reset.addEventListener('click', () => {
            this.table.columns().every((i) => {
                const column = this.table.column(i);
                const header = column.header();

                if (!header.classList.contains('no-colvis')) {
                    column.visible(true);
                }
            });

            this.sync();
        });

        this.menu.appendChild(divider);
        this.menu.appendChild(reset);
    }
}



function buildExportButtons(table) {
    const ctx = table._ctx || {};
    const base = getExportColumns(table);
    const hasAdvanced = !!ctx?.config?.advancedExport;
 
    const createBtn = (type) => {
 
        const btn = {
            extend: type,
            ...base,
            title: 'Export_' + new Date().toISOString()
        };
 
        if (hasAdvanced) {
 
            btn.action = function (e, dt, node, config) {
                ctx._advancedExport?.run(type);
            };
 
            btn.exportOptions = null;
        }
 
        return btn;
    };
 
    return [
        createBtn('copy'),
        createBtn('csv'),
        createBtn('excel'),
        createBtn('pdf')
    ];
}
 
 
 
// =============================
// Helpers 
// =============================
function resolveColumns(ctx) {
    // Auch hier die deklarativen `tag`-Spalten auflösen, damit Exporte den
    // Options-Text (statt des Rohwerts 1/0) erhalten.
    return applyTagColumns(ctx.config.columns(ctx), ctx.config.filters).map(col => ({ ...col }));
}

// Deklaratives Status-Tag pro Spalte (analog exportKey): Spalten mit `tag: true`
// (oder `tag: '<filter-spalte>'`) werden als farbiger Tag gerendert — Farbe UND
// Label kommen aus den Filter-Chip-Optionen DERSELBEN Spalte. Ohne passende
// Filter-Chips (Voraussetzung!) bleibt es reiner Text. So lässt sich pro Spalte
// steuern, ob die Tags angewendet werden, unabhängig von den Chips selbst.
function applyTagColumns(columns, filters) {
    const fl = filters || [];
    return columns.map(col => {
        if (!col.tag) return col;
        const key = col.tag === true ? (col.data || col.name) : col.tag;
        const f = fl.find(ff => ff.column === key);
        const options = f && f.options;
        const out = { ...col };
        out.render = (data, type) => {
            const opt = (options || []).find(o => String(o.value) === String(data));
            const text = opt ? opt.label : (data == null ? '' : String(data));
            if (type && type !== 'display') return text;   // sort/filter/type/export -> Text
            if (!options) return escapeHtml(text);         // keine Chips -> nur Text
            return TableUI.theme.optionBadge(options, data);
        };
        return out;
    });
}

// Resolves the column definition (regular → extra → dynamic) for an
// absolute export column index. Row-invariant, so the exporters compute
// this once per column instead of once per cell.
function resolveExportColDef(cfg, colIdx) {
    let colDef = cfg._columns?.[colIdx];
    if (!colDef && cfg._extraColumns && colIdx >= (cfg._extraRange?.[0] || cfg._columns?.length || 0)) {
        const extraIndex = colIdx - (cfg._extraRange?.[0] || cfg._columns?.length || 0);
        colDef = cfg._extraColumns?.[extraIndex];
    }
    if (!colDef && colIdx >= (cfg._columns?.length || 0) + (cfg._extraColumns?.length || 0)) {
        const dynIndex = colIdx - (cfg._columns?.length || 0) - (cfg._extraColumns?.length || 0);
        colDef = cfg._dynamicColumns?.[dynIndex];
    }
    return colDef;
}
 
function getValue(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}

// =============================
// Action column rendering
// =============================
//
// Generic builder for the per-row "actions" cell. Two render modes:
//   - desktop: a flex row of inline icons (.action-btn)
//   - mobile : a single more-icon that toggles a .dropdown-menu of items
//              (.dt-menu-item). Uses the existing DropdownEngine wiring
//              that TableController binds for `.js-dropdown` elements,
//              so no extra event handlers per row.
//
// Click dispatch is already handled by TableController._actionHandler:
// it looks for `.action-btn, .dt-menu-item` with `data-action="<type>"`
// and matches the type against the table's `config.actions[]` array.
//
// Usage in a column render:
//   {
//       data: null,
//       orderable: false,
//       className: 'no-export no-colvis',
//       render: row => renderActions(row, ['view', 'edit', 'del'])
//   }
//
// Each entry can also be an object for per-action overrides:
//   { type: 'edit', icon: 'pencil', title: 'Bearbeiten',
//     when: row => row.user_id === ACTIVE_USER_ID, extra: 'data-confirm="1"' }
//
// Pair with `actions: [{ type, handler }, ...]` in the same TableUI config.

const ACTION_ICONS = {
    view:     'view',
    edit:     'edit',
    del:      'delete',
    delete:   'delete',
    qr:       'qrcode',
    receipt:  'receipt',
    print:    'print',
    copy:     'copy',
    download: 'download',
    storno:   'ban',
    mail:     'mail',
};

const ACTION_TITLES_DE = {
    view:     'Anzeigen',
    edit:     'Bearbeiten',
    del:      'Löschen',
    delete:   'Löschen',
    qr:       'QR-Code',
    receipt:  'Beleg',
    print:    'Drucken',
    copy:     'Kopieren',
    download: 'Download',
    storno:   'Stornieren',
    mail:     'E-Mail senden',
};

// LIVE gemessen (nicht das globale `isMobile` aus main.js — das ist ein const,
// der nur beim Laden gesetzt wird und beim Resize nie aktualisiert; darauf zu
// hören liess den Modus nie wechseln). Schwelle 680px wie in main.js. Eine
// isMobile()-FUNKTION (falls je vorhanden) wird weiterhin bevorzugt.
function _isMobileForActions() {
    if (typeof isMobile === 'function') return isMobile();
    return typeof window !== 'undefined' && window.innerWidth <= 680;
}

function renderActions(row, defs, opts = {}) {
    const idKey = opts.idKey || 'id';
    const id    = row?.[idKey];

    const items = (defs || [])
        .map(d => typeof d === 'string' ? { type: d } : d)
        .filter(d => typeof d.when !== 'function' || d.when(row));

    if (items.length === 0) return '';

    const mobile = opts.mobile ?? _isMobileForActions();

    if (mobile) {
        const menuId         = `${opts.menuPrefix || 'rowMenu'}_${id}`;
        const toggleIconName = opts.toggleIcon || 'more';

        const menuItems = items.map(d => {
            const iconName = d.icon  || ACTION_ICONS[d.type]      || d.type;
            const label    = d.title || ACTION_TITLES_DE[d.type] || d.type;
            return `<div class="dt-menu-item action-${d.type}" data-id="${id}" data-action="${d.type}">
                <span class="bulma-icon-text">
                    <span class="bulma-icon">${svgicon(iconName)}</span>
                    <span>${label}</span>
                </span>
            </div>`;
        }).join('');

        // Toggle has data-target (read by TableController's `.js-dropdown`
        // delegated click) but NO data-action — so the click never falls
        // through to the action dispatcher.
        return `<div class="dt-action-menu">
            <div class="dt-menu-toggle js-dropdown" data-target="${menuId}">
                <span class="bulma-icon bulma-is-small">${svgicon(toggleIconName)}</span>
            </div>
            <div class="dropdown-menu" id="${menuId}">${menuItems}</div>
        </div>`;
    }

    // Desktop: inline icons. `.action-btn` is required for the existing
    // TableController click dispatcher to fire.
    const wrapperClass = opts.wrapperClass || 'dt-actions';
    const inline = items.map(d => {
        const iconName = d.icon  || ACTION_ICONS[d.type]      || d.type;
        const label    = d.title || ACTION_TITLES_DE[d.type] || d.type;
        const extra    = d.extra || '';
        return `<span class="bulma-icon bulma-is-small action-btn action-${d.type}"
                      data-id="${id}"
                      data-action="${d.type}"
                      title="${label}" ${extra}>${svgicon(iconName)}</span>`;
    }).join('');

    return `<div class="${wrapperClass}">${inline}</div>`;
}
 
function resolveRowColor(row, cfg) {
 
    if (!cfg?.source) return null;
 
    const source = row[cfg.source];
 
    if (!source) return null;
 
    if (!Array.isArray(source)) {
        return source[cfg.colorField] || null;
    }
 
    return source[0]?.[cfg.colorField] || null;
}
 
function buildColumnColorMap(row, cfg) {
    const map = {};
    const src = row[cfg.source];

    if (!src) return map;

    // Flacher String: direkt Farbwert
    if (typeof src === 'string') {
        if (cfg.key) map[cfg.key] = src;
        return map;
    }

    // Objekt (kein Array): einmaliger Eintrag
    if (!Array.isArray(src) && typeof src === 'object') {
        const color = src[cfg.colorField];
        if (cfg.key && color) map[cfg.key] = color;
        return map;
    }

    // Array
    src.forEach(item => {
        const key   = item[cfg.key];
        const color = item[cfg.colorField];
        if (key) map[key] = color;
    });

    return map;
}

// =============================
// Row / cell text styling for exports
// =============================
//
// Both exportPDF and exportExcel run row data through `resolveRowStyle()`
// and per-dynamic-cell through `cfg.styling.cellStyle()`. The returned
// style is in pdfMake-shape (bold / italics / decoration / color /
// fillColor) and is translated to xlsx font fields by pdfStyleToXlsx().
//
// CSV silently ignores all of this — there is no styling channel in CSV.

// Resolves a per-row style. Two shapes supported:
//   { rule: (row) => styleObj | null }
//     — callback for arbitrary logic.
//   { source: 'status', map: { paid: { bold: true }, cancelled: {...} } }
//     — lookup table keyed on row[source].
function resolveRowStyle(row, cfg) {
    if (!cfg) return null;
    if (typeof cfg.rule === 'function') {
        return cfg.rule(row) || null;
    }
    if (cfg.source && cfg.map) {
        const key = row[cfg.source];
        return cfg.map[key] || null;
    }
    return null;
}

// pdfMake style fields recognised by `pickPdfStyle`. Anything not on this
// list is dropped before applying to a pdf cell, so an xlsx-shape field
// like `{ underline: true }` doesn't end up on a pdfMake node where it has
// no effect (or could collide with a future pdfMake field of the same name).
const PDF_STYLE_KEYS = ['bold', 'italics', 'decoration', 'decorationStyle', 'decorationColor', 'color', 'fillColor'];

function pickPdfStyle(style) {
    if (!style) return null;
    const out = {};
    for (const k of PDF_STYLE_KEYS) if (k in style) out[k] = style[k];
    return Object.keys(out).length ? out : null;
}

// Translates a pdfMake-shape style object to an xlsx cell-style fragment
// (`{ font, fill }`) ready to merge into ws[ref].s.  Decoration is special
// because xlsx splits it into `underline` and `strike` font flags.
function pdfStyleToXlsx(style) {
    if (!style) return null;
    const font = {};
    if (style.bold)    font.bold = true;
    if (style.italics) font.italic = true;
    if (style.decoration === 'underline')   font.underline = true;
    if (style.decoration === 'lineThrough') font.strike = true;
    if (style.color) font.color = { rgb: hexToXlsx(style.color) };

    const out = {};
    if (Object.keys(font).length) out.font = font;
    if (style.fillColor)          out.fill = { fgColor: { rgb: hexToXlsx(style.fillColor) } };
    return Object.keys(out).length ? out : null;
}

// Merges an xlsx style fragment into an existing ws[ref].s without dropping
// previously-applied styling (rowColor / columnColor sets `.fill`, rowStyle
// may add `.font`, etc.).
function mergeXlsxStyle(cell, frag) {
    if (!cell || !frag) return;
    cell.s = cell.s || {};
    if (frag.font) cell.s.font = { ...(cell.s.font || {}), ...frag.font };
    if (frag.fill) cell.s.fill = { ...(cell.s.fill || {}), ...frag.fill };
}
 
function formatValue(value, col) {

    if (value == null) return '';

    if (col?.exportFormat === false) {
        return value;
    }

    // explicit integer
    if (col?.exportFormat === 'integer') {
        const n = Number(value);
        return isNaN(n) ? value : n.toFixed(0);
    }

    // explicit number/float
    if (col?.exportFormat === 'number' || col?.exportFormat === 'float') {
        const n = Number(value);
        return isNaN(n) ? value : n.toFixed(2);
    }

    // explicit date formatting
    if (col?.exportFormat === 'date') {
        const fmt = col.exportFormatSettings?.format || 'DD.MM.YYYY';
        try {
            return moment.utc(value, col.exportFormatSettings?.inputFormat || undefined, true).local().format(fmt);
        } catch (_) {
            return value;
        }
    }

    // fallback: real numbers -> 2 decimals. Numeric-LOOKING strings
    // (UIDs, references, zip codes) stay untouched — columns that want
    // numeric formatting declare an explicit exportFormat.
    if (typeof value === 'number' && !isNaN(value)) {
        return value.toFixed(2);
    }

    return value;
}

function autoResolve(source, rows) {

    const seen = new Set();
    const result = [];

    rows.forEach(row => {

        const val =
            row[source] ??
            row[source.replace(/s$/, '')]; // plural → singular

        if (!val) return;

        const arr = Array.isArray(val) ? val : [val];

        arr.forEach(v => {
            // Skip null/undefined entries entirely.
            if (v == null) return;

            // For object entries, require at least one usable identifier.
            // Empty objects (e.g. `{ id: null, name: null }` from a LEFT JOIN
            // with no match) get dropped here so they never reach `_renderChips`.
            if (typeof v === 'object') {
                const id   = v.id   ?? null;
                const name = v.name ?? null;
                if (id == null && name == null) return;
            }

            const key = v?.name ?? v?.id ?? JSON.stringify(v);

            if (!seen.has(key)) {
                seen.add(key);
                result.push(v);
            }
        });
    });

    return result;
}

 
// =============================
// Export Functions
// =============================
//
// All three functions accept the same `cfg` object (cfg.advancedExport from
// the table config). Optional fields read off cfg here:
//
//   cfg.title           string | (info) => string
//                       PDF document title (default: "Export – <date>").
//                       The callback receives { date, dateStr, filters }
//                       so you can render dynamic strings like
//                       "Buchungen 01.04.2026 – 23.04.2026".
//
//   cfg.filename        string | (info) => string
//                       File name without extension (default: "export").
//                       Same callback signature as cfg.title.
//
//   cfg.sheetName       string
//                       Excel sheet tab name (default: "Export").
//
//   cfg.pageOrientation 'landscape' | 'portrait'  (PDF, default landscape)
//
//   cfg._filters        injected by the export feature — the live filter
//                       state at export time, so callbacks above can render
//                       based on what the user filtered on.

// Resolves cfg.filename (string or function) to a final file path with the
// requested extension. Strips any user-supplied extension before re-adding
// our own so callers can write `'buchungen'` or `'buchungen.pdf'` and get
// the same result for a given format.
function resolveExportName(name, ext, info = {}) {
    if (typeof name === 'function') name = name(info);
    if (!name) return `export.${ext}`;
    // Prefix with company short_name (fallback to name, then 'Firma')
    const company = info?._company || {};
    const prefix = (company.short_name && String(company.short_name).trim())
        ? String(company.short_name).trim()
        : (company.name && String(company.name).trim()) ? String(company.name).trim() : 'Firma';
    // Kurznamen als Dateinamen-Präfix absichern: Leerzeichen -> _, alle übrigen
    // Sonderzeichen (Slashes, Punkte, Umlaute, …) entfernen, Mehrfach-Unter-
    // striche zusammenfassen und Rand-Trenner kappen -> immer ein sicherer
    // Dateiname. Bleibt nichts übrig (reiner Sonderzeichen-Name) -> 'Firma'.
    let safePrefix = String(prefix)
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .replace(/_+/g, '_')
        .replace(/^[_-]+|[_-]+$/g, '');
    if (!safePrefix) safePrefix = 'Firma';
    const base = String(name).replace(/\.[^.]+$/, '');
    return `${safePrefix}_${base}.${ext}`;
}

// Builds the { date, dateStr, filters } payload passed to title/filename
// callbacks. Centralised so the three exporters stay in sync.
function buildExportInfo(cfg) {
    const date = new Date();
    const dateStr = new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(date);
    return { date, dateStr, filters: cfg?._filters || {}, _company: cfg?._company || {} };
}

// Cached company settings loader used to prefix exported filenames.
let _companySettingsCache = null;
async function fetchCompanySettingsCached() {
    if (_companySettingsCache) return _companySettingsCache;
    try {
        const res = await apiFetch('/api.php?endpoint=settings/get_company.php');
        if (!res || !res.ok) return _companySettingsCache = {};
        const j = await res.json();
        _companySettingsCache = j?.company || {};
        return _companySettingsCache;
    } catch (e) {
        _companySettingsCache = {};
        return _companySettingsCache;
    }
}

// 1-basierte Spaltennummer -> Excel-Spaltenbuchstabe (1->A, 27->AA).
function _xlsxColLetter(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

// moment-Ausgabeformat -> Excel-numFmt (Jahr/Monat/Tag/Stunde klein;
// Minuten 'mm' bleiben). 'DD.MM.YYYY HH:mm' -> 'dd.mm.yyyy hh:mm'.
function _xlsxDateNumFmt(colDef, fallback) {
    const f = colDef?.exportFormatSettings?.format;
    if (!f) return fallback;
    return f.replace(/[YMDH]/g, c => c.toLowerCase());
}

function exportExcel(header, body, dynamicKeys, columnsCount, cfg = {}) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(cfg.sheetName || 'Export');
    const styling = cfg.styling || {};
    const alpha = cfg.excelAlpha ?? 0.3;

    // ---- Header --------------------------------------------------------
    const headerRow = worksheet.addRow(header);
    headerRow.font = { bold: true };

    worksheet.columns = header.map((h, i) => {
        // Spaltenbreite nach der LÄNGSTEN ZEILE einer Zelle, nicht nach der
        // Gesamtlänge: mehrzeilige Zellen (z.B. die "(Detail)"-Zahlungs-
        // zusammenfassung mit wrapText) würden sonst die Summe aller Zeilen
        // als Breite bekommen und die Spalte unnötig breit machen. Bei
        // einzeiligen Werten ist die längste Zeile = der ganze Wert.
        const maxDataLen = body.reduce((max, r) => {
            const s = String(r.values[i] ?? '');
            const lineLen = s.indexOf('\n') === -1
                ? s.length
                : s.split('\n').reduce((m, line) => Math.max(m, line.length), 0);
            return Math.max(max, lineLen);
        }, 0);
        return {
            key: String(i),
            width: Math.max(String(h || '').length, maxDataLen) + 4
        };
    });

    // Column definitions are row-invariant — resolve them once up front
    // instead of re-deriving them for every cell of every row.
    const colDefs = header.map((_, i) => resolveExportColDef(cfg, i));

    // ---- Data rows -----------------------------------------------------
    body.forEach((r) => {
        // Build typed values and per-column format hints so we can set
        // Excel numFmt correctly (integers vs floats) and respect
        // `exportFormat` markers on both regular and extra columns.
        const formatHints = [];
        const typedValues = r.values.map((v, colIdx) => {
            if (v === null || v === undefined || v === '') {
                formatHints[colIdx] = null;
                return '';
            }

            const colDef = colDefs[colIdx];

            // explicit disable
            if (colDef?.exportFormat === false) {
                formatHints[colIdx] = null;
                return String(v);
            }

            // explicit date — der Wert kommt hier bereits im AUSGABEformat
            // (buildExportData/formatValue hat ihn formatiert), daher zuerst
            // mit dem Ausgabeformat parsen, dann inputFormat als Fallback.
            // So wird die Zelle ein echtes Excel-Datum (sortier-/rechenbar).
            if (colDef?.exportFormat === 'date') {
                const outFmt = colDef.exportFormatSettings?.format;
                let m = outFmt ? moment(String(v), outFmt, true) : moment(String(v));
                if (!m.isValid()) {
                    m = moment.utc(String(v), colDef.exportFormatSettings?.inputFormat || undefined, true).local();
                }
                if (m.isValid()) {
                    formatHints[colIdx] = 'date';
                    return m.toDate();
                }
                formatHints[colIdx] = null;
                return String(v);
            }

            // explicit numeric hint
            if (colDef?.exportFormat === 'number' || colDef?.exportFormat === 'integer' || colDef?.exportFormat === 'float') {
                const n = Number(v);
                if (!isNaN(n)) {
                    formatHints[colIdx] = colDef.exportFormat === 'integer' ? 'integer' : 'float';
                    return n;
                }
                formatHints[colIdx] = null;
                return String(v);
            }

            // fallback: coerce if numeric and choose integer vs float by value
            const n = Number(v);
            if (!isNaN(n)) {
                formatHints[colIdx] = Number.isInteger(n) ? 'integer' : 'float';
                return n;
            }

            formatHints[colIdx] = null;
            return String(v);
        });

        const wsRow = worksheet.addRow(typedValues);
        typedValues.forEach((v, idx) => {
            const hint = formatHints[idx];
            const cell = wsRow.getCell(idx + 1);
            if (hint === 'integer') {
                cell.numFmt = '#,##0';
                cell.alignment = { horizontal: 'right' };
            } else if (hint === 'float') {
                cell.numFmt = '#,##0.00';
                cell.alignment = { horizontal: 'right' };
            } else if (hint === 'date') {
                cell.numFmt = _xlsxDateNumFmt(colDefs[idx], cfg.excelDateFormat || 'dd.mm.yyyy');
                cell.alignment = { horizontal: 'center' };
            }
            // Mehrzeilige Texte (z.B. Zahlungs-Aufschlüsselung "5.00 × 1\n…")
            // umbrechen, sonst zeigt Excel nur eine Zeile.
            if (typeof v === 'string' && v.indexOf('\n') >= 0) {
                cell.alignment = { ...(cell.alignment || {}), wrapText: true, vertical: 'top' };
            }
        });

        // ROW COLOR
        if (styling.rowColor) {
            const color = resolveRowColor(r.row, styling.rowColor);
            if (color) {
                const lastCol = styling.rowColor.fullrow ? header.length : 1;
                for (let c = 1; c <= lastCol; c++) {
                    wsRow.getCell(c).fill = {
                        type: 'pattern', pattern: 'solid',
                        fgColor: { argb: hexToArgbLight(color, alpha) }
                    };
                }
            }
        }

        // COLUMN COLOR
        if (styling.columnColor) {
            const colorMap = buildColumnColorMap(r.row, styling.columnColor);

            // normale Tabellen-Spalten
            (cfg._columns || []).forEach((col, j) => {
                const matchKey = col.exportKey || col.data;
                const color = colorMap[matchKey];
                if (!color) return;
                const val = r.values[j];
                const shouldColor = styling.columnColor.fullcolumn ||
                    (val !== '' && Number(val) !== 0);
                if (shouldColor) {
                    const cell = wsRow.getCell(j + 1);
                    cell.fill = { type: 'pattern', pattern: 'solid',
                                fgColor: { argb: hexToArgbLight(color, alpha) } };
                    cell.font = { ...(cell.font || {}), bold: true };
                }
            });

            // dynamicKeys – wie bisher
            dynamicKeys.forEach((k, j) => {
                const colIndex = columnsCount + j;
                const val = r.values[colIndex];
                const color = colorMap[k];
                if (!color) return;
                const shouldColor = styling.columnColor.fullcolumn ||
                    (val !== '' && Number(val) !== 0);
                if (shouldColor) {
                    const cell = wsRow.getCell(colIndex + 1);
                    cell.fill = { type: 'pattern', pattern: 'solid',
                                fgColor: { argb: hexToArgbLight(color, alpha) } };
                    cell.font = { ...(cell.font || {}), bold: true };
                }
            });
        }

        // ROW STYLE
        if (styling.rowStyle) {
            const style = resolveRowStyle(r.row, styling.rowStyle);
            if (style) {
                const lastCol = styling.rowStyle.fullrow ? header.length : 1;
                for (let c = 1; c <= lastCol; c++) {
                    _applyExcelJsStyle(wsRow.getCell(c), style, alpha);
                }
            }
        }

        // PER-CELL STYLE
        if (typeof styling.cellStyle === 'function') {
            dynamicKeys.forEach((k, j) => {
                const style = styling.cellStyle(r.row, k);
                if (style) _applyExcelJsStyle(wsRow.getCell(columnsCount + j + 1), style, alpha);
            });
        }

        // EXTRA-COLUMN STYLE
        if (cfg._extraColumns?.length) {
            const [start] = cfg._extraRange || [0, 0];
            cfg._extraColumns.forEach((xcol, k) => {
                if (typeof xcol.style !== 'function') return;
                const style = xcol.style(r.row);
                if (style) _applyExcelJsStyle(wsRow.getCell(start + k + 1), style, alpha);
            });
        }

        // REGULAR-COLUMN PER-ROW STYLE — Excel
        if (cfg._columns?.length) {
            cfg._columns.forEach((col, k) => {
                if (typeof col.exportStyle !== 'function') return;
                const style = col.exportStyle(r.row);
                if (!style) return;

                // fillColor nicht überschreiben wenn bereits gesetzt
                const { fillColor: _drop, ...safeStyle } = style;
                _applyExcelJsStyle(wsRow.getCell(k + 1), safeStyle, alpha);
            });
        }
    });

    // Datenzeilen-Bereich (Header = Zeile 1) für Formeln/AutoFilter.
    const firstDataRow = 2;
    const lastDataRow  = body.length + 1;

    // ---- Sortier-/filterbar wie eine Tabelle: AutoFilter NUR über Header
    //      + Datenzeilen (die Summen-/Zahlungsmittel-Zeilen liegen darunter
    //      und bleiben aussen vor). ----------------------------------------
    if (body.length) {
        worksheet.autoFilter = {
            from: { row: 1, column: 1 },
            to:   { row: lastDataRow, column: header.length },
        };
    }

    // ---- Summenzeile (fett) — als Excel-FORMELN statt fixer Werte -------
    if (Array.isArray(cfg._totals) && body.length) {
        const totalDefs = cfg._totals.map((_, i) => resolveExportColDef(cfg, i));
        const totalRow  = worksheet.addRow([]);
        totalRow.font = { bold: true };
        cfg._totals.forEach((v, i) => {
            const cell = totalRow.getCell(i + 1);
            const fmt  = totalDefs[i]?.exportFormat;
            const numeric = (fmt === 'float' || fmt === 'number' || fmt === 'integer')
                && v !== '' && v != null && !isNaN(Number(v));
            if (numeric) {
                const col = _xlsxColLetter(i + 1);
                cell.value = { formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})`, result: Number(v) };
                cell.numFmt = fmt === 'integer' ? '#,##0' : '#,##0.00';
                cell.alignment = { horizontal: 'right' };
            } else if (v !== '' && v != null) {
                cell.value = String(v); // Label, z.B. "Summe"
            }
            // dünne Linie über der Summenzeile
            cell.border = { top: { style: 'thin', color: { argb: 'FFAAAAAA' } } };
        });
    }

    // ---- Pro Zahlungsmittel eine Summenzeile (z.B. Buchungen): jeweils
    //      alle Betraege dieses Zahlungsmittels per SUMIF aufsummiert.
    //      Konfiguriert ueber cfg.excelPaymentSummary = { matchKey, sumKey }.
    if (cfg.excelPaymentSummary && body.length) {
        const cols     = cfg._columns || [];
        const matchIdx = cols.findIndex(c => (c.exportKey || c.data) === cfg.excelPaymentSummary.matchKey);
        const sumIdx   = cols.findIndex(c => (c.exportKey || c.data) === cfg.excelPaymentSummary.sumKey);
        if (matchIdx >= 0 && sumIdx >= 0) {
            const matchCol = _xlsxColLetter(matchIdx + 1);
            const sumCol   = _xlsxColLetter(sumIdx + 1);
            // eindeutige Zahlungsmittel in Erst-Vorkommen-Reihenfolge
            const seen = [];
            body.forEach(r => {
                const pt = r.values[matchIdx];
                if (pt !== '' && pt != null && !seen.includes(String(pt))) seen.push(String(pt));
            });
            seen.forEach(pt => {
                const row = worksheet.addRow([]);
                row.font = { italic: true };
                row.getCell(1).value = pt;                    // Label = Zahlungsart
                const c = row.getCell(sumIdx + 1);
                const safe = String(pt).replace(/"/g, '""');
                c.value = {
                    formula: `SUMIF(${matchCol}${firstDataRow}:${matchCol}${lastDataRow},"${safe}",${sumCol}${firstDataRow}:${sumCol}${lastDataRow})`,
                };
                c.numFmt = '#,##0.00';
                c.alignment = { horizontal: 'right' };
            });
        }
    }

    // ---- Download via Promise.then -------------------------------------
    const info = buildExportInfo(cfg);
    workbook.xlsx.writeBuffer().then(buffer => {
        const blob = new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = resolveExportName(cfg.filename, 'xlsx', info);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }).catch(err => {
        console.error('Excel export failed', err);
        notifyError('Excel Export fehlgeschlagen');
    });
}

function _applyExcelJsStyle(cell, style, alpha) {
    if (!style) return;
    const font = { ...(cell.font || {}) };
    if (style.bold)       font.bold    = true;
    if (style.italics)    font.italic  = true;
    if (style.decoration === 'underline')   font.underline = true;
    if (style.decoration === 'lineThrough') font.strike    = true;
    if (style.color) font.color = { argb: 'FF' + hexToXlsx(style.color) };
    if (Object.keys(font).length) cell.font = font;
    if (style.fillColor && alpha > 0) {
        cell.fill = { type: 'pattern', pattern: 'solid',
                      fgColor: { argb: hexToArgbLight(style.fillColor, alpha) } };
    }
}

 
 
// PDF-Schriftgrössen-Presets (aus den Export-Einstellungen, cfg._pdfFontSize):
// Body/Kopf-Schrift + Zellen-Padding. Kleinere Stufen lassen mehr Spalten auf
// A4 quer passen. Der Dokumenttitel bleibt fix (11pt).
const PDF_FONT_PRESETS = {
    normal:  { body: 10, pad: 6 },
    klein:   { body: 8,  pad: 4 },
    kompakt: { body: 7,  pad: 3 },
};

function exportPDF(header, body, dynamicKeys, columnsCount, cfg = {}) {
    const alpha = cfg.pdfAlpha ?? 0.3;
    const styling = cfg.styling || {};
    const info = buildExportInfo(cfg);
    const now = info.date;
    const fontPreset = PDF_FONT_PRESETS[cfg._pdfFontSize] || PDF_FONT_PRESETS.normal;

    // Title can be a string or a callback. Default keeps the original
    // "<text> – <date>" shape but with a generic prefix; provide cfg.title
    // to override.
    const titleTextRaw = typeof cfg.title === 'function'
        ? cfg.title(info)
        : (cfg.title ?? `Export – ${info.dateStr}`);

    // Prefer the full company name for the PDF headline; fall back to short_name
    const companyPrefix = (info?._company?.name && String(info._company.name).trim())
        ? String(info._company.name).trim()
        : ((info?._company?.short_name && String(info._company.short_name).trim()) ? String(info._company.short_name).trim() : 'Firma');

    const titleText = `${companyPrefix} | ${titleTextRaw}`;

    // Column definitions are row-invariant — resolve once per column.
    const colDefs = header.map((_, i) => resolveExportColDef(cfg, i));

    const tableNode = {
                        width: 'auto',

                        table: {
                            headerRows: 1,
                            widths: header.map(() => 'auto'),

                            body: [
                                header.map(h => ({
                                    text: String(h ?? ''),
                                    bold: true,
                                    fontSize: fontPreset.body
                                })),

                                ...body.map(r =>
                                    r.values.map((v, colIdx) => {
                                        const cell = { text: String(v ?? ''), style: 'tableBody' };

                                        // alignment hints from the precomputed definition
                                        const colDef = colDefs[colIdx];

                                        if (colDef) {
                                            const fmt = colDef.exportFormat;
                                            if (fmt === 'integer' || fmt === 'number' || fmt === 'float') cell.alignment = 'right';
                                            else if (fmt === 'date') cell.alignment = 'center';
                                        } else {
                                            // fallback: right-align numeric-looking values
                                            if (v !== null && v !== '' && !isNaN(Number(v))) cell.alignment = 'right';
                                        }

                                        return cell;
                                    })
                                ),

                                // Summenzeile (fett) am Tabellenende
                                ...(Array.isArray(cfg._totals) ? [
                                    cfg._totals.map((v, colIdx) => {
                                        const cell = { text: String(v ?? ''), bold: true, style: 'tableBody' };
                                        const fmt = colDefs[colIdx]?.exportFormat;
                                        if (fmt === 'integer' || fmt === 'number' || fmt === 'float') cell.alignment = 'right';
                                        return cell;
                                    })
                                ] : [])
                            ]
                        },

                        layout: {
                            vLineWidth: () => 0,
                            hLineWidth: (i, node) => {
                                if (i === 1) return 1;
                                // Linie über der Summenzeile (letzte Zeile)
                                if (Array.isArray(cfg._totals) && i === node.table.body.length - 1) return 1;
                                return 0;
                            },
                            hLineColor: () => '#aaa',

                            paddingTop: () => fontPreset.pad,
                            paddingBottom: () => fontPreset.pad,

                            fillColor: (rowIndex) => {
                                if (rowIndex === 0) return '#eeeeee';
                                return rowIndex % 2 === 0 ? '#f9f9f9' : null;
                            }
                        }
                    }    

    const doc = {
        pageOrientation: cfg.pageOrientation || 'landscape',
        content: [
            {
                text: titleText,
                style: 'header'
            },
            {
                columns: [

                    { width: '*', text: '' }, // linker Spacer
                    tableNode,
                    { width: '*', text: '' } // rechter Spacer
                ]
            }
        ],
        styles: {
            header: {
                fontSize: 11,
                bold: true,
                margin: [0, 0, 0, 11],
                alignment: 'center'
            },
            tableBody: {
                fontSize: fontPreset.body
            }
        },
        footer: function (currentPage, pageCount) {
            const dateStr = new Intl.DateTimeFormat('de-DE', {
                dateStyle: 'short',
                timeStyle: 'short'
            }).format(new Date());
            return {
                margin: [40, 10, 40, 0],
                columns: [
                    {
                        text: dateStr,
                        alignment: 'left',
                        fontSize: 8
                    },
                    {
                        text: `Seite ${currentPage} von ${pageCount}`,
                        alignment: 'right',
                        fontSize: 8
                    }
                ]
            };
        }
    };
 
    const tableBody = tableNode.table.body;
 
    body.forEach((r, i) => {
 
        const row = tableBody[i + 1];
 
        // ROW COLOR
        if (styling.rowColor) {

            const color = resolveRowColor(r.row, styling.rowColor);

            if (color && alpha > 0) {

                if (styling.rowColor.fullrow) {
                    row.forEach(cell => {
                        if (!cell) return;
                        cell.fillColor = hexToPdfColor(color, alpha);
                    });
                } else {
                    row[0].fillColor = hexToPdfColor(color, alpha);
                }
            }
        }
 
        // COLUMN COLOR
        if (styling.columnColor) {

            const colorMap = buildColumnColorMap(r.row, styling.columnColor);

            // normale Tabellen-Spalten
            (cfg._columns || []).forEach((col, j) => {
                const matchKey = col.exportKey || col.data;
                const color = colorMap[matchKey];
                if (!color) return;
                const val = r.values[j];
                const shouldColor = styling.columnColor.fullcolumn ||
                    (val !== '' && Number(val) !== 0);
                if (shouldColor && alpha > 0) {
                    row[j].fillColor = hexToPdfColor(color, alpha);
                    row[j].bold = true;
                }
            });

            // dynamicKeys (Extra-Spalten)
            dynamicKeys.forEach((k, j) => {
                const colIndex = columnsCount + j;
                const val = r.values[colIndex];
                const color = colorMap[k];
                if (!color) return;
                const shouldColor = styling.columnColor.fullcolumn ||
                    (val !== '' && Number(val) !== 0);
                if (shouldColor && alpha > 0) {
                    row[colIndex].fillColor = hexToPdfColor(color, alpha);
                    row[colIndex].bold = true;
                }
            });
        }

        // ROW STYLE — bold / italic / underline / strike / text color
        if (styling.rowStyle) {
            const pdfStyle = pickPdfStyle(resolveRowStyle(r.row, styling.rowStyle));
            if (pdfStyle) {
                const cells = styling.rowStyle.fullrow ? row : [row[0]];
                cells.forEach(cell => {
                    if (!cell) return;
                    Object.assign(cell, pdfStyle);
                });
            }
        }

        // PER-CELL STYLE (dynamic columns only)
        if (typeof styling.cellStyle === 'function') {
            dynamicKeys.forEach((k, j) => {
                const colIndex = columnsCount + j;
                const cell = row[colIndex];
                if (!cell) return;
                const pdfStyle = pickPdfStyle(styling.cellStyle(r.row, k));
                if (pdfStyle) Object.assign(cell, pdfStyle);
            });
        }

        // EXTRA-COLUMN PER-ROW STYLE (cfg.extraColumns[].style callback).
        if (cfg._extraColumns?.length) {
            const [start] = cfg._extraRange || [0, 0];
            cfg._extraColumns.forEach((xcol, k) => {
                if (typeof xcol.style !== 'function') return;
                const cell = row[start + k];
                if (!cell) return;
                const pdfStyle = pickPdfStyle(xcol.style(r.row));
                if (pdfStyle) Object.assign(cell, pdfStyle);
            });
        }

        // REGULAR-COLUMN PER-ROW STYLE
        if (cfg._columns?.length) {
            cfg._columns.forEach((col, k) => {
                if (typeof col.exportStyle !== 'function') return;
                const cell = row[k];
                if (!cell) return;
                const pdfStyle = pickPdfStyle(col.exportStyle(r.row));
                if (!pdfStyle) return;

                // fillColor nicht überschreiben wenn bereits von rowColor/columnColor gesetzt
                const { fillColor: _drop, ...safeStyle } = pdfStyle;
                Object.assign(cell, safeStyle);
            });
        }
    });
 
    pdfMake.createPdf(doc).download(resolveExportName(cfg.filename, 'pdf', info));
}
 
 
function exportCSV(header, body, dynamicKeys, columnsCount, cfg = {}) {

    const sep = cfg.csvSeparator || ';';

    // RFC-4180-style quoting: values containing the separator, quotes or
    // newlines would otherwise shift columns in the output.
    const esc = (v) => {
        const s = String(v ?? '');
        return (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r'))
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
    };

    const rows = [
        header,
        ...body.map(r => r.values)
    ];

    // Summenzeile am Ende (nur Geld-Spalten, dynamisch aufgebaut)
    if (Array.isArray(cfg._totals)) {
        rows.push(cfg._totals);
    }

    const csv = rows.map(r => r.map(esc).join(sep)).join('\n');

    // Leading BOM so Excel detects UTF-8 (umlauts in Kassen-/Nutzernamen).
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
 
    const url = URL.createObjectURL(blob);
 
    const info = buildExportInfo(cfg);
    const a = document.createElement('a');
    a.href = url;
    a.download = resolveExportName(cfg.filename, 'csv', info);
    a.click();
    // Release the object URL once the browser has had a chance to start the
    // download — prevents the temporary blob from leaking memory.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
 
 
 
 
 
// =============================
// getExportColumns
// =============================
function getExportColumns(table) {
    return {
        exportOptions: {
            columns: (idx) => {
                const col = table.column(idx);
 
                // versteckte Spalten raus
                if (!col.visible()) return false;

                return true;
            }
        }
    };
}
 
// =============================
// buildExportData dynamic cols
// ============================= 
function buildExportData(ctx, cfg, allRows = null) {

    // serverSide exports pass the full filtered dataset explicitly in
    // `allRows`; otherwise we read the currently-filtered/ordered rows
    // from the live DataTable (client-side path — same as before).
    const data = allRows
        ? allRows
        : ctx.table
            .rows({ search: 'applied', order: 'applied' })
            .data()
            .toArray();
    // `dynamicColumns` accepts a single config object or an ARRAY of
    // configs — each entry contributes its own block of data-driven
    // columns (e.g. one block per payment type, a second block per
    // product group x payment type). Order in the array = column order.
    const dynCfg = cfg.dynamicColumns;
    const dynCfgs = Array.isArray(dynCfg)
        ? dynCfg
        : (dynCfg ? [dynCfg] : []);

    // Per source: collect keys over the dataset, optionally narrow them
    // to the export-settings selection (cfg._activeDynamicKeys[source]),
    // and build per-key format definitions. Accept both the new
    // `format` / `formats` naming and the legacy `exportFormat` /
    // `exportFormats` keys for compatibility.
    const dynSources = dynCfgs.map(dc => {
        const keySet = new Set();
        data.forEach(row => {
            (row[dc.source] || []).forEach(p => keySet.add(p[dc.key]));
        });
        let keys = Array.from(keySet).sort();

        // "Leere Spalten erzeugen": statt nur der in den (gefilterten)
        // Daten vorkommenden Keys die volle Menge aller möglichen Keys
        // (universe) verwenden, damit der Spaltenaufbau stabil bleibt
        // (z.B. für die Weiterverarbeitung in Excel). Greift nur, wenn das
        // universe für diese Quelle vorgeladen wurde (cfg._dynamicKeyUniverse).
        const universe = cfg._dynamicKeyUniverse?.[dc.source];
        if (cfg._dynamicIncludeEmpty && Array.isArray(universe)) {
            keys = Array.from(new Set([...universe, ...keys])).sort();
        }

        const selected = cfg._activeDynamicKeys?.[dc.source];
        if (Array.isArray(selected)) {
            keys = keys.filter(k => selected.includes(k));
        }

        const defs = keys.map(k => {
            const perKey = (dc.formats && dc.formats[k])
                ?? (dc.exportFormats && dc.exportFormats[k])
                ?? (dc.exportFormat && dc.exportFormat[k])
                ?? undefined;
            const global = dc.format ?? dc.exportFormat;
            const settingsMap = dc.formatSettings ?? dc.exportFormatSettings ?? {};
            const settings = (settingsMap && settingsMap[k]) || dc.formatSettings || dc.exportFormatSettings || undefined;
            if (perKey || global) return { exportFormat: perKey ?? global, exportFormatSettings: settings };
            return {};
        });

        // Anzeige-Label je Spalte: roher Key (für Wert-Lookup/Styling) +
        // optionaler `labelSuffix`, damit zwei Quellen mit gleichen Keys
        // (z.B. Summe je Zahlart + mehrzeilige Aufschlüsselung je Zahlart)
        // unterscheidbare Spaltenüberschriften erhalten.
        const labels = keys.map(k => k + (dc.labelSuffix || ''));

        return { dc, keys, defs, labels };
    });

    // Roh-Keys (für Wert-Lookup & Styling) bleiben unverändert; die Header
    // verwenden die ggf. mit `labelSuffix` versehenen Labels.
    const dynamicKeys   = dynSources.flatMap(s => s.keys);
    const dynamicLabels = dynSources.flatMap(s => s.labels);
    const dynamicDefs   = dynSources.flatMap(s => s.defs);
    
 
    const columns = (() => {
        // Baue eine Map: data-Wert → DataTables Column-Index
        const dataIndexMap = {};
        ctx.table.columns().every(function() {
            const settings = this.settings()[0].aoColumns[this.index()];
            const dataKey = settings?.mData;
            if (typeof dataKey === 'string') dataIndexMap[dataKey] = this.index();
        });

        return resolveColumns(ctx).filter(c => {
            if (c.export === false) return false;
            const activeKeys = cfg._activeColumnKeys;
            if (activeKeys) {
                const matchKey = c.exportSettingsKey || c.data;
                return activeKeys.includes(matchKey);
            }
            // kein Override → Colvis-Sichtbarkeit entscheidet
            const idx = dataIndexMap[c.data];
            if (idx !== undefined) {
                return ctx.table.column(idx).visible();
            }
            return true;
        });
    })();

    // Static extra columns that exist ONLY in the export (not in the live
    // DataTable, not in colvis). Each entry is { title, value, exportFormat?,
    // style? }; `value` is either a function (row) => any or a string key
    // path (dotted paths supported via getValue). Optional `style` is a
    // (row) => pdfMakeStyleObj | null callback applied per row to that
    // single column in PDF and Excel.
    const extraColumns = Array.isArray(cfg.extraColumns) ? cfg.extraColumns : [];

    const header = [
        ...columns.map(c => c.title || c.data || ''),
        ...extraColumns.map(c => c.title || ''),
        ...dynamicLabels
    ];
 
    const body = data.map(row => {
 
        const base = columns.map(col => {
            const rawVal = col.exportKey
                ? getValue(row, col.exportKey)
                : typeof col.data === 'function'
                    ? col.data(row, 'export', row, null)
                    : row[col.data];

            // render mit type='export' aufrufen wenn vorhanden
            if (typeof col.render === 'function') {
                const rendered = col.render(rawVal, 'export', row, null);
                // HTML-Tags entfernen falls render HTML zurückgibt
                const clean = typeof rendered === 'string'
                    ? rendered.replace(/<[^>]*>/g, '').trim()
                    : rendered;
                return col.exportFormat === false ? (clean ?? '') : formatValue(clean, col);
            }

            return col.exportFormat === false
                ? (rawVal ?? '')
                : formatValue(rawVal, col);
        });

        const extras = extraColumns.map(col => {
            const v = typeof col.value === 'function'
                ? col.value(row)
                : getValue(row, col.value);
            return formatValue(v, col);
        });
 
        // One value lookup per dynamic source, concatenated in source
        // order so the values line up with dynamicKeys/header.
        const dynamic = dynSources.flatMap(s => {
            // String-Spalten (exportFormat: false, z.B. mehrzeilige
            // Aufschlüsselung "5.00 × 1\n3.00 × 2") dürfen NICHT in Number()
            // gezwungen werden — das ergäbe NaN. Nur numerische Quellen
            // werden gecastet.
            const raw = s.dc.exportFormat === false;
            const map = {};
            (row[s.dc.source] || []).forEach(p => {
                const v = p[s.dc.value];
                map[p[s.dc.key]] = raw ? (v == null ? '' : v) : Number(v || 0);
            });
            return s.keys.map((k, j) => formatValue(map[k], s.defs[j] || {}));
        });
 
        return {
            row,
            values: [...base, ...extras, ...dynamic]
        };
    });

    // ── Summenzeile (dynamisch) ───────────────────────────
    // Am Ende der Export-Tabelle eine Zeile, die summiert:
    //  - alle Geld-Spalten (exportFormat 'float'), formatiert als Geld
    //  - alle Anzahl-Spalten: ganzzahlige DYNAMISCHE Spalten (z.B.
    //    group_quantities), formatiert als integer
    // Ganzzahlige Basis-/Extra-Spalten (z.B. Nutzer-IDs) werden NICHT
    // summiert. Bezieht sich automatisch nur auf die tatsächlich
    // exportierten Spalten. Aktivierung über cfg.totalsRow.
    let totals = null;
    if (cfg.totalsRow) {
        const colFormats = [
            ...columns.map(c => c.exportFormat),
            ...extraColumns.map(c => c.exportFormat),
            ...dynamicDefs.map(d => d && d.exportFormat),
        ];
        const dynStart = columns.length + extraColumns.length;
        const summable = colFormats.map((f, i) =>
            f === 'float' || (f === 'integer' && i >= dynStart));
        if (summable.some(Boolean)) {
            const sums = header.map(() => 0);
            body.forEach(r => {
                r.values.forEach((v, i) => {
                    if (!summable[i]) return;
                    const n = Number(v);
                    if (!isNaN(n)) sums[i] += n;
                });
            });
            // "Summe"-Label in die erste nicht-summierbare Spalte (sonst 0).
            const labelIdx = Math.max(0, summable.findIndex(s => !s));
            totals = header.map((_, i) => {
                if (summable[i]) {
                    const fmt = colFormats[i] === 'integer' ? 'integer' : 'float';
                    return formatValue(sums[i], { exportFormat: fmt });
                }
                return i === labelIdx ? (cfg.totalsLabel || 'Summe') : '';
            });
        }
    }

    return {
        header,
        body,
        totals,
        dynamicKeys,
        dynamicDefs,
        // columnsCount includes extras so dynamic-column styling
        // (columnColor / cellStyle) lines up with the right column index.
        columnsCount: columns.length + extraColumns.length,
        // The resolved live-column list, forwarded so exporters can apply
        // per-column `exportStyle` callbacks at indices [0, columns.length).
        columns,
        // Extras range expressed as [start, end) so the exporters can
        // apply per-extra-column `style` callbacks at the right offsets
        // without recomputing them.
        extraRange: [columns.length, columns.length + extraColumns.length],
        extraColumns
    };
}
 
 
class TableDataProvider {
    constructor(loaderFn) {
        this.loaderFn = loaderFn;

        this.cache = null;
        this.inFlight = null;
        this.requestId = 0;
        this.abortController = null;
    }

    async fetch({ force = false, _passthrough = null } = {}) {
        // dedupe — but only when not forcing: a force fetch must not
        // piggyback on a possibly-stale in-flight request.
        if (!force && this.cache) return this.cache;
        if (!force && this.inFlight) return this.inFlight;

        if (this.abortController) this.abortController.abort();
        this.abortController = new AbortController();
        const requestId = ++this.requestId;

        // Forward optional caller-supplied opts (e.g. { filters }) to the
        // loader. The abort signal is always injected and overrides any
        // signal the caller passed, because this provider owns cancellation.
        const loaderOpts = {
            ..._passthrough,
            signal: this.abortController.signal
        };

        const p = Promise.resolve(this.loaderFn(loaderOpts))
        .then(data => {
            if (requestId !== this.requestId) return;
            this.cache = data;
            return data;
        })
        .finally(() => {
            // Only clear if a forced re-fetch hasn't replaced us already.
            if (this.inFlight === p) this.inFlight = null;
        });

        this.inFlight = p;
        return p;
    }
    clear() {
        this.cache = null;
    }

    invalidate() {
        this.cache = null;
    }
}

function hexToXlsx(hex) {
    if (!hex) return 'FFFFFF';
    hex = hex.replace('#', '');
    if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
    }
    return hex.toUpperCase();
}

function hexToArgbLight(hex, alpha = 0.3) {
    if (!hex) return 'FFFFFFFF';
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const blend = c => Math.round(c * alpha + 255 * (1 - alpha));
    const toHex = c => blend(c).toString(16).padStart(2, '0').toUpperCase();
    return 'FF' + toHex(r) + toHex(g) + toHex(b);
}
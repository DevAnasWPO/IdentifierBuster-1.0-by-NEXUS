import { queueClient } from './queueClient.js';
import { toast } from './toast.js';
import { ensureBattleMetricsTokenReady } from './api.js';

// modules/display.js

const NOTE_STORAGE_KEY = 'ib-player-notes-v1';
const noteSaveTimers = new Map();
let noteStore = loadNoteStore();

/**
 * Renders the processed player data into a table and injects it into the page.
 * @param {HTMLElement} parentElement The element where the button was, to find the injection point.
 * @param {object[]} playerData An array of processed player data objects.
 * @param {string} mainPlayerId The BattleMetrics ID of the main player to highlight them.
 */
export function displayData(parentElement, playerData, mainPlayerId) {
    expandParentColumn(parentElement);
    const host = resolveInjectionHost(parentElement);
    if (!host) {
        console.error('IdentifierBuster: unable to resolve an injection host for details view.');
        return;
    }

    host.innerHTML = '';
    const table = createDetailsTable(playerData, mainPlayerId);
    host.appendChild(table);
}

function expandParentColumn(element) {
    if (!element?.closest) return;
    const column = element.closest('.col-md-6');
    if (column) {
        column.classList.add('ib-expanded-column');
    }
}

function resolveInjectionHost(parentElement) {
    if (!parentElement) return null;
    const collapseContainer = parentElement.parentElement?.querySelector?.('.collapse');
    if (collapseContainer) return collapseContainer;

    const preferredAncestors = [
        '.ib-details-host',
        '.css-98ica9',
        '.css-6rqk0u',
        '.card',
        '.panel',
        '.list-group-item',
        '.css-0'
    ];

    for (const selector of preferredAncestors) {
        const ancestor = parentElement.closest?.(selector);
        if (!ancestor) continue;
        if (selector === '.ib-details-host') {
            return ancestor;
        }
        const existingHost = ancestor.querySelector('.ib-details-host');
        if (existingHost) {
            return existingHost;
        }
        const host = document.createElement('div');
        host.className = 'ib-details-host';
        ancestor.appendChild(host);
        return host;
    }

    const fallbackParent = parentElement.parentElement || parentElement;
    if (!fallbackParent) return null;
    let fallbackHost = fallbackParent.querySelector?.('.ib-details-host');
    if (!fallbackHost) {
        fallbackHost = document.createElement('div');
        fallbackHost.className = 'ib-details-host';
        fallbackParent.appendChild(fallbackHost);
    }
    return fallbackHost;
}

/**
 * Creates the main HTML structure for the details table.
 * @param {object[]} data The array of processed player data.
 * @param {string} mainPlayerId The ID of the main player for highlighting.
 * @returns {HTMLElement} The fully constructed table element.
 */
function createDetailsTable(data, mainPlayerId) {
    const container = document.createElement('div');
    container.className = 'details-compact-container';

    const peersOnly = Array.isArray(data)
        ? data.filter(player => player.id !== mainPlayerId)
        : [];
    const sortedData = [...peersOnly];
    sortedData.sort((a, b) => {
        if (a.id === mainPlayerId) return -1;
        if (b.id === mainPlayerId) return 1;
        return 0;
    });

    const state = {
        data: sortedData,
        filters: {
            severity: 'all',
            recentOnly: false,
            associatesOnly: false
        },
        mainPlayerId,
        listEl: null,
        currentView: []
    };

    const summary = buildSummaryStats(sortedData);
    container.appendChild(renderInsightPanel(summary));

    const legend = document.createElement('div');
    legend.className = 'compact-legend';
    legend.innerHTML = `
        <span class="legend-player">Player</span>
        <span class="legend-stat" title="Risk score">R</span>
        <span class="legend-stat" title="Name Match %">N</span>
        <span class="legend-stat" title="Shared Identifiers">A</span>
        <span class="legend-stat" title="Shared Profile Picture">P</span>
        <span class="legend-risk" title="Risk color legend">
            <span class="risk-dot risk-clean"></span>
            <span>Clean</span>
            <span class="risk-dot risk-watch"></span>
            <span>Watch</span>
            <span class="risk-dot risk-risky"></span>
            <span>Risky</span>
            <span class="risk-dot risk-critical"></span>
            <span>Critical</span>
        </span>
    `;
    container.appendChild(legend);

    const list = document.createElement('div');
    list.className = 'compact-list';
    state.listEl = list;

    state.updateView = () => {
        const filtered = applyFilters(state.data, state.filters, state.mainPlayerId);
        state.currentView = filtered;
        renderPlayerCards(list, filtered, state.mainPlayerId);
    };

    const filterBar = renderFilterControls(state);
    container.appendChild(filterBar);

    state.updateView();

    container.appendChild(list);
    return container;
}

/**
 * A simple utility to escape HTML to prevent XSS issues with player names.
 * @param {string} str The string to escape.
 * @returns {string} The escaped string.
 */
function escapeHTML(str) {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(str));
    return p.innerHTML;
}

function renderTimeline(timeline) {
    if (!timeline) return '';
    const markers = Array.isArray(timeline.markers) ? timeline.markers : [];
    const markerHtml = markers.map(marker => {
        const markerTitle = escapeHTML(`${marker.dateLabel}${marker.label ? ` • ${marker.label}` : ''}`);
        return `<span class="timeline-marker" style="left:${marker.pct}%" title="${markerTitle}"></span>`;
    }).join('');

    const tooltip = escapeHTML(`Activity span: ${timeline.spanDays} day(s)`);

    return `
        <div class="timeline" title="${tooltip}">
            <div class="timeline-track">
                <div class="timeline-range"></div>
                ${markerHtml}
            </div>
            <div class="timeline-labels">
                <span>${timeline.startLabel}</span>
                <span>${timeline.endLabel}</span>
            </div>
        </div>
    `;
}

function buildSummaryStats(data = []) {
    const total = data.length;
    const riskCounts = { critical: 0, risky: 0, watch: 0, clean: 0 };
    let recentActivity = 0;
    let sharedAssociates = 0;

    const topRisks = [...data]
        .filter(player => player.risk)
        .sort((a, b) => (b.risk?.score || 0) - (a.risk?.score || 0))
        .slice(0, 3)
        .map(player => ({
            id: player.id,
            name: player.name,
            score: player.risk.score,
            severity: player.risk.severity
        }));

    data.forEach(player => {
        if (typeof player?.risk?.severity === 'string') {
            const key = player.risk.severity.toLowerCase();
            if (riskCounts[key] !== undefined) {
                riskCounts[key] += 1;
            }
        }
        if (typeof player.lastSeenDaysAgo === 'number' && player.lastSeenDaysAgo <= 7) {
            recentActivity += 1;
        }
        if ((player.associates || 0) >= 3) {
            sharedAssociates += 1;
        }
    });

    return {
        total,
        riskCounts,
        recentActivity,
        sharedAssociates,
        topRisks
    };
}

function renderInsightPanel(summary) {
    const panel = document.createElement('section');
    panel.className = 'insight-panel';

    const totalLabel = summary.total === 1 ? 'Player loaded' : 'Players loaded';
    const riskyPercent = summary.total > 0
        ? Math.round(((summary.riskCounts.risky + summary.riskCounts.critical) / summary.total) * 100)
        : 0;

    const topRiskItems = summary.topRisks.length
        ? summary.topRisks.map(player => {
            const severity = (player.severity || 'Clean').toLowerCase();
            const safeName = escapeHTML(player.name || 'Unknown');
            return `<li>
                <span class="risk-dot risk-${severity}"></span>
                <span class="insight-top-name">${safeName}</span>
                <span class="insight-top-score">${player.score}</span>
            </li>`;
        }).join('')
        : '<li class="insight-empty">No risk data yet</li>';

    panel.innerHTML = `
        <div class="insight-grid">
            <div class="insight-card">
                <span class="insight-label">${totalLabel}</span>
                <span class="insight-value">${summary.total}</span>
                <span class="insight-sub">${riskyPercent}% flagged</span>
            </div>
            <div class="insight-card">
                <span class="insight-label">Active &lt; 7d</span>
                <span class="insight-value">${summary.recentActivity}</span>
                <span class="insight-sub">Recently seen in servers</span>
            </div>
            <div class="insight-card">
                <span class="insight-label">Shared IDs ≥ 3</span>
                <span class="insight-value">${summary.sharedAssociates}</span>
                <span class="insight-sub">Potential groups</span>
            </div>
        </div>
        <div class="insight-toplist">
            <div class="insight-top-header">Top Risk Targets</div>
            <ul>${topRiskItems}</ul>
        </div>
    `;

    return panel;
}

function loadNoteStore() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return {};
    }
    try {
        const raw = window.localStorage.getItem(NOTE_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (error) {
        console.warn('Failed to load player notes, continuing without persistence.', error);
        return {};
    }
}

function persistNoteStore() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }
    try {
        window.localStorage.setItem(NOTE_STORAGE_KEY, JSON.stringify(noteStore));
    } catch (error) {
        console.warn('Failed to persist player notes.', error);
    }
}

function getPlayerNotes(playerId) {
    if (!playerId) return { note: '', tags: '' };
    return noteStore[playerId] || { note: '', tags: '' };
}

function savePlayerNotes(playerId, payload) {
    if (!playerId) return;
    const trimmedNote = (payload.note || '').trim();
    const trimmedTags = (payload.tags || '').trim();
    if (!trimmedNote && !trimmedTags) {
        if (noteStore[playerId]) {
            delete noteStore[playerId];
        }
    } else {
        noteStore[playerId] = { note: trimmedNote, tags: trimmedTags };
    }
    persistNoteStore();
}

function renderFilterControls(state) {
    const bar = document.createElement('section');
    bar.className = 'filter-bar';
    bar.innerHTML = `
        <div class="filter-group">
            <span class="filter-label">Show:</span>
            <button class="filter-button active" data-filter="severity" data-value="all">All</button>
            <button class="filter-button" data-filter="severity" data-value="critical">Critical</button>
            <button class="filter-button" data-filter="severity" data-value="risky">Risky +</button>
        </div>
        <div class="filter-group">
            <span class="filter-label">Refine:</span>
            <button class="filter-chip" data-flag="recent">Seen &lt; 7d</button>
            <button class="filter-chip" data-flag="associates">Shared IDs ≥ 3</button>
        </div>
        <div class="filter-actions">
            <button class="filter-copy" type="button" title="Copy visible summary">Copy summary</button>
            <button class="filter-export" type="button" title="Download CSV for visible players">Export CSV</button>
            <span class="filter-note" data-role="copy-status" aria-live="polite"></span>
        </div>
    `;

    const severityButtons = bar.querySelectorAll('[data-filter="severity"]');
    severityButtons.forEach(button => {
        button.addEventListener('click', () => {
            severityButtons.forEach(b => b.classList.remove('active'));
            button.classList.add('active');
            state.filters.severity = button.dataset.value;
            state.updateView();
        });
    });

    const toggleFlag = (flagKey, button) => {
        state.filters[flagKey] = !state.filters[flagKey];
        button.classList.toggle('active', state.filters[flagKey]);
        state.updateView();
    };

    const recentBtn = bar.querySelector('[data-flag="recent"]');
    const associatesBtn = bar.querySelector('[data-flag="associates"]');
    recentBtn.addEventListener('click', () => toggleFlag('recentOnly', recentBtn));
    associatesBtn.addEventListener('click', () => toggleFlag('associatesOnly', associatesBtn));

    const copyBtn = bar.querySelector('.filter-copy');
    const statusEl = bar.querySelector('[data-role="copy-status"]');
    const setStatus = (msg, ok = true) => {
        statusEl.textContent = msg;
        statusEl.classList.toggle('error', !ok);
        if (msg) {
            setTimeout(() => {
                statusEl.textContent = '';
                statusEl.classList.remove('error');
            }, 2500);
        }
    };

    copyBtn.addEventListener('click', async () => {
        try {
            const summaryText = buildCopySummary(state);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(summaryText);
            } else {
                const temp = document.createElement('textarea');
                temp.value = summaryText;
                document.body.appendChild(temp);
                temp.select();
                document.execCommand('copy');
                document.body.removeChild(temp);
            }
            setStatus('Copied summary');
        } catch (err) {
            console.error('Copy failed', err);
            setStatus('Copy failed', false);
        }
    });

    const exportBtn = bar.querySelector('.filter-export');
    exportBtn.addEventListener('click', () => handleCsvExport(state, setStatus));

    return bar;
}

function getActivePlayers(state) {
    return state.currentView && state.currentView.length
        ? state.currentView
        : applyFilters(state.data, state.filters, state.mainPlayerId);
}

function buildCopySummary(state) {
    const active = getActivePlayers(state);
    const filters = state.filters;
    const header = [
        'IdentifierBuster Investigator Summary',
        `Players shown: ${active.length}`,
        `Filter - Severity: ${filters.severity}, Recent: ${filters.recentOnly ? 'Yes' : 'No'}, Shared IDs: ${filters.associatesOnly ? 'Yes' : 'No'}`
    ];
    const lines = active.map(player => {
        const risk = player.risk || { score: 0, severity: 'Clean' };
        const rgb = player.banStatus?.rgb || 0;
        const sb = player.banStatus?.sb || 0;
        const last = player.lastSeen ? `Last: ${player.lastSeen}` : 'Last: Unknown';
        return `${player.name} | ${risk.severity} ${risk.score} | RGB ${rgb} / SB ${sb} | ${last}`;
    });
    return [...header, '---', ...lines].join('\n');
}

function handleCsvExport(state, setStatus) {
    try {
        const csv = buildCsvExport(state);
        const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
        const filename = `identifierbuster-${timestamp}.csv`;
        downloadTextFile(csv, filename, 'text/csv;charset=utf-8;');
        setStatus('CSV exported');
    } catch (error) {
        console.error('CSV export failed', error);
        setStatus('Export failed', false);
    }
}

function buildCsvExport(state) {
    const active = getActivePlayers(state);
    const headers = [
        'Player', 'BattleMetrics ID', 'SteamID64', 'Risk Severity', 'Risk Score',
        'Name Match %', 'Shared IDs', 'Last Seen', 'First Seen',
        'RGB Bans', 'Suspicious Bans', 'VAC', 'Notes', 'Tags'
    ];

    const rows = active.map(player => {
        const risk = player.risk || { severity: 'Clean', score: 0 };
        const noteData = getPlayerNotes(player.id);
        return [
            player.name || 'Unknown',
            player.id || '',
            player.steamId || '',
            risk.severity || 'Clean',
            risk.score ?? 0,
            player.nameMatch ?? '',
            player.associates ?? '',
            player.lastSeen || '',
            player.firstSeen || '',
            player.banStatus?.rgb ?? 0,
            player.banStatus?.sb ?? 0,
            player.banStatus?.vac ? 'Yes' : 'No',
            noteData.note || '',
            noteData.tags || ''
        ].map(csvEscape).join(',');
    });

    return [headers.join(','), ...rows].join('\n');
}

function csvEscape(value) {
    if (value == null) return '';
    const stringValue = String(value).replace(/\r?\n|\r/g, ' ');
    if (stringValue.includes(',') || stringValue.includes('"')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
}

function downloadTextFile(contents, filename, mimeType = 'text/plain') {
    const blob = new Blob([contents], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function applyFilters(data, filters, mainPlayerId) {
    const filtered = data.filter(player => {
        const severity = (player.risk?.severity || 'Clean').toLowerCase();
        if (filters.severity === 'critical' && severity !== 'critical') return false;
        if (filters.severity === 'risky' && severity !== 'critical' && severity !== 'risky') return false;
        if (filters.recentOnly && (typeof player.lastSeenDaysAgo !== 'number' || player.lastSeenDaysAgo > 7)) return false;
        if (filters.associatesOnly && (!player.associates || player.associates < 3)) return false;
        return true;
    });

    return filtered;
}

function renderPlayerCards(listEl, players, mainPlayerId) {
    listEl.innerHTML = '';
    if (!Array.isArray(players) || players.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ib-empty-state';
        empty.textContent = 'No other profiles share this identifier yet.';
        listEl.appendChild(empty);
        return;
    }
    players.forEach(player => {
        const card = buildPlayerCard(player, mainPlayerId);
        listEl.appendChild(card);
    });
}

function buildPlayerCard(player, mainPlayerId) {
    const formatDaysSuffix = (days) => (typeof days === 'number' && days >= 0 ? `${days}d` : null);
    const isMainPlayer = player.id === mainPlayerId;
    const card = document.createElement('div');
    card.classList.add('player-card');

    let banLevel = 'clean';
    if (player.banStatus?.rgb > 0 || player.banStatus?.vac) banLevel = 'banned';
    else if (player.banStatus?.sb > 0) banLevel = 'suspicious';
    card.classList.add(`ban-level-${banLevel}`);
    if (isMainPlayer) card.classList.add('main-player');

    const banTags = [];
    if (player.banStatus?.rgb > 0) {
        const rgbDays = formatDaysSuffix(player.banStatus.rgbDaysAgo);
        const rgbLabel = rgbDays ? `${player.banStatus.rgb} RGB (${rgbDays})` : `${player.banStatus.rgb} RGB`;
        banTags.push(`<span class="ban-tag rgb-ban" title="${player.banStatus.rgb} Rust Game Ban(s)">${rgbLabel}</span>`);
    }
    if (player.banStatus?.vac) {
        banTags.push('<span class="ban-tag vac-ban" title="VAC Banned">VAC</span>');
    }
    if (player.banStatus?.sb > 0) {
        const sbDays = formatDaysSuffix(player.banStatus.sbDaysAgo);
        const sbMeta = [];
        if (player.banStatus.sbReason) sbMeta.push(player.banStatus.sbReason);
        if (sbDays) sbMeta.push(sbDays);
        const sbLabelText = sbMeta.length ? `${player.banStatus.sb} SB (${sbMeta.join(', ')})` : `${player.banStatus.sb} SB`;
        const sbLabelSafe = escapeHTML(sbLabelText);
        const sbTitleParts = [`${player.banStatus.sb} Suspicious Ban(s) on BattleMetrics`];
        if (player.banStatus.sbReasonDetail) sbTitleParts.push(`Reason: ${player.banStatus.sbReasonDetail}`);
        const sbTitleSafe = escapeHTML(sbTitleParts.join(' • '));
        banTags.push(`<span class="ban-tag sb-ban" title="${sbTitleSafe}">${sbLabelSafe}</span>`);
    }
    const banContent = banTags.length ? banTags.join('') : '<span class="detail-muted">None</span>';

    const nameBadgeVariant = player.nameMatch >= 65 ? 'positive' : player.nameMatch >= 35 ? 'neutral' : 'alert';
    const associatesVariant = player.associates > 0 ? 'alert' : 'neutral';
    const profileVariant = player.profilePicMatch ? 'positive' : 'neutral';
    const profileSymbol = player.profilePicMatch ? '✔' : '—';
    const escapedName = escapeHTML(player.name);
    const firstSeenTitle = player.firstSeenDaysAgo != null ? `${player.firstSeenDaysAgo} days ago` : 'First seen date unavailable';
    const lastSeenTitle = player.lastSeenDaysAgo != null ? `${player.lastSeenDaysAgo} days ago` : 'Last seen date unavailable';

    const riskInfo = player.risk || { score: 0, severity: 'Clean', reasons: ['No data'] };
    const riskSeverity = (riskInfo.severity || 'Clean').toLowerCase();
    const riskReasons = Array.isArray(riskInfo.reasons) && riskInfo.reasons.length > 0
        ? riskInfo.reasons.join('\n')
        : 'No elevated signals';
    const riskTitle = escapeHTML(`${riskInfo.severity} (${riskInfo.score})\n${riskReasons}`);
    const timelineHtml = renderTimeline(player.timeline);

    card.innerHTML = `
        <div class="card-main">
            <div class="card-name-row">
                <a class="card-name" href="/rcon/players/${player.id}" target="_blank" title="Open BattleMetrics profile">${escapedName}</a>
                <span class="risk-badge risk-${riskSeverity}" title="${riskTitle}">
                    <span class="stat-label">Risk (R)</span>
                    <span class="risk-score">${riskInfo.score}</span>
                    <span class="risk-label">${riskInfo.severity}</span>
                </span>
            </div>
            <div class="card-stats" role="list" aria-label="Similarity stats">
                <span class="stat-badge ${nameBadgeVariant}" data-metric="name" title="Name similarity">
                    <span class="stat-label">Name (N)</span>
                    <span class="stat-value">${player.nameMatch}%</span>
                </span>
                <span class="stat-badge ${associatesVariant}" data-metric="identifiers" title="Shared identifiers">
                    <span class="stat-label">Identifiers (A)</span>
                    <span class="stat-value">${player.associates}</span>
                </span>
                <span class="stat-badge ${profileVariant}" data-metric="profile" title="Shared profile picture">
                    <span class="stat-label">PFP (P)</span>
                    <span class="stat-value">${profileSymbol}</span>
                </span>
            </div>
        </div>
        <div class="card-details">
            <div class="detail">
                <span class="detail-label">First</span>
                <span class="detail-value" title="${firstSeenTitle}">${player.firstSeen}</span>
            </div>
            <div class="detail">
                <span class="detail-label">Last</span>
                <span class="detail-value" title="${lastSeenTitle}">${player.lastSeen}</span>
            </div>
            <div class="detail detail-bans">
                ${banContent}
            </div>
        </div>
        <div class="card-actions" role="group" aria-label="Player actions">
            <button type="button" class="action-button" data-action="queue-followup" title="Queue a fresh background fetch">Follow-up</button>
            <button type="button" class="action-button" data-action="copy-identifiers" title="Copy BattleMetrics + Steam identifiers">Copy IDs</button>
            <button type="button" class="action-button ghost" data-action="open-bm" title="Open BattleMetrics profile">Open BM</button>
        </div>
        <div class="card-notes collapsed" data-player-id="${player.id}">
            <button type="button" class="note-toggle" aria-expanded="false">
                <span class="note-toggle-label">Notes & Tags</span>
                <span class="note-summary" data-role="note-summary">Add notes</span>
                <span class="note-chevron" aria-hidden="true"></span>
            </button>
            <div class="note-body" hidden>
                <div class="note-field note-text">
                    <label>Case note</label>
                    <textarea class="note-input" rows="2" placeholder="Add quick investigator notes"></textarea>
                </div>
                <div class="note-field note-tags">
                    <label>Tags</label>
                    <input class="tags-input" type="text" placeholder="comma separated" />
                    <div class="tag-preview" data-role="tag-preview"></div>
                </div>
                <span class="note-status" aria-live="polite"></span>
            </div>
        </div>
        ${timelineHtml}
    `;

    wirePlayerActions(card, player);
    wirePlayerNotes(card, player);
    return card;
}

function wirePlayerActions(card, player) {
    const followBtn = card.querySelector('[data-action="queue-followup"]');
    const copyBtn = card.querySelector('[data-action="copy-identifiers"]');
    const openBtn = card.querySelector('[data-action="open-bm"]');

    if (followBtn) {
        followBtn.addEventListener('click', () => handleQueueFollowUp(followBtn, player));
    }
    if (copyBtn) {
        copyBtn.addEventListener('click', () => handleCopyIdentifiers(copyBtn, player));
    }
    if (openBtn) {
        openBtn.addEventListener('click', () => openBattleMetricsProfile(player.id));
    }
}

function wirePlayerNotes(card, player) {
    const noteSection = card.querySelector('.card-notes');
    if (!noteSection) return;
    const noteInput = noteSection.querySelector('.note-input');
    const tagsInput = noteSection.querySelector('.tags-input');
    const statusEl = noteSection.querySelector('.note-status');
    const toggleButton = noteSection.querySelector('.note-toggle');
    const noteBody = noteSection.querySelector('.note-body');
    const summaryEl = noteSection.querySelector('[data-role="note-summary"]');
    const previewEl = noteSection.querySelector('[data-role="tag-preview"]');

    const saved = getPlayerNotes(player.id);
    if (noteInput) noteInput.value = saved.note || '';
    if (tagsInput) tagsInput.value = saved.tags || '';
    updateTagPreview(previewEl, saved.tags);

    const setCollapsed = (collapsed) => {
        if (!noteSection || !noteBody || !toggleButton) return;
        noteSection.classList.toggle('collapsed', collapsed);
        noteBody.hidden = collapsed;
        toggleButton.setAttribute('aria-expanded', (!collapsed).toString());
    };

    const summarize = () => {
        const noteText = noteInput?.value?.trim() || '';
        const tagsText = tagsInput?.value?.trim() || '';
        if (!summaryEl) return;
        if (noteText) {
            summaryEl.textContent = truncateText(noteText, 48);
            return;
        }
        if (tagsText) {
            const firstTags = tagsText
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean)
                .slice(0, 2)
                .join(', ');
            summaryEl.textContent = firstTags || 'Add notes';
            return;
        }
        summaryEl.textContent = 'Add notes';
    };

    toggleButton?.addEventListener('click', () => {
        const collapsed = noteSection.classList.contains('collapsed');
        setCollapsed(!collapsed);
    });

    const commit = () => {
        const payload = {
            note: noteInput?.value || '',
            tags: tagsInput?.value || ''
        };
        savePlayerNotes(player.id, payload);
        updateTagPreview(previewEl, payload.tags);
        setNoteStatus(statusEl, 'Saved');
        summarize();
    };

    const scheduleSave = () => {
        setNoteStatus(statusEl, 'Saving…');
        scheduleNoteSave(player.id, commit);
    };

    const ensureExpanded = () => setCollapsed(false);

    noteInput?.addEventListener('focus', ensureExpanded);
    tagsInput?.addEventListener('focus', ensureExpanded);

    noteInput?.addEventListener('input', () => {
        summarize();
        scheduleSave();
    });
    tagsInput?.addEventListener('input', () => {
        updateTagPreview(previewEl, tagsInput.value);
        summarize();
        scheduleSave();
    });

    noteInput?.addEventListener('blur', commit);
    tagsInput?.addEventListener('blur', commit);

    summarize();
    setCollapsed(true);
}

function scheduleNoteSave(playerId, callback) {
    if (noteSaveTimers.has(playerId)) {
        clearTimeout(noteSaveTimers.get(playerId));
    }
    const timer = setTimeout(() => {
        callback();
        noteSaveTimers.delete(playerId);
    }, 600);
    noteSaveTimers.set(playerId, timer);
}

function setNoteStatus(element, message) {
    if (!element) return;
    element.textContent = message;
    if (message) {
        setTimeout(() => {
            if (element.textContent === message) {
                element.textContent = '';
            }
        }, 2000);
    }
}

function updateTagPreview(previewElement, tagsValue = '') {
    if (!previewElement) return;
    const tags = tagsValue
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);
    if (tags.length === 0) {
        previewElement.innerHTML = '';
        previewElement.classList.remove('has-tags');
        return;
    }
    previewElement.classList.add('has-tags');
    previewElement.innerHTML = tags
        .map(tag => `<span class="tag-chip">${escapeHTML(tag)}</span>`)
        .join('');
}

function truncateText(value, maxLength = 48) {
    if (!value) return '';
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

async function handleQueueFollowUp(button, player) {
    if (button.dataset.busy === 'true') return;
    button.dataset.busy = 'true';
    button.classList.add('busy');

    const toastHandle = toast.info({
        title: 'Queueing follow-up',
        message: `Refreshing ${player.name} via background queue…`,
        duration: 0
    });

    try {
        await ensureBattleMetricsTokenReady();
        await queueClient.enqueue('fetchPlayerBundle', { playerId: player.id }, 1);
        toastHandle.update({
            title: 'Follow-up complete',
            message: `${player.name} will refresh shortly.`,
            type: 'success',
            duration: 4000
        });
    } catch (error) {
        toastHandle.update({
            title: 'Follow-up failed',
            message: error?.message || 'Unable to queue follow-up',
            type: 'error',
            duration: 0
        });
    } finally {
        button.dataset.busy = 'false';
        button.classList.remove('busy');
    }
}

async function handleCopyIdentifiers(button, player) {
    if (button.dataset.busy === 'true') return;
    button.dataset.busy = 'true';
    button.classList.add('busy');

    const payload = formatIdentifierClipboard(player);
    try {
        await copyToClipboard(payload);
        toast.success({
            title: 'Identifiers copied',
            message: `${player.name} details are ready to paste.`,
            duration: 3500
        });
    } catch (error) {
        toast.error({
            title: 'Copy failed',
            message: error?.message || 'Unable to access clipboard',
            duration: 0
        });
    } finally {
        button.dataset.busy = 'false';
        button.classList.remove('busy');
    }
}

function openBattleMetricsProfile(playerId) {
    if (!playerId) return;
    const url = `/rcon/players/${playerId}`;
    window.open(url, '_blank', 'noopener');
}

function formatIdentifierClipboard(player) {
    const lines = [
        `Player: ${player.name || 'Unknown'}`,
        `BattleMetrics ID: ${player.id || 'n/a'}`
    ];
    if (player.steamId) {
        lines.push(`SteamID64: ${player.steamId}`);
    }
    if (player.risk) {
        lines.push(`Risk: ${player.risk.severity || 'Clean'} (${player.risk.score ?? 0})`);
    }
    if (player.banStatus) {
        const rgb = player.banStatus.rgb || 0;
        const sb = player.banStatus.sb || 0;
        lines.push(`Bans → RGB: ${rgb}, Suspicious: ${sb}`);
    }
    if (player.lastSeen) {
        lines.push(`Last seen: ${player.lastSeen}`);
    }
    if (player.associates != null) {
        lines.push(`Shared identifiers: ${player.associates}`);
    }
    return lines.join('\n');
}

async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const successful = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (!successful) {
                reject(new Error('Copy command failed'));
                return;
            }
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}
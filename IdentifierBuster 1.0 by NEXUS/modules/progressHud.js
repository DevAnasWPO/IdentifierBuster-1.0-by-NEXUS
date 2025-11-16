import { queueClient } from './queueClient.js';

const HUD_ID = 'ib-queue-hud';

const formatDuration = (ms) => {
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
};

const formatTimestamp = (timestamp) => {
    if (!timestamp) return null;
    const delta = Date.now() - timestamp;
    if (delta < 0) return 'just now';
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
};

const ensureHud = () => {
    let hud = document.getElementById(HUD_ID);
    if (hud) return hud;

    hud = document.createElement('section');
    hud.id = HUD_ID;
    hud.innerHTML = `
        <header class="hud-header">
            <div>
                <span class="hud-title">IdentifierBuster queue</span>
                <span class="hud-status" data-field="status">idle</span>
            </div>
            <button class="hud-toggle" type="button" aria-label="Toggle queue panel">−</button>
        </header>
        <div class="hud-body">
            <div class="hud-row">
                <div class="hud-stat">
                    <span class="hud-stat__label">Pending</span>
                    <span class="hud-stat__value" data-field="pending">0</span>
                </div>
                <div class="hud-stat">
                    <span class="hud-stat__label">Running</span>
                    <span class="hud-stat__value" data-field="active">0</span>
                </div>
                <div class="hud-stat">
                    <span class="hud-stat__label">Throughput</span>
                    <span class="hud-stat__value" data-field="throughput">0/m</span>
                </div>
            </div>
            <div class="hud-row">
                <div class="hud-stat">
                    <span class="hud-stat__label">Avg duration</span>
                    <span class="hud-stat__value" data-field="duration">—</span>
                </div>
                <div class="hud-stat">
                    <span class="hud-stat__label">Delay</span>
                    <span class="hud-stat__value" data-field="delay">—</span>
                </div>
                <div class="hud-stat">
                    <span class="hud-stat__label">Errors</span>
                    <span class="hud-stat__value" data-field="errors">0</span>
                </div>
            </div>
            <div class="hud-footer">
                <div>
                    <span class="hud-stat__label">Completed</span>
                    <span class="hud-stat__value" data-field="completed">0</span>
                </div>
                <div>
                    <span class="hud-stat__label">Failed</span>
                    <span class="hud-stat__value" data-field="failed">0</span>
                </div>
            </div>
            <div class="hud-error" data-field="errorWrapper">
                <span class="hud-stat__label">Last error</span>
                <span class="hud-error__message" data-field="errorMessage">None</span>
                <span class="hud-error__time" data-field="errorTime"></span>
            </div>
        </div>
    `;

    const toggleButton = hud.querySelector('.hud-toggle');
    toggleButton.addEventListener('click', () => {
        hud.classList.toggle('collapsed');
        toggleButton.textContent = hud.classList.contains('collapsed') ? '+' : '−';
    });

    document.body.appendChild(hud);
    return hud;
};

const updateHud = (snapshot) => {
    if (!snapshot) return;
    const hud = ensureHud();
    const getField = (name) => hud.querySelector(`[data-field="${name}"]`);

    getField('pending').textContent = snapshot.pending ?? 0;
    getField('active').textContent = snapshot.active ?? 0;
    getField('throughput').textContent = `${snapshot.throughputPerMin ?? 0}/m`;
    getField('duration').textContent = formatDuration(snapshot.avgDurationMs);
    const cooldownMs = snapshot.cooldownRemainingMs || 0;
    const delayField = getField('delay');
    delayField.textContent = formatDuration(cooldownMs > 0 ? cooldownMs : snapshot.delayMs);
    getField('errors').textContent = snapshot.errorSampleCount ?? 0;
    getField('completed').textContent = snapshot.totalCompleted ?? 0;
    getField('failed').textContent = snapshot.totalFailed ?? 0;

    const statusField = getField('status');
    const status = cooldownMs > 0
        ? 'cooldown'
        : snapshot.active > 0
            ? 'running'
            : snapshot.pending > 0
                ? 'queued'
                : 'idle';
    statusField.textContent = status;
    statusField.dataset.state = status;

    const errorWrapper = getField('errorWrapper');
    const errorMessage = getField('errorMessage');
    const errorTime = getField('errorTime');
    if (snapshot.lastError) {
        errorWrapper.classList.add('has-error');
        errorMessage.textContent = snapshot.lastError.message || 'Unknown error';
        errorTime.textContent = formatTimestamp(snapshot.lastError.timestamp);
    } else {
        errorWrapper.classList.remove('has-error');
        errorMessage.textContent = 'None';
        errorTime.textContent = '';
    }
};

export async function mountQueueHud() {
    ensureHud();
    queueClient.on('queueMetrics', ({ snapshot }) => updateHud(snapshot));
    try {
        const initial = await queueClient.getMetrics();
        updateHud(initial);
    } catch (error) {
        console.debug('Failed to bootstrap queue metrics', error);
    }
}

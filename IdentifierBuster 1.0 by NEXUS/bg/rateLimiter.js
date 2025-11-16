const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const SAFE_MARGIN = { perSecond: 1, perMinute: 5 };
const MIN_REMAINING_THRESHOLD = 3;
const COOLDOWN_PADDING_MS = 750;

const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

const PROFILES = {
    authenticated: { perSecond: 44, perMinute: 295 },
    anonymous: { perSecond: 14, perMinute: 58 }
};

const pickProfileForLimit = (limit = 0) => {
    if (limit >= 200) return PROFILES.authenticated;
    return PROFILES.anonymous;
};

const parseHeaderNumber = (headers, name) => {
    if (!headers) return NaN;
    const value = headers.get(name);
    if (!value) return NaN;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : NaN;
};

const parseResetDelayMs = (raw) => {
    if (!raw) return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
        if (numeric <= 120) {
            return Math.max(0, numeric * SECOND_MS);
        }
        if (numeric > 1_000_000_000_000) {
            return Math.max(0, numeric - Date.now());
        }
        if (numeric > 1_000_000_000) {
            return Math.max(0, (numeric * SECOND_MS) - Date.now());
        }
        return Math.max(0, numeric * SECOND_MS);
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
        return Math.max(0, parsed - Date.now());
    }
    return null;
};

class SlidingWindowRateLimiter {
    constructor({ perSecond, perMinute }) {
        this.perSecondLimit = perSecond || 1;
        this.perMinuteLimit = perMinute || 60;
        this.secondWindowMs = SECOND_MS;
        this.minuteWindowMs = MINUTE_MS;
        this.secondTimestamps = [];
        this.minuteTimestamps = [];
        this.queue = [];
        this.processing = false;
        this.suspendUntil = 0;
    }

    schedule(task) {
        if (typeof task !== 'function') {
            return Promise.reject(new Error('Rate limiter requires a function task.'));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;
        try {
            while (this.queue.length > 0) {
                await this.waitForSlot();
                const entry = this.queue.shift();
                if (!entry) continue;
                try {
                    const result = await entry.task();
                    entry.resolve(result);
                } catch (error) {
                    entry.reject(error);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    async waitForSlot() {
        while (true) {
            const now = Date.now();
            if (this.suspendUntil > now) {
                await sleep(this.suspendUntil - now);
                continue;
            }
            this.trim(now);
            const underSecondLimit = !this.perSecondLimit || this.secondTimestamps.length < this.perSecondLimit;
            const underMinuteLimit = !this.perMinuteLimit || this.minuteTimestamps.length < this.perMinuteLimit;
            if (underSecondLimit && underMinuteLimit) {
                this.secondTimestamps.push(now);
                this.minuteTimestamps.push(now);
                return;
            }
            const waitSecond = !underSecondLimit
                ? Math.max(10, this.secondWindowMs - (now - this.secondTimestamps[0]))
                : Infinity;
            const waitMinute = !underMinuteLimit
                ? Math.max(10, this.minuteWindowMs - (now - this.minuteTimestamps[0]))
                : Infinity;
            const waitTime = Math.min(waitSecond, waitMinute);
            await sleep(waitTime);
        }
    }

    trim(now) {
        const secondCutoff = now - this.secondWindowMs;
        while (this.secondTimestamps.length > 0 && this.secondTimestamps[0] <= secondCutoff) {
            this.secondTimestamps.shift();
        }
        const minuteCutoff = now - this.minuteWindowMs;
        while (this.minuteTimestamps.length > 0 && this.minuteTimestamps[0] <= minuteCutoff) {
            this.minuteTimestamps.shift();
        }
    }

    updateLimits({ perSecond, perMinute } = {}) {
        if (Number.isFinite(perSecond) && perSecond > 0) {
            this.perSecondLimit = perSecond;
        }
        if (Number.isFinite(perMinute) && perMinute > 0) {
            this.perMinuteLimit = perMinute;
        }
    }

    enforceCooldown(durationMs) {
        if (!Number.isFinite(durationMs) || durationMs <= 0) return;
        const until = Date.now() + durationMs;
        this.suspendUntil = Math.max(this.suspendUntil, until);
    }

    getSnapshot() {
        return {
            perSecondLimit: this.perSecondLimit,
            perMinuteLimit: this.perMinuteLimit,
            queuedTasks: this.queue.length,
            suspendUntil: this.suspendUntil
        };
    }
}

export const battleMetricsRateLimiter = new SlidingWindowRateLimiter(PROFILES.authenticated);

export const rateLimitedFetch = (url, options = {}) => {
    return battleMetricsRateLimiter.schedule(() => fetch(url, options));
};

export const withBattleMetricsRateLimit = (task) => battleMetricsRateLimiter.schedule(task);

export const recordRateLimitHeaders = (headers) => {
    if (!headers) return;
    const minuteLimitRaw = parseHeaderNumber(headers, 'x-ratelimit-limit');
    if (Number.isFinite(minuteLimitRaw) && minuteLimitRaw > 0) {
        const profile = pickProfileForLimit(minuteLimitRaw);
        const adjustedLimits = {
            perSecond: Math.max(1, profile.perSecond - SAFE_MARGIN.perSecond),
            perMinute: Math.max(1, Math.min(profile.perMinute, minuteLimitRaw - SAFE_MARGIN.perMinute))
        };
        battleMetricsRateLimiter.updateLimits(adjustedLimits);
    }

    const remaining = parseHeaderNumber(headers, 'x-ratelimit-remaining');
    if (Number.isFinite(remaining) && remaining <= MIN_REMAINING_THRESHOLD) {
        const resetDelay = parseResetDelayMs(headers.get('x-ratelimit-reset'));
        if (resetDelay) {
            battleMetricsRateLimiter.enforceCooldown(resetDelay + COOLDOWN_PADDING_MS);
        }
    }
};
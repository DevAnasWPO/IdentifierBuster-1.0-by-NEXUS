import { jobStore } from './storage.js';

const DEFAULT_DELAY = 200; // ms
const METRICS_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_FALLBACK_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60 * 1000;

export class JobQueue {
    constructor() {
        this.processors = new Map();
        this.listeners = new Set();
        this.processing = false;
        this.interJobDelay = DEFAULT_DELAY;
        this.telemetry = {
            recentResponses: [],
            maxSamples: 20
        };
        this.pending = [];
        this.initPromise = this.restorePendingJobs();
        this.activeJobs = 0;
        this.totalCompleted = 0;
        this.totalFailed = 0;
        this.completedTimestamps = [];
        this.lastErrorInfo = null;
        this.lastMetrics = null;
        this.cooldownUntil = 0;
        this.lastCooldownInfo = null;
    }

    async restorePendingJobs() {
        const jobs = await jobStore.getAll();
        const pending = jobs.filter(job => job.state === 'pending' || job.state === 'running');
        pending.sort((a, b) => (a.nextRunAt || a.createdAt) - (b.nextRunAt || b.createdAt));
        this.pending.push(...pending.map(job => ({ ...job, state: 'pending' })));
        if (this.pending.length > 0) {
            this.processNext();
        }
        this.emitMetrics('restore');
    }

    on(event, handler) {
        const listener = { event, handler };
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event, payload) {
        for (const listener of this.listeners) {
            if (listener.event === event) {
                try {
                    listener.handler(payload);
                } catch (error) {
                    console.error('JobQueue listener error', error);
                }
            }
        }
    }

    registerProcessor(type, handler) {
        this.processors.set(type, handler);
    }

    async enqueue(job) {
        await this.initPromise;
        const record = {
            id: job.id || crypto.randomUUID(),
            type: job.type,
            payload: job.payload || {},
            state: 'pending',
            createdAt: Date.now(),
            nextRunAt: Date.now(),
            attempt: 0,
            priority: job.priority || 0
        };
        await jobStore.put(record);
        this.pending.push(record);
        this.pending.sort((a, b) => (b.priority - a.priority) || (a.nextRunAt - b.nextRunAt));
        this.emit('jobQueued', record);
        this.emitMetrics('enqueue');
        this.processNext();
        return record;
    }

    updateAdaptiveDelay(sample) {
        this.telemetry.recentResponses.push(sample);
        if (this.telemetry.recentResponses.length > this.telemetry.maxSamples) {
            this.telemetry.recentResponses.shift();
        }
        const errors = this.telemetry.recentResponses.filter(r => r.status >= 500 || r.status === 429);
        if (errors.length >= 2) {
            this.interJobDelay = Math.min(this.interJobDelay * 2, 5000);
        } else if (this.interJobDelay > DEFAULT_DELAY && errors.length === 0) {
            this.interJobDelay = Math.max(DEFAULT_DELAY, this.interJobDelay * 0.8);
        }
    }

    recordCompletion(duration) {
        if (typeof duration === 'number' && duration >= 0) {
            this.completedTimestamps.push(Date.now());
        }
        const cutoff = Date.now() - METRICS_WINDOW_MS;
        this.completedTimestamps = this.completedTimestamps.filter(ts => ts >= cutoff);
    }

    applyGlobalCooldown(durationMs, source = 'rate-limit') {
        if (!durationMs || durationMs <= 0) return;
        const boundedDuration = Math.min(durationMs, MAX_RETRY_DELAY_MS);
        const until = Date.now() + boundedDuration;
        if (until > this.cooldownUntil) {
            this.cooldownUntil = until;
        }
        this.lastCooldownInfo = {
            source,
            durationMs: boundedDuration,
            timestamp: Date.now()
        };
        this.emitMetrics('cooldown');
    }

    buildMetricsSnapshot() {
        const now = Date.now();
        const recent = this.telemetry.recentResponses;
        const durationSamples = recent.filter(sample => typeof sample.duration === 'number');
        const avgDuration = durationSamples.length
            ? durationSamples.reduce((sum, sample) => sum + sample.duration, 0) / durationSamples.length
            : 0;
        const errorSamples = recent.filter(sample => sample.status >= 400);
        const cooldownRemainingMs = Math.max(0, this.cooldownUntil - now);
        const snapshot = {
            pending: this.pending.length,
            active: this.activeJobs,
            delayMs: this.interJobDelay,
            avgDurationMs: Math.round(avgDuration),
            throughputPerMin: this.completedTimestamps.length,
            totalCompleted: this.totalCompleted,
            totalFailed: this.totalFailed,
            errorSampleCount: errorSamples.length,
            lastError: this.lastErrorInfo,
            timestamp: now,
            cooldownRemainingMs,
            cooldownSource: cooldownRemainingMs > 0 ? this.lastCooldownInfo?.source || null : null
        };
        this.lastMetrics = snapshot;
        return snapshot;
    }

    emitMetrics(reason) {
        const snapshot = this.buildMetricsSnapshot();
        this.emit('queueMetrics', { reason, snapshot });
    }

    getMetricsSnapshot() {
        return this.lastMetrics || this.buildMetricsSnapshot();
    }

    async completeJob(job, state, metadata = {}) {
        const record = { ...job, state, metadata, completedAt: Date.now() };
        await jobStore.put(record);
        if (job._isActive) {
            this.activeJobs = Math.max(0, this.activeJobs - 1);
            job._isActive = false;
        }
        if (state === 'done') {
            this.totalCompleted += 1;
            const duration = metadata?.result?.durationMs ?? metadata?.durationMs;
            this.recordCompletion(duration);
        }
        this.emit('jobFinished', record);
        this.emitMetrics('jobFinished');
    }

    async failJob(job, error) {
        const baseDelay = Math.min(1000 * (job.attempt + 1), 5000);
        const retryHint = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : null;
        const status = typeof error?.status === 'number' ? error.status : null;
        let retryDelay = baseDelay;
        if (retryHint && retryHint > 0) {
            retryDelay = Math.max(retryDelay, Math.min(retryHint, MAX_RETRY_DELAY_MS));
        } else if (error?.isRateLimit || status === 429) {
            retryDelay = Math.max(retryDelay, RATE_LIMIT_FALLBACK_DELAY_MS);
        } else if (status && status >= 500 && status < 600) {
            retryDelay = Math.max(retryDelay, RATE_LIMIT_FALLBACK_DELAY_MS * 0.8);
        }
        retryDelay = Math.min(retryDelay, MAX_RETRY_DELAY_MS);
        job.attempt += 1;
        job.nextRunAt = Date.now() + retryDelay;
        job.state = 'pending';
        await jobStore.put(job);
        this.pending.push(job);
        if (job._isActive) {
            this.activeJobs = Math.max(0, this.activeJobs - 1);
            job._isActive = false;
        }
        this.totalFailed += 1;
        this.lastErrorInfo = {
            message: error?.message || String(error),
            jobId: job.id,
            attempt: job.attempt,
            timestamp: Date.now()
        };
        if ((retryHint && retryHint > 0) || error?.isRateLimit || status === 429 || (status && status >= 500 && status < 600)) {
            this.applyGlobalCooldown(retryDelay, 'rate-limit');
        }
        this.emit('jobFailed', { job, error });
        this.emitMetrics('jobFailed');
    }

    async processNext() {
        if (this.processing) return;
        this.processing = true;
        while (this.pending.length > 0) {
            const now = Date.now();
            if (this.cooldownUntil > now) {
                await new Promise(resolve => setTimeout(resolve, this.cooldownUntil - now));
                continue;
            }
            this.pending.sort((a, b) => (a.nextRunAt - b.nextRunAt));
            const job = this.pending.shift();
            if (job.nextRunAt > now) {
                this.pending.unshift(job);
                await new Promise(resolve => setTimeout(resolve, job.nextRunAt - now));
                continue;
            }
            this.emitMetrics('dequeue');
            const processor = this.processors.get(job.type);
            if (!processor) {
                console.warn('No processor registered for job type', job.type);
                await this.completeJob(job, 'skipped', { reason: 'no-processor' });
                continue;
            }
            job.state = 'running';
            job._isActive = true;
            await jobStore.put(job);
            this.emit('jobStarted', job);
            this.activeJobs += 1;
            this.emitMetrics('jobStarted');
            try {
                const start = performance.now();
                const result = await processor(job.payload, job);
                const duration = performance.now() - start;
                this.updateAdaptiveDelay({ status: result?.status || 200, duration });
                await this.completeJob(job, 'done', { result, durationMs: duration });
                if (this.interJobDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.interJobDelay));
                }
            } catch (error) {
                console.error('Job failed', job, error);
                await this.failJob(job, error);
            }
        }
        this.processing = false;
        this.emitMetrics('idle');
    }
}

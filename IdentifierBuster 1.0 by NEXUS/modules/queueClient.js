import { ensureBattleMetricsTokenReady } from './api.js';

class QueueClient {
    constructor() {
        this.port = null;
        this.ready = false;
        this.eventHandlers = new Map();
        this.pendingJobs = new Map();
        this.connectingPromise = null;
        this.orphanEvents = new Map();
        this.latestMetrics = null;
        this.tokenRecoveryPromise = null;

        chrome.runtime.onConnect.addListener((port) => {
            if (port.name !== 'queue-events') return;
            this.port = port;
            this.ready = true;
            port.onMessage.addListener((message) => this.handlePortMessage(message));
            port.onDisconnect.addListener(() => {
                this.port = null;
                this.ready = false;
                // attempt to resubscribe after a short delay
                setTimeout(() => this.ensurePort().catch(() => {}), 500);
            });
        });

        this.on('jobFailed', (message) => this.handleJobFailure(message));
    }

    async ensurePort() {
        if (this.ready) return;
        if (this.connectingPromise) return this.connectingPromise;

        this.connectingPromise = new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'queue:subscribe' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('Queue subscription failed', chrome.runtime.lastError.message);
                    resolve();
                    return;
                }
                if (!response?.success) {
                    console.warn('Queue subscription rejected', response?.error);
                }
                resolve();
            });
        }).finally(() => {
            this.connectingPromise = null;
        });

        return this.connectingPromise;
    }

    handlePortMessage(message) {
        if (message?.event === 'queueMetrics' && message.snapshot) {
            this.latestMetrics = message.snapshot;
        } else if (message?.event === 'jobFinished' && message.job?.id) {
            if (!this.resolvePendingFromMessage(message)) {
                this.orphanEvents.set(message.job.id, message);
            }
        } else if (message?.event === 'jobFailed' && message.job?.id) {
            if (!this.resolvePendingFromMessage(message)) {
                this.orphanEvents.set(message.job.id, message);
            }
        }

        const handlers = this.eventHandlers.get(message?.event);
        if (!handlers) return;
        handlers.forEach(handler => {
            try {
                handler(message);
            } catch (error) {
                console.error('Queue event handler error', error);
            }
        });
    }

    resolvePendingFromMessage(message) {
        const jobId = message?.job?.id;
        if (!jobId) return false;
        const pending = this.pendingJobs.get(jobId);
        if (!pending) return false;
        this.pendingJobs.delete(jobId);
        if (message.event === 'jobFinished') {
            pending.resolve(message.job.metadata?.result ?? message.job.metadata ?? message.job);
        } else if (message.event === 'jobFailed') {
            const errorMessage = message.error?.message || message.error || 'Job failed';
            const error = new Error(errorMessage);
            pending.reject(error);
        }
        return true;
    }

    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event).add(handler);
        this.ensurePort();
        return () => this.eventHandlers.get(event)?.delete(handler);
    }

    async enqueue(jobType, payload = {}, priority = 0) {
        await this.ensurePort();
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'queue:enqueue', jobType, payload, priority }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response?.success && response.job?.id) {
                    const jobId = response.job.id;
                    this.pendingJobs.set(jobId, { resolve, reject });
                    const orphan = this.orphanEvents.get(jobId);
                    if (orphan) {
                        this.orphanEvents.delete(jobId);
                        this.resolvePendingFromMessage(orphan);
                    }
                } else {
                    reject(new Error(response?.error || 'Failed to enqueue job'));
                }
            });
        });
    }

    async getMetrics(forceRefresh = false) {
        if (!forceRefresh && this.latestMetrics) {
            return this.latestMetrics;
        }
        await this.ensurePort();
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'queue:getStats' }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response?.success) {
                    this.latestMetrics = response.snapshot;
                    resolve(response.snapshot);
                } else {
                    reject(new Error(response?.error || 'Failed to fetch queue metrics'));
                }
            });
        });
    }

    async handleJobFailure(message) {
        const reason = message?.error?.message || message?.error;
        if (!reason) return;
        const needsToken = /battlemetrics token not available/i.test(reason) || /status:\s*401/i.test(reason);
        if (!needsToken) return;
        if (this.tokenRecoveryPromise) {
            return this.tokenRecoveryPromise;
        }
        this.tokenRecoveryPromise = ensureBattleMetricsTokenReady({ forceResync: true })
            .catch((error) => {
                console.warn('Failed to resync BattleMetrics token after queue error', error);
            })
            .finally(() => {
                this.tokenRecoveryPromise = null;
            });
        return this.tokenRecoveryPromise;
    }
}

export const queueClient = new QueueClient();

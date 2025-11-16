import { queueClient } from './queueClient.js';
import { bundleCache } from './bundleCache.js';
import { ensureBattleMetricsTokenReady } from './api.js';

const PREFETCH_BATCH_SIZE = 5;
const PREFETCH_PRIORITY = -1;
const PREFETCH_QUEUE_THRESHOLD = 8; // stop prefetching if queue is already busy

let latestMetrics = null;
const candidateQueue = new Map(); // playerId -> { basePriority, addedAt }
const riskHints = new Map();
let sequenceCounter = 0;

const ensureTokenAvailable = async () => {
    try {
        await ensureBattleMetricsTokenReady();
        return true;
    } catch (error) {
        console.debug('BattleMetrics token unavailable, delaying prefetch', error.message || error);
        return false;
    }
};

const getQueueLoad = () => {
    if (!latestMetrics) return 0;
    return (latestMetrics.pending || 0) + (latestMetrics.active || 0);
};

const canPrefetchMore = () => getQueueLoad() < PREFETCH_QUEUE_THRESHOLD;

const computeEffectivePriority = (playerId, entry) => {
    const riskBoost = riskHints.get(playerId) ?? 0;
    return (entry?.basePriority || 0) + riskBoost;
};

const enqueueCandidate = (playerId, basePriority = 0) => {
    const entry = candidateQueue.get(playerId);
    if (entry) {
        entry.basePriority = Math.max(entry.basePriority, basePriority);
        entry.addedAt = Math.min(entry.addedAt, sequenceCounter++);
    } else {
        candidateQueue.set(playerId, {
            basePriority,
            addedAt: sequenceCounter++
        });
    }
};

const drainPrefetchQueue = async () => {
    if (!canPrefetchMore() || candidateQueue.size === 0) return;
    if (!(await ensureTokenAvailable())) return;
    let budget = Math.min(PREFETCH_BATCH_SIZE, Math.max(1, PREFETCH_QUEUE_THRESHOLD - getQueueLoad()));
    const sortedCandidates = Array.from(candidateQueue.entries()).sort((a, b) => {
        const priorityDiff = computeEffectivePriority(b[0], b[1]) - computeEffectivePriority(a[0], a[1]);
        if (priorityDiff !== 0) return priorityDiff;
        return a[1].addedAt - b[1].addedAt;
    });

    for (const [playerId] of sortedCandidates) {
        if (budget <= 0) break;
        if (!playerId) {
            candidateQueue.delete(playerId);
            continue;
        }
        if (bundleCache.has(playerId)) {
            candidateQueue.delete(playerId);
            continue;
        }
        if (getQueueLoad() >= PREFETCH_QUEUE_THRESHOLD) break;

        budget -= 1;
        candidateQueue.delete(playerId);
        bundleCache.getOrCreate(playerId, () =>
            queueClient.enqueue('fetchPlayerBundle', { playerId }, PREFETCH_PRIORITY)
                .catch(error => {
                    console.debug('Prefetch failed', playerId, error);
                    throw error;
                })
        ).catch(() => {
            // Ensure failed fetches can be retried later if needed
            enqueueCandidate(playerId, 0);
        });
    }
};

const safeDrain = () => {
    drainPrefetchQueue().catch(error => console.debug('Prefetch drain failed', error));
};

queueClient.on('queueMetrics', ({ snapshot }) => {
    latestMetrics = snapshot;
    safeDrain();
});

export function prefetchPlayers(playerIds = [], options = {}) {
    if (!Array.isArray(playerIds) || playerIds.length === 0) return;
    const priorityHint = typeof options.priorityHint === 'number' ? options.priorityHint : playerIds.length;
    playerIds.forEach((playerId, index) => {
        if (!playerId) return;
        if (bundleCache.has(playerId)) return;
        enqueueCandidate(playerId, priorityHint - index);
    });
    safeDrain();
}

export function registerRiskHints(players = []) {
    let updated = false;
    players.forEach(player => {
        if (!player?.id) return;
        const score = player?.risk?.score;
        if (typeof score === 'number') {
            riskHints.set(player.id, score);
            updated = true;
        }
    });
    if (updated) {
        safeDrain();
    }
}

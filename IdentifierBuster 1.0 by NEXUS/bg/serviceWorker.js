// bg/serviceWorker.js

import { JobQueue } from './jobQueue.js';
import { rateLimitedFetch, recordRateLimitHeaders } from './rateLimiter.js';

const jobQueue = new JobQueue();
const BM_TOKEN_KEY = 'ibBattleMetricsToken';
const RATE_LIMIT_FALLBACK_DELAY_MS = 5000;
const MAX_RATE_LIMIT_DELAY_MS = 60000;
const MAX_FETCH_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const NETWORK_ERROR_NAMES = new Set(['TypeError']);
const BATTLEMETRICS_API_PREFIX = 'https://api.battlemetrics.com/';
let cachedBmToken = null;
let bmTokenReadyPromise = Promise.resolve();

const isBattleMetricsApiUrl = (url) => typeof url === 'string' && url.startsWith(BATTLEMETRICS_API_PREFIX);

const clampDelay = (value) => {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(value, MAX_RATE_LIMIT_DELAY_MS));
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

const parseRetryAfterValue = (rawValue) => {
    if (!rawValue) return null;
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) {
        if (numeric < 1000) {
            return clampDelay(numeric * 1000);
        }
        if (numeric < 10_000_000_000) {
            return clampDelay((numeric * 1000) - Date.now());
        }
        return clampDelay(numeric - Date.now());
    }
    const parsedDate = Date.parse(rawValue);
    if (!Number.isNaN(parsedDate)) {
        return clampDelay(parsedDate - Date.now());
    }
    return null;
};

const extractRateLimitDelay = (response) => {
    if (!response?.headers) return null;
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = parseRetryAfterValue(retryAfterHeader);
    if (retryAfter) return retryAfter;

    const resetHeader = response.headers.get('x-ratelimit-reset');
    const resetDelay = parseRetryAfterValue(resetHeader);
    if (resetDelay) return resetDelay;

    return null;
};

const persistBattleMetricsToken = (token) => {
    if (!token) {
        chrome.storage?.local?.remove?.(BM_TOKEN_KEY);
        return;
    }
    chrome.storage?.local?.set?.({ [BM_TOKEN_KEY]: token });
};

const loadCachedBattleMetricsToken = () => {
    if (!chrome.storage?.local?.get) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        chrome.storage.local.get(BM_TOKEN_KEY, (result) => {
            const storedToken = result?.[BM_TOKEN_KEY];
            if (storedToken) {
                cachedBmToken = storedToken;
            }
            resolve();
        });
    });
};

bmTokenReadyPromise = loadCachedBattleMetricsToken();

const serializeError = (error) => {
    if (!error) return null;
    if (typeof error === 'string') return { message: error };
    return {
        message: error.message || 'Unknown queue error',
        stack: error.stack,
        name: error.name || 'Error'
    };
};

const fetchThroughProxy = (url, options = {}) => {
    const fetchFn = isBattleMetricsApiUrl(url) ? rateLimitedFetch : fetch;
    return fetchFn(url, options).then(async (response) => {
        if (isBattleMetricsApiUrl(url)) {
            recordRateLimitHeaders(response.headers);
        }
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error! status: ${response.status}, message: ${errorText || response.statusText}`);
        }
        if (response.status === 204) {
            return null;
        }
        return response.json();
    });
};

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get('steamApiKey', (data) => {
        if (typeof data.steamApiKey === 'undefined') {
            chrome.storage.local.set({ steamApiKey: '' });
            console.log('Initialized empty steamApiKey in storage.');
        }
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
        case 'fetchApi': {
            fetchThroughProxy(request.url, request.options)
                .then(data => sendResponse({ success: true, data }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }
        case 'queue:enqueue': {
            jobQueue.enqueue({ type: request.jobType, payload: request.payload || {}, priority: request.priority || 0 })
                .then(job => sendResponse({ success: true, job }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }
        case 'queue:subscribe': {
            if (!sender.tab?.id) {
                sendResponse({ success: false, error: 'Subscription requires a tab context' });
                return false;
            }
            try {
                const port = chrome.tabs.connect(sender.tab.id, { name: 'queue-events' });
                const stopJobQueued = jobQueue.on('jobQueued', (job) => port.postMessage({ event: 'jobQueued', job }));
                const stopJobStarted = jobQueue.on('jobStarted', (job) => port.postMessage({ event: 'jobStarted', job }));
                const stopJobFinished = jobQueue.on('jobFinished', (job) => port.postMessage({ event: 'jobFinished', job }));
                const stopJobFailed = jobQueue.on('jobFailed', ({ job, error }) => port.postMessage({ event: 'jobFailed', job, error: serializeError(error) }));
                const stopMetrics = jobQueue.on('queueMetrics', (payload) => port.postMessage({ event: 'queueMetrics', ...payload }));
                port.onDisconnect.addListener(() => {
                    stopJobQueued();
                    stopJobStarted();
                    stopJobFinished();
                    stopJobFailed();
                    stopMetrics();
                });
                sendResponse({ success: true });
            } catch (error) {
                console.error('Failed to connect queue port', error);
                sendResponse({ success: false, error: error.message || 'Failed to connect queue port' });
            }
            return true;
        }
        case 'queue:getStats': {
            sendResponse({ success: true, snapshot: jobQueue.getMetricsSnapshot() });
            return false;
        }
        case 'bm:token': {
            cachedBmToken = request.token;
            persistBattleMetricsToken(cachedBmToken);
            sendResponse({ success: true });
            return false;
        }
        default:
            break;
    }
});

const buildPlayerInfoUrl = (playerId) => {
    const params = new URLSearchParams();
    params.set('include', 'identifier,server');
    params.set('fields[player]', 'name,createdAt,updatedAt');
    params.set('fields[server]', 'name');
    return `https://api.battlemetrics.com/players/${playerId}?${params.toString()}`;
};

const buildSessionsUrl = (playerId) => {
    const params = new URLSearchParams({
        'filter[players]': playerId,
        'page[size]': '100',
        'fields[session]': 'start,stop'
    });
    return `https://api.battlemetrics.com/sessions?${params.toString()}`;
};

jobQueue.registerProcessor('fetchPlayerBundle', async (payload) => {
    await bmTokenReadyPromise;
    if (!cachedBmToken) {
        throw new Error('BattleMetrics token not available');
    }

    if (!payload?.playerId) {
        throw new Error('playerId is required for fetchPlayerBundle jobs');
    }

    const headers = { 'Authorization': `Bearer ${cachedBmToken}` };
    const fetchJson = async (url) => {
        let attempt = 0;
        let lastError;
        while (attempt <= MAX_FETCH_RETRIES) {
            try {
                const fetchFn = isBattleMetricsApiUrl(url) ? rateLimitedFetch : fetch;
                const response = await fetchFn(url, { headers });
                if (isBattleMetricsApiUrl(url)) {
                    recordRateLimitHeaders(response.headers);
                }
                const status = response.status;
                const text = await response.text();
                let data = null;
                if (text && text.length > 0) {
                    try {
                        data = JSON.parse(text);
                    } catch (error) {
                        data = text;
                    }
                }
                if (!response.ok) {
                    const message = typeof data === 'string' ? data : response.statusText;
                    if (status === 401 || status === 403) {
                        cachedBmToken = null;
                        persistBattleMetricsToken(null);
                    }
                    const err = new Error(`HTTP error! status: ${status}, message: ${message}`);
                    const retryAfter = extractRateLimitDelay(response);
                    err.status = status;
                    err.body = data;
                    if (status === 429) {
                        err.isRateLimit = true;
                        err.retryAfterMs = retryAfter ?? RATE_LIMIT_FALLBACK_DELAY_MS;
                    } else if ((status === 503 || status === 504) && retryAfter) {
                        err.retryAfterMs = retryAfter;
                    } else if (retryAfter) {
                        err.retryAfterMs = retryAfter;
                    }
                    throw err;
                }
                return { status, data };
            } catch (error) {
                lastError = error;
                const status = error?.status;
                const shouldRetry = error?.isRateLimit || RETRYABLE_STATUS.has(status) || NETWORK_ERROR_NAMES.has(error?.name);
                const isLastAttempt = attempt >= MAX_FETCH_RETRIES;
                if (!shouldRetry || isLastAttempt) {
                    throw error;
                }
                const exponentialDelay = RATE_LIMIT_FALLBACK_DELAY_MS * Math.pow(2, attempt);
                const delay = Math.min(error?.retryAfterMs ?? exponentialDelay, MAX_RATE_LIMIT_DELAY_MS);
                const jitter = Math.floor(Math.random() * 500);
                await sleep(delay + jitter);
                attempt += 1;
            }
        }
        throw lastError;
    };

    const playerId = payload.playerId;
    const requests = [
        fetchJson(buildPlayerInfoUrl(playerId)),
        fetchJson(`https://api.battlemetrics.com/bans?filter[player]=${playerId}&filter[expired]=false`),
        fetchJson(`https://api.battlemetrics.com/players/${playerId}/relationships/related-identifiers`),
        fetchJson(buildSessionsUrl(playerId))
    ];

    const [playerInfo, banData, relatedData, sessionData] = await Promise.all(requests);

    const statuses = [playerInfo.status, banData.status, relatedData.status, sessionData.status].filter(Boolean);
    const maxStatus = statuses.length ? Math.max(...statuses) : 200;

    return {
        status: maxStatus,
        bundle: {
            playerId,
            playerData: playerInfo.data,
            banData: banData.data,
            relatedData: relatedData.data,
            sessionData: sessionData.data
        }
    };
});
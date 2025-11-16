// modules/api.js

/**
 * A helper function to securely make API requests via the background service worker.
 * @param {string} url The URL to fetch.
 * @param {object} options The options for the fetch request (e.g., headers).
 * @param {number} retries Number of retry attempts for transient errors (default: 2).
 * @param {number} retryDelay Delay between retries in milliseconds (default: 1000).
 * @returns {Promise<any>} A promise that resolves with the JSON data from the API.
 */
async function fetchApi(url, options = {}, retries = 2, retryDelay = 1000) {
    return new Promise((resolve, reject) => {
        const attemptFetch = (attemptsLeft) => {
            chrome.runtime.sendMessage({ type: 'fetchApi', url, options }, (response) => {
                if (chrome.runtime.lastError) {
                    // This catches errors in the communication with the background script itself
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (response.success) {
                    resolve(response.data);
                } else {
                    // This catches errors from the fetch request (e.g., network errors, 4xx/5xx responses)
                    const errorMsg = response.error || 'Unknown API error';
                    
                    // Check if this is a network error
                    const isNetworkError = errorMsg.includes('Failed to fetch') ||
                                          errorMsg.includes('NetworkError') ||
                                          errorMsg.includes('net::ERR_');
                    
                    // Check if this is a transient error that should be retried
                    const isTransientError = errorMsg.includes('500') ||
                                            errorMsg.includes('502') ||
                                            errorMsg.includes('503') ||
                                            errorMsg.includes('504') || 
                                            errorMsg.includes('Gateway time-out') ||
                                            isNetworkError;
                    
                    // Check for rate limiting
                    const isRateLimited = errorMsg.includes('429') || 
                                         errorMsg.includes('Too Many Requests') ||
                                         errorMsg.includes('rate limit');
                    
                    if (isRateLimited && attemptsLeft > 0) {
                        // For rate limits, wait longer before retrying
                        const rateLimitDelay = retryDelay * 3; // 3 seconds for rate limits
                        console.warn(`Rate limited by API. Retrying in ${rateLimitDelay}ms... (${attemptsLeft} attempts left)`);
                        setTimeout(() => attemptFetch(attemptsLeft - 1), rateLimitDelay);
                    } else if (isTransientError && attemptsLeft > 0) {
                        console.warn(`API request failed with transient error. Retrying... (${attemptsLeft} attempts left)`);
                        setTimeout(() => attemptFetch(attemptsLeft - 1), retryDelay);
                    } else {
                        // Provide better error messages
                        if (isRateLimited) {
                            reject(new Error('BattleMetrics API rate limit exceeded. Please wait a moment and try again.'));
                        } else if (isNetworkError) {
                            reject(new Error('Network error occurred. Please check your connection and try again.'));
                        } else if (errorMsg.includes('500')) {
                            reject(new Error('BattleMetrics API is experiencing server errors (500). The service may be temporarily down. Please try again later.'));
                        } else if (errorMsg.includes('502') || errorMsg.includes('503')) {
                            reject(new Error('BattleMetrics API is temporarily unavailable (502/503). Please try again in a few moments.'));
                        } else if (errorMsg.includes('504') || errorMsg.includes('Gateway time-out')) {
                            reject(new Error('BattleMetrics API timed out (504). Please try again in a few moments.'));
                        } else if (errorMsg.includes('404')) {
                            reject(new Error('Resource not found (404). The requested data may not exist.'));
                        } else {
                            reject(new Error(errorMsg));
                        }
                    }
                }
            });
        };
        
        attemptFetch(retries);
    });
}

/**
 * Retrieves the BattleMetrics OAuth token from the page's HTML.
 * @returns {object} The headers object with the Authorization token.
 * @throws {Error} If the token cannot be found.
 */
let lastSentBmToken = null;
let pendingTokenSync = Promise.resolve();

const readBattleMetricsToken = () => {
    const tokenElement = document.getElementById('oauthToken');
    if (!tokenElement || !tokenElement.textContent) {
        throw new Error('BattleMetrics authentication token not found on the page.');
    }
    return tokenElement.textContent.trim();
};

export function ensureBattleMetricsTokenSync({ forceResync = false } = {}) {
    const token = readBattleMetricsToken();
    if (token && (forceResync || token !== lastSentBmToken)) {
        lastSentBmToken = token;
        pendingTokenSync = new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'bm:token', token }, () => {
                if (chrome.runtime.lastError) {
                    console.debug('bm:token sync error', chrome.runtime.lastError.message);
                    lastSentBmToken = null;
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve();
                }
            });
        });
    }
    return token;
}

export async function ensureBattleMetricsTokenReady(options = {}) {
    const token = ensureBattleMetricsTokenSync(options);
    if (!token) {
        throw new Error('BattleMetrics authentication token not found on the page.');
    }
    await pendingTokenSync;
    return token;
}

export const getBmHeaders = () => {
    const token = ensureBattleMetricsTokenSync();
    return {
        'Authorization': `Bearer ${token}`
    };
};

// --- BattleMetrics API Functions ---

/**
 * Fetches detailed information for a specific player.
 * @param {string} playerId The BattleMetrics ID of the player.
 * @param {boolean} includeIdentifiers Whether to include associated identifiers in the response.
 * @returns {Promise<object>} The player data object from the API.
 */
export async function getPlayerInfo(playerId, includeIdentifiers = true) {
    const searchParams = new URLSearchParams();
    const includeResources = ['server'];
    if (includeIdentifiers) includeResources.unshift('identifier');
    searchParams.set('include', includeResources.join(','));
    searchParams.set('fields[player]', 'name,createdAt,updatedAt');
    searchParams.set('fields[server]', 'name');
    const query = searchParams.toString();
    const url = `https://api.battlemetrics.com/players/${playerId}?${query}`;
    return fetchApi(url, { headers: getBmHeaders() });
}

/**
 * Fetches active (non-expired) bans for a specific player.
 * @param {string} playerId The BattleMetrics ID of the player.
 * @returns {Promise<object>} The ban data object from the API.
 */
export async function getPlayerBans(playerId) {
    const url = `https://api.battlemetrics.com/bans?filter[player]=${playerId}&filter[expired]=false`;
    return fetchApi(url, { headers: getBmHeaders() });
}

/**
 * Fetches related identifiers for a player to find associations.
 * @param {string} playerId The BattleMetrics ID of the player.
 * @returns {Promise<object>} The related identifiers data from the API.
 */
export async function getPlayerRelatedIdentifiers(playerId) {
    const url = `https://api.battlemetrics.com/players/${playerId}/relationships/related-identifiers`;
    return fetchApi(url, { headers: getBmHeaders() });
}

/**
 * Fetches play session history for a player to determine accurate first/last seen dates.
 * @param {string} playerId The BattleMetrics ID of the player.
 * @returns {Promise<object>} The session data from the API.
 */
export async function getPlayerSessions(playerId) {
    const searchParams = new URLSearchParams({
        'filter[players]': playerId,
        'page[size]': '100',
        'fields[session]': 'start,stop'
    });
    const url = `https://api.battlemetrics.com/sessions?${searchParams.toString()}`;
    return fetchApi(url, { headers: getBmHeaders() });
}


// --- Steam API Functions ---

/**
 * Retrieves the Steam API key from localStorage, or prompts the user if not set.
 * @returns {Promise<string>} The Steam API key.
 */
async function getSteamApiKey() {
    return new Promise((resolve, reject) => {
        // Check localStorage first (matches settings.js implementation)
        let key = localStorage.getItem('BMF_STEAM_API_KEY');
        
        if (!key || !key.trim()) {
            // Show prompt to get API key
            key = prompt(
                'Steam API Key Required\n\n' +
                'Please enter your Steam Web API key to view Steam ban data.\n\n' +
                'Get your key from:\nhttps://steamcommunity.com/dev/apikey\n\n' +
                'Note: This will be saved for future use.'
            );
            
            if (key && key.trim()) {
                // Save to localStorage for future use
                localStorage.setItem('BMF_STEAM_API_KEY', key.trim());
                console.log('Steam API key saved successfully');
                resolve(key.trim());
            } else {
                // User cancelled or entered empty key
                console.warn('Steam API key not provided - Steam data will not be available');
                reject(new Error('Steam API key not provided'));
            }
        } else {
            resolve(key.trim());
        }
    });
}

/**
 * Fetches player summaries and ban data from the Steam API for a batch of SteamIDs.
 * @param {string[]} steamIds An array of 64-bit SteamIDs.
 * @returns {Promise<object[]>} An array of combined player summary and ban objects.
 */
export async function getSteamPlayerSummariesAndBans(steamIds) {
    if (steamIds.length === 0) return [];

    try {
        const apiKey = await getSteamApiKey();
        const idsString = steamIds.join(',');

        // Fetch summaries and bans in parallel
        const [summariesRes, bansRes] = await Promise.all([
            fetchApi(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${idsString}`),
            fetchApi(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${apiKey}&steamids=${idsString}`)
        ]);

        const summaries = summariesRes?.response?.players || [];
        const bans = bansRes?.players || [];

        // Create a map for quick lookup of ban data by SteamID
        const bansMap = new Map(bans.map(p => [p.SteamId, p]));

        // Combine summary and ban data into a single object for each player
        return summaries.map(summary => {
            const banInfo = bansMap.get(summary.steamid) || {};
            return {
                SteamId: summary.steamid,
                personaName: summary.personaname,
                avatar: summary.avatar,
                avatarhash: summary.avatarhash,
                ...banInfo
            };
        });
    } catch (error) {
        console.warn('Steam API key not provided or Steam API failed. Continuing without Steam data.');
        // Return empty array if Steam API key is not provided or Steam API fails
        // This allows the extension to continue working without Steam data
        return [];
    }
}
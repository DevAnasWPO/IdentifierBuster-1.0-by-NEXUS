// modules/setup.js

import { getSteamPlayerSummariesAndBans, ensureBattleMetricsTokenReady } from './api.js';
import { displayData } from './display.js';
import { queueClient } from './queueClient.js';
import { toast } from './toast.js';
import { bundleCache } from './bundleCache.js';
import { prefetchPlayers, registerRiskHints } from './prefetch.js';
import { scorePlayer } from './scoring.js';

// Short stagger keeps queue responsive without creating large bursts.
const ENQUEUE_DELAY_STEP_MS = 60;
const ENQUEUE_DELAY_CAP_MS = 600;

const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, ENQUEUE_DELAY_CAP_MS))));

/**
 * Main setup function triggered for each "shared identifier" element.
 * It injects the "Show Details" button and sets up its click event listener.
 * @param {HTMLElement} element The container element for the shared identifier list.
 */
export async function setup(element) {
    // Prefer the ID detected by the content script; fall back to parsing the URL.
    let mainPlayerId = document.body?.dataset?.ibPlayerId;
    if (!mainPlayerId) {
        const urlParts = window.location.pathname.split('/');
        const playersIndex = urlParts.indexOf('players');
        if (playersIndex === -1 || !urlParts[playersIndex + 1]) {
            console.error("Could not determine main player ID from URL.");
            return;
        }
        mainPlayerId = urlParts[playersIndex + 1];
    }

    const playerLinks = element.parentElement.querySelectorAll('ol > li > a');
    if (playerLinks.length === 0) return;

    const sharedPlayerIds = Array.from(playerLinks).map(a => a.href.split('/').pop());
    prefetchPlayers([mainPlayerId, ...sharedPlayerIds]);

    const detailsButton = document.createElement('button');
    detailsButton.textContent = 'Show Details';
    detailsButton.className = 'details-button';
    element.appendChild(detailsButton);

    detailsButton.addEventListener('click', async (event) => {
        event.stopPropagation(); // Prevent dropdown from closing
        detailsButton.textContent = 'Loading...';
        detailsButton.disabled = true;

        try {
            const allPlayerIds = Array.from(new Set([mainPlayerId, ...sharedPlayerIds]));

            const { players: processedData, failures, total } = await processPlayers(allPlayerIds, mainPlayerId);
            registerRiskHints(processedData);

            if (failures.length > 0) {
                console.warn(`Loaded ${total - failures.length} of ${total} players; ${failures.length} failed.`, failures);
            }

            if (processedData.length === 0) {
                throw new Error('No player data could be loaded.');
            }

            displayData(element, processedData, mainPlayerId);
            detailsButton.remove();
        } catch (error) {
            console.error("Failed to process and display shared player data:", error);
            
            // Show a more helpful error message
            if (error.message.includes('Network error') || error.message.includes('Failed to fetch')) {
                detailsButton.textContent = 'Network Error - Check Connection';
                detailsButton.title = 'Network connection issue. Please check your internet and try again.';
            } else if (error.message.includes('rate limit') || error.message.includes('429')) {
                detailsButton.textContent = 'Rate Limited - Wait & Retry';
                detailsButton.title = 'You are being rate limited by BattleMetrics. Please wait 30 seconds before trying again.';
            } else if (error.message.includes('500')) {
                detailsButton.textContent = 'Server Error - Try Again Later';
                detailsButton.title = 'BattleMetrics API is experiencing issues. Please try again in a few minutes.';
            } else if (error.message.includes('502') || error.message.includes('503')) {
                detailsButton.textContent = 'API Unavailable - Try Again';
                detailsButton.title = 'BattleMetrics API is temporarily unavailable.';
            } else if (error.message.includes('504') || error.message.includes('Gateway Timeout')) {
                detailsButton.textContent = 'API Timeout - Try Again';
                detailsButton.title = 'BattleMetrics API timed out.';
            } else if (error.message.includes('404')) {
                detailsButton.textContent = 'Not Found - Try Again';
                detailsButton.title = 'The requested data could not be found.';
            } else if (error.message.includes('token not found')) {
                detailsButton.textContent = 'Auth Error - Refresh Page';
                detailsButton.title = 'Authentication token not found. Please refresh the page.';
            } else {
                detailsButton.textContent = 'Error - Try Again';
                detailsButton.title = error.message;
            }
            
            // Reset the button after a delay so the user can try again
            setTimeout(() => {
                detailsButton.textContent = 'Show Details';
                detailsButton.title = '';
                detailsButton.disabled = false;
            }, 5000);
        }
    }, { once: true }); // The listener will only fire once
}

/**
 * Orchestrates fetching, processing, and combining data for a list of player IDs.
 * @param {string[]} playerIds An array of BattleMetrics player IDs.
 * @param {object} mainPlayerData The fully loaded data object for the main player on the page.
 * @returns {Promise<object[]>} A promise that resolves to an array of processed player data objects.
 */
async function processPlayers(playerIds, mainPlayerId) {
    const uniqueIds = Array.from(new Set(playerIds));
    const { bundles, failures } = await fetchPlayerBundlesViaQueue(uniqueIds);

    const validBundles = uniqueIds
        .map(id => bundles.get(id))
        .filter(Boolean);

    console.log(`Successfully fetched data for ${validBundles.length} of ${uniqueIds.length} players via background queue.`);

    const mainBundle = bundles.get(mainPlayerId);
    if (!mainBundle) {
        throw new Error('Main player data unavailable after queue processing.');
    }
    const mainPlayerData = mainBundle.playerData;
    const primaryName = mainPlayerData?.data?.attributes?.name || '';

    const steamIds = validBundles.map(bundle =>
        bundle.playerData?.included?.find(inc => inc.type === 'identifier' && inc.attributes.type === 'steamID')?.attributes.identifier
    ).filter(Boolean);

    const steamDataMap = new Map();
    if (steamIds.length > 0) {
        try {
            const steamResults = await getSteamPlayerSummariesAndBans(steamIds);
            steamResults.forEach(p => steamDataMap.set(p.SteamId, p));
        } catch (error) {
            console.warn('Failed to fetch Steam data, continuing without it:', error);
        }
    }

    const mainPlayerSteamId = mainPlayerData?.included?.find(inc => inc.type === 'identifier' && inc.attributes.type === 'steamID')?.attributes.identifier;
    const mainPlayerSteamInfo = mainPlayerSteamId ? steamDataMap.get(mainPlayerSteamId) : null;

    const players = validBundles.map(bundle => {
        const playerData = bundle.playerData;
        const banData = bundle.banData;
        const relatedData = bundle.relatedData;
        const sessionData = bundle.sessionData;
        const player = playerData?.data;
        const steamId = playerData?.included?.find(inc => inc.type === 'identifier' && inc.attributes.type === 'steamID')?.attributes.identifier;
        const steamInfo = steamId ? steamDataMap.get(steamId) : null;
        const bmBans = Array.isArray(banData?.data) ? banData.data : [];
        const sbDaysAgo = calculateDaysSinceMostRecentBan(bmBans);
        const rgbDaysAgo = typeof steamInfo?.DaysSinceLastBan === 'number' ? steamInfo.DaysSinceLastBan : null;
        const bmBanSummary = summarizeBattleMetricsBans(bmBans);

        const firstSeenDate = resolveFirstSeenDate(playerData, sessionData);
        const lastSeenDate = resolveLastSeenDate(playerData, sessionData);
        const firstSeenDisplay = formatDateLabel(firstSeenDate);
        const lastSeenDisplay = formatDateLabel(lastSeenDate);
        const firstSeenDaysAgo = calculateDaysSinceDate(firstSeenDate);
        const lastSeenDaysAgo = calculateDaysSinceDate(lastSeenDate);

        const nameMatchScore = primaryName && player?.attributes?.name
            ? calculateNameMatch(primaryName, player.attributes.name)
            : 0;

        const summary = {
            id: player?.id,
            steamId: steamId || null,
            name: player?.attributes?.name || 'Unknown',
            firstSeen: firstSeenDisplay,
            firstSeenDaysAgo,
            lastSeen: lastSeenDisplay,
            lastSeenDaysAgo,
            daysSinceLastSeen: lastSeenDaysAgo,
            nameMatch: nameMatchScore,
            associates: calculateAssociates(mainPlayerData.included, relatedData?.data),
            profilePicMatch: !!(mainPlayerSteamInfo && steamInfo && mainPlayerSteamInfo.avatarhash === steamInfo.avatarhash),
            banStatus: {
                sb: bmBans.length,
                sbDaysAgo,
                sbReason: bmBanSummary.reasonLabel,
                sbReasonDetail: bmBanSummary.reasonDetail,
                rgb: steamInfo?.NumberOfGameBans || 0,
                rgbDaysAgo,
                vac: steamInfo?.VACBanned || false,
            },
            timeline: buildTimelineMeta(firstSeenDate, lastSeenDate, bmBans)
        };

        summary.risk = scorePlayer(summary);
        return summary;
    });

    const sanitizedPlayers = players.filter(player => Boolean(player.id));

    return { players: sanitizedPlayers, failures, total: uniqueIds.length };
}

async function fetchPlayerBundlesViaQueue(playerIds) {
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
        return { bundles: new Map(), failures: [], total: 0 };
    }

    try {
        await ensureBattleMetricsTokenReady();
    } catch (error) {
        throw new Error(`${error.message || 'BattleMetrics authentication token missing.'} Please refresh the page and try again.`);
    }

    const uniqueIds = Array.from(new Set(playerIds));
    const total = uniqueIds.length;
    const bundles = new Map();
    const failures = [];
    let completed = 0;

    const progressToast = toast.info({
        title: 'IdentifierBuster',
        message: `Syncing ${total} player profiles...`,
        duration: 0
    });

    const updateProgress = () => {
        progressToast.update?.({ message: `Synced ${completed}/${total} players` });
    };

    const jobs = uniqueIds.map((playerId, index) => (async () => {
        await delay(index * ENQUEUE_DELAY_STEP_MS);
        try {
            const bundle = await bundleCache.getOrCreate(playerId, () =>
                queueClient.enqueue('fetchPlayerBundle', { playerId }, 1)
            );
            completed += 1;
            updateProgress();
            if (bundle?.playerData) {
                bundles.set(playerId, bundle);
            } else {
                failures.push({ playerId, error: new Error('Incomplete bundle data') });
                bundleCache.clear(playerId);
            }
        } catch (error) {
            completed += 1;
            updateProgress();
            failures.push({ playerId, error });
            bundleCache.clear(playerId);
            toast.error({
                title: 'Player fetch failed',
                message: `Player ${playerId}: ${error.message || 'Unknown error'}`
            });
        }
    })());

    await Promise.allSettled(jobs);
    progressToast.dismiss();

    if (failures.length === 0) {
        toast.success({ title: 'Players synced', message: `Loaded ${total} BattleMetrics profiles.` });
    } else {
        toast.warning({
            title: 'Partial sync',
            message: `Loaded ${total - failures.length}/${total} BattleMetrics profiles.`,
            duration: 8000
        });
    }

    return { bundles, failures, total };
}

// --- Calculation Helper Functions ---

/**
 * Calculates a name similarity percentage.
 * @param {string} mainName The first name.
 * @param {string} otherName The second name.
 * @returns {number} A percentage (0-100) of similarity.
 */
function calculateNameMatch(mainName, otherName) {
    // Levenshtein distance algorithm to find similarity
    const s1 = mainName.toLowerCase();
    const s2 = otherName.toLowerCase();
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 100;
    
    const costs = new Array(shorter.length + 1);
    for (let i = 0; i <= longer.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= shorter.length; j++) {
            if (i === 0) costs[j] = j;
            else if (j > 0) {
                let newValue = costs[j - 1];
                if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[shorter.length] = lastValue;
    }
    const distance = costs[shorter.length];
    return Math.round(((longer.length - distance) / longer.length) * 100);
}

/**
 * Counts the number of shared identifiers between two players.
 * @param {object[]} mainPlayerIdentifiers Identifiers from the main player.
 * @param {object[]} otherPlayerRelateds Related identifiers from the other player.
 * @returns {number} The count of common identifiers.
 */
function calculateAssociates(mainPlayerIdentifiers, otherPlayerRelateds) {
    if (!mainPlayerIdentifiers || !otherPlayerRelateds) return 0;

    // Create a Set of unique identifier strings for efficient lookup.
    // We ignore 'name' identifiers as they are too common.
    const mainIdentifierSet = new Set(
        mainPlayerIdentifiers
            .filter(id => id.attributes.type !== 'name')
            .map(id => `${id.attributes.type}:${id.attributes.identifier}`)
    );

    let commonCount = 0;
    otherPlayerRelateds.forEach(related => {
        const key = `${related.attributes.type}:${related.attributes.identifier}`;
        if (mainIdentifierSet.has(key)) {
            commonCount++;
        }
    });
    
    // We subtract 1 because, by definition, they share at least one identifier
    // which is the one that triggered this whole process.
    return Math.max(0, commonCount - 1);
}

/**
 * Finds how many days have passed since the most recent BattleMetrics ban.
 * @param {object[]} bans Active bans returned by the BattleMetrics API.
 * @returns {number|null} Days since the latest ban or null if timestamps are unavailable.
 */
function calculateDaysSinceMostRecentBan(bans) {
    if (!Array.isArray(bans) || bans.length === 0) return null;

    const timestamps = bans
        .map(ban => ban?.attributes?.timestamp || ban?.attributes?.createdAt || ban?.attributes?.updatedAt)
        .map(value => value ? Date.parse(value) : NaN)
        .filter(time => Number.isFinite(time));

    if (timestamps.length === 0) return null;

    const mostRecent = Math.max(...timestamps);
    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.max(0, Math.floor((Date.now() - mostRecent) / msPerDay));
}

/**
 * Summarizes BattleMetrics ban reasons into high-level categories.
 * @param {object[]} bans Active bans returned by the BattleMetrics API.
 * @returns {{reasonLabel: string|null, reasonDetail: string|null}}
 */
function summarizeBattleMetricsBans(bans) {
    if (!Array.isArray(bans) || bans.length === 0) {
        return { reasonLabel: null, reasonDetail: null };
    }

    const mapped = bans.map(ban => {
        const rawReason = ban?.attributes?.reason || '';
        return {
            raw: rawReason,
            label: classifyBattleMetricsReason(rawReason)
        };
    });

    const priorityOrder = ['Ban evading', 'Cheating', 'Breaking group limit', 'Suspicious ban', 'Server ban'];
    for (const priority of priorityOrder) {
        const match = mapped.find(item => item.label === priority);
        if (match) {
            return { reasonLabel: match.label, reasonDetail: match.raw }; // preserve original text for tooltip
        }
    }

    return { reasonLabel: null, reasonDetail: mapped[0]?.raw || null };
}

/**
 * Normalizes the provided reason string into a known category.
 * @param {string} reason BattleMetrics reason text.
 * @returns {string}
 */
function classifyBattleMetricsReason(reason) {
    if (!reason) return 'Server ban';
    const normalized = reason.toLowerCase();

    if (/ban\s*evad|evading/.test(normalized)) return 'Ban evading';
    if (/cheat|hack|aimbot|esp/.test(normalized)) return 'Cheating';
    if (/group\s*limit|teaming|over\s*team|over\s*group/.test(normalized)) return 'Breaking group limit';
    if (/suspicious|susp|alt|association/.test(normalized)) return 'Suspicious ban';

    return 'Server ban';
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function resolveFirstSeenDate(playerData, sessionData) {
    const attributes = playerData?.data?.attributes;
    const meta = playerData?.meta;
    const serverDates = collectServerMetaDates(playerData, 'firstSeen');
    
    // Extract earliest session start time from sessions API
    const sessions = Array.isArray(sessionData?.data) ? sessionData.data : [];
    const sessionStarts = sessions
        .map(s => s?.attributes?.start)
        .filter(Boolean);
    
    return resolveBattleMetricsDate([
        ...sessionStarts,
        attributes?.timeSeen?.first,
        attributes?.seen?.first,
        attributes?.firstSeen,
        meta?.timeSeen?.first,
        meta?.seen?.first,
        meta?.firstSeen,
        ...serverDates,
        attributes?.createdAt,
        meta?.createdAt
    ], Math.min);
}

function resolveLastSeenDate(playerData, sessionData) {
    const attributes = playerData?.data?.attributes;
    const meta = playerData?.meta;
    const serverDates = collectServerMetaDates(playerData, 'lastSeen');
    
    // Extract latest session stop or start time from sessions API
    const sessions = Array.isArray(sessionData?.data) ? sessionData.data : [];
    const sessionTimes = sessions
        .flatMap(s => [s?.attributes?.stop, s?.attributes?.start])
        .filter(Boolean);
    
    return resolveBattleMetricsDate([
        ...sessionTimes,
        attributes?.timeSeen?.last,
        attributes?.seen?.last,
        attributes?.lastSeen,
        meta?.timeSeen?.last,
        meta?.seen?.last,
        meta?.lastSeen,
        ...serverDates,
        attributes?.updatedAt,
        meta?.updatedAt
    ], Math.max);
}

function collectServerMetaDates(playerData, property) {
    const relationships = playerData?.data?.relationships || {};
    const rawEntries = relationships?.servers?.data ?? relationships?.server?.data;
    const entries = normalizeRelationshipEntries(rawEntries);
    const picker = property === 'lastSeen' ? 'last' : 'first';

    return entries
        .flatMap(entry => {
            const meta = entry?.meta || {};
            const candidates = [
                meta[property],
                meta?.timeSeen?.[picker],
                meta?.seen?.[picker]
            ];

            if (property === 'firstSeen') {
                candidates.push(meta.createdAt);
            } else if (property === 'lastSeen') {
                candidates.push(meta.updatedAt);
            }

            return candidates.filter(Boolean);
        });
}

function normalizeRelationshipEntries(entries) {
    if (!entries) return [];
    return Array.isArray(entries) ? entries : [entries];
}

function resolveBattleMetricsDate(candidates, picker) {
    const timestamps = candidates
        .map(parseDateToTimestamp)
        .filter(time => Number.isFinite(time));

    if (timestamps.length === 0) return null;

    const target = picker(...timestamps);
    return Number.isFinite(target) ? new Date(target) : null;
}

function parseDateToTimestamp(value) {
    if (!value) return NaN;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : NaN;
}

function formatDateLabel(date) {
    return date ? date.toISOString().split('T')[0] : '—';
}

function calculateDaysSinceDate(date) {
    if (!(date instanceof Date)) return null;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / MS_PER_DAY));
}

function buildTimelineMeta(firstSeenDate, lastSeenDate, bmBans) {
    if (!(firstSeenDate instanceof Date) || !(lastSeenDate instanceof Date)) return null;
    const startTs = firstSeenDate.getTime();
    const endTs = lastSeenDate.getTime();
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
        return null;
    }

    const spanMs = Math.max(endTs - startTs, MS_PER_DAY);
    const toPercent = (timestamp) => {
        const pct = ((timestamp - startTs) / spanMs) * 100;
        return Math.max(0, Math.min(100, pct));
    };

    const markers = (Array.isArray(bmBans) ? bmBans : [])
        .map(ban => {
            const ts = parseDateToTimestamp(ban?.attributes?.timestamp || ban?.attributes?.createdAt || ban?.attributes?.updatedAt);
            if (!Number.isFinite(ts)) return null;
            return {
                pct: toPercent(ts),
                label: ban?.attributes?.reason || 'Ban',
                dateLabel: formatDateLabel(new Date(ts))
            };
        })
        .filter(Boolean);

    return {
        startLabel: formatDateLabel(firstSeenDate),
        endLabel: formatDateLabel(lastSeenDate),
        spanDays: Math.max(1, Math.round(spanMs / MS_PER_DAY)),
        markers
    };
}
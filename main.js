// main.js

const PLAYER_PAGE_REGEX = /^\/rcon\/players\/(\d+)(?:\/|$)/;

const getCurrentPlayerId = () => {
    const match = PLAYER_PAGE_REGEX.exec(window.location.pathname);
    return match ? match[1] : null;
};

let currentBootstrappedPlayerId = null;
let navigationWatcherInstalled = false;
let activityOverlayModulePromise = null;

const handleUrlChange = () => {
    setTimeout(() => {
        const playerId = getCurrentPlayerId();
        if (playerId && playerId !== currentBootstrappedPlayerId) {
            currentBootstrappedPlayerId = playerId;
            bootstrapIdentifierBuster(playerId);
        } else if (!playerId && currentBootstrappedPlayerId) {
            currentBootstrappedPlayerId = null;
            console.debug('IdentifierBuster: Left player detail page.');
            resetActivityOverlay();
        }
    }, 50);
};

const installNavigationWatcher = () => {
    if (navigationWatcherInstalled) return;
    navigationWatcherInstalled = true;
    let lastUrl = location.href;
    const dispatchNavigation = () => {
        const current = location.href;
        if (current !== lastUrl) {
            lastUrl = current;
            handleUrlChange();
        }
    };

    window.addEventListener('popstate', dispatchNavigation);
    window.addEventListener('hashchange', dispatchNavigation);

    ['pushState', 'replaceState'].forEach((method) => {
        const original = history[method];
        history[method] = function patchedHistoryMethod(...args) {
            const result = original.apply(this, args);
            dispatchNavigation();
            return result;
        };
    });

    new MutationObserver(dispatchNavigation).observe(document.body || document, {
        subtree: true,
        childList: true
    });
};

installNavigationWatcher();
handleUrlChange();

const loadActivityOverlayModule = () => {
    if (!activityOverlayModulePromise) {
        activityOverlayModulePromise = import(chrome.runtime.getURL('./modules/activityLogOverlay.js'))
            .catch((error) => {
                console.warn('Failed to load activity overlay module', error);
                activityOverlayModulePromise = null;
                throw error;
            });
    }
    return activityOverlayModulePromise;
};

const mountActivityOverlay = (playerId) => {
    loadActivityOverlayModule()
        .then(({ mountActivityLogOverlay }) => mountActivityLogOverlay({ playerId }))
        .catch((error) => console.warn('Failed to initialize activity log overlay', error));
};

const resetActivityOverlay = () => {
    if (!activityOverlayModulePromise) return;
    activityOverlayModulePromise.then(({ resetActivityLogOverlay }) => {
        resetActivityLogOverlay?.();
    }).catch((error) => console.debug('Activity overlay reset skipped', error));
};

function bootstrapIdentifierBuster(playerId) {
    console.log("EXTENSION: BM Identifier Details Loaded!");

    // Reset processed nodes each time we land on a new player to guarantee
    // fresh button injection even if BattleMetrics reuses DOM nodes.
    processedElements = new WeakSet();

    if (document.body) {
        document.body.dataset.ibPlayerId = playerId;
    }

    mountActivityOverlay(playerId);

    import(chrome.runtime.getURL('./modules/api.js'))
        .then(({ ensureBattleMetricsTokenReady }) => (
            ensureBattleMetricsTokenReady().catch(error => {
                console.warn('BattleMetrics token unavailable at startup', error);
            })
        ))
        .catch(error => console.debug('Token sync module failed to load', error));

    import(chrome.runtime.getURL('./modules/progressHud.js'))
        .then(({ mountQueueHud }) => mountQueueHud())
        .catch(error => console.warn('Failed to mount queue HUD', error));

    const observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                const targetElements = [];
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) {
                        if (node.matches('.css-98ica9')) {
                            targetElements.push(node);
                        } else {
                            targetElements.push(...node.querySelectorAll('.css-98ica9'));
                        }
                    }
                });

                if (targetElements.length > 0) {
                    handleSharedIdentifierElements(targetElements);
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    handleSharedIdentifierElements(document.querySelectorAll('.css-98ica9'));
}

// Track processed elements per bootstrap cycle to avoid duplicate buttons.
let processedElements = new WeakSet();

async function handleSharedIdentifierElements(elements) {
    // Dynamically import the setup module only when needed
    const { setup } = await import(chrome.runtime.getURL('./modules/setup.js'));
    elements.forEach(element => {
        // If the element hasn't been processed yet, set it up.
        if (!processedElements.has(element)) {
            setup(element);
            processedElements.add(element);
        }
    });
}

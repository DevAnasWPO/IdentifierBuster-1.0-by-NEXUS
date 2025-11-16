// main.js

const PLAYER_PAGE_REGEX = /^\/rcon\/players\/(\d+)(?:\/|$)/;

const getCurrentPlayerId = () => {
    const match = PLAYER_PAGE_REGEX.exec(window.location.pathname);
    return match ? match[1] : null;
};

const currentPlayerId = getCurrentPlayerId();

if (currentPlayerId) {
    bootstrapIdentifierBuster(currentPlayerId);
} else {
    console.debug('IdentifierBuster: Skipping non-player detail page.', window.location.pathname);
}

function bootstrapIdentifierBuster(playerId) {
    console.log("EXTENSION: BM Identifier Details Loaded!");

    if (document.body) {
        document.body.dataset.ibPlayerId = playerId;
    }

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

// Use a WeakSet to keep track of elements that have already been processed
// to avoid adding multiple buttons to the same element.
const processedElements = new WeakSet();

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

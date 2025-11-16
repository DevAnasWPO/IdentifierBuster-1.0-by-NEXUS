const resolvedBundles = new Map();
const pendingBundles = new Map();

function normalizeBundle(playerId, rawResult) {
    if (!rawResult) return null;
    if (rawResult.bundle) return { ...rawResult.bundle, playerId }; // ensure playerId present
    return { playerId, ...rawResult };
}

export const bundleCache = {
    has(playerId) {
        return resolvedBundles.has(playerId);
    },
    get(playerId) {
        return resolvedBundles.get(playerId) || null;
    },
    set(playerId, bundle) {
        if (!bundle) return;
        resolvedBundles.set(playerId, { ...bundle, playerId });
        pendingBundles.delete(playerId);
    },
    getOrCreate(playerId, factory) {
        if (resolvedBundles.has(playerId)) {
            return Promise.resolve(resolvedBundles.get(playerId));
        }
        if (pendingBundles.has(playerId)) {
            return pendingBundles.get(playerId);
        }
        const promise = Promise.resolve().then(() => factory()).then(result => {
            const bundle = normalizeBundle(playerId, result);
            if (bundle) {
                resolvedBundles.set(playerId, bundle);
            }
            pendingBundles.delete(playerId);
            return bundle;
        }).catch(error => {
            pendingBundles.delete(playerId);
            throw error;
        });
        pendingBundles.set(playerId, promise);
        return promise;
    },
    clear(playerId) {
        resolvedBundles.delete(playerId);
        pendingBundles.delete(playerId);
    },
    keys() {
        return Array.from(resolvedBundles.keys());
    }
};

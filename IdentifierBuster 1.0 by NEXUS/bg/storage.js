const DB_NAME = 'identifierBuster';
const DB_VERSION = 1;
const JOB_STORE = 'jobs';

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(JOB_STORE)) {
                const store = db.createObjectStore(JOB_STORE, { keyPath: 'id' });
                store.createIndex('state', 'state', { unique: false });
                store.createIndex('nextRunAt', 'nextRunAt', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore(mode, callback) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(JOB_STORE, mode);
        const store = tx.objectStore(JOB_STORE);
        const request = callback(store);
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
    });
}

export const jobStore = {
    async put(job) {
        return withStore('readwrite', (store) => store.put(job));
    },
    async get(id) {
        return withStore('readonly', (store) => store.get(id));
    },
    async delete(id) {
        return withStore('readwrite', (store) => store.delete(id));
    },
    async getAll() {
        return withStore('readonly', (store) => store.getAll());
    }
};

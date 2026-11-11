// 영상 분석 프레임 데이터는 크기가 커서(3분 ≈ 1.3MB) localStorage 대신 IndexedDB에 둔다.
const DB_NAME = 'strikecoach';
const STORE = 'frames';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const putFrames = (id, buf) => run('readwrite', (s) => s.put(buf, id));
export const getFrames = (id) => run('readonly', (s) => s.get(id)).catch(() => null);
export const deleteFrames = (id) => run('readwrite', (s) => s.delete(id)).catch(() => {});

// Hält den Bildschirm an, solange gestrickt wird.
let lock = null;
let wanted = false;

async function acquire() {
  if (!wanted || lock || !('wakeLock' in navigator)) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch (e) {
    lock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquire();
});

export function keepAwake(on) {
  wanted = on;
  if (on) acquire();
  else if (lock) { lock.release().catch(() => {}); lock = null; }
}

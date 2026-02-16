
/**
 * Wandelt ein Error-Objekt in ein JSON-serialisierbares Objekt um.
 *
 * Hintergrund:
 * Native Error-Objekte werden von Loggern (z.B. pino)
 * nicht vollständig serialisiert. Besonders stack und custom fields
 * gehen oft verloren oder erscheinen unlesbar.
 *
 * Diese Funktion extrahiert die relevanten Felder,
 * sodass Logs konsistent und maschinenlesbar bleiben.
 *
 * @param {Error} err
 * @returns {{message?:string,name?:string,code?:string,stack?:string,context?:any}}
 */
function errToObj(err) {
  return {
      message: err?.message,
      name: err?.name,
      code: err?.code,
      stack: err?.stack,
      context: err?.context,
  };
}

/**
 * Wrappt eine async Operation und sorgt dafür,
 * dass sie niemals nach außen wirft.
 *
 * Zweck:
 * - Vereinheitlicht Fehlerbehandlung
 * - Macht Promise.all statt allSettled möglich
 * - Verhindert try/catch-Spaghetti im Aufrufer
 *
 * Verhalten:
 * - Bei Erfolg:  { ok: true,  label, value, meta }
 * - Bei Fehler:  { ok: false, label, err, errObj, meta }
 *
 * WICHTIG:
 * Die übergebene Funktion fn darf normal throwen.
 * op() fängt den Fehler intern ab und transformiert ihn
 * in ein strukturiertes Result-Objekt.
 *
 * @param {string} label  - Technischer Bezeichner der Operation (z.B. "buy.place")
 * @param {Function} fn   - Async-Funktion, die ausgeführt werden soll
 * @param {Object} meta   - Optionaler Kontext (intentId, exchange, symbol, etc.)
 * @returns {Promise<{ok:boolean,label:string,value?:any,err?:Error,errObj?:Object,meta?:Object}>}
 */
async function op(label, fn, meta = {}) {
  try {
    const value = await fn();
    return { ok: true, label, value, meta };
  } catch (err) {
    return { ok: false, label, err, errObj: errToObj(err), meta };
  }
}

/**
 * Führt eine async Operation aus und verhindert,
 * dass sie nach außen wirft.
 *
 * Statt Exceptions wird immer ein strukturiertes
 * Result-Objekt zurückgegeben.
 *
 * Erfolg:
 *   { ok: true, value }
 *
 * Fehler:
 *   { ok: false, error }
 *
 * Typischer Einsatz:
 *   - Best-effort Cancel
 *   - Rebuy / Resell
 *   - Cleanup-Operationen
 *
 * Nicht gedacht für:
 *   - Logik, bei der Exceptions gewollt weitergereicht werden sollen
 *
 * @param {Promise|Function} input - Promise oder async Funktion
 * @returns {Promise<{ok:boolean,value?:any,error?:Error}>}
 */
async function safeCall(input) {
  try {
    const value = typeof input === 'function'
      ? await input()
      : await input;

    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}


module.exports = {
  op,
  errToObj,
  safeCall,
};
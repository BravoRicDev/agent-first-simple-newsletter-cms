// Worker thread per find-replace con regex: una regex ReDoS sincrona blocca
// l'event loop e un semplice setTimeout NON può mai scattare durante
// l'esecuzione (vedi withRegexTimeout in agent.js, ora rimosso). Eseguendo
// la regex in un worker separato, il main può fare worker.terminate() dopo
// il timeout: il thread viene ucciso davvero anche a backtracking in corso.
import { parentPort, workerData } from "worker_threads";

try {
  const { pattern, flags, content, replace, mode } = workerData || {};
  const re = new RegExp(pattern, flags);
  let result;
  if (mode === "match") {
    const m = content.match(re);
    result = m ? Array.from(m, (x) => (x === undefined ? null : String(x))) : null;
  } else {
    result = content.replace(re, replace);
  }
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}

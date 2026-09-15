import dns from "node:dns";

const PRIVATE_RANGES = [
  [127, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [169, 254, 0, 0, 16],
  [0, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
];

function isDisallowedIpv4(parts) {
  const [a, b, c, d] = parts;
  for (const [ra, rb, rc, rd, bits] of PRIVATE_RANGES) {
    const networkBytes = bits / 8;
    const hostBits = bits % 8;
    const mask = hostBits === 0 ? 0 : 256 - 2 ** (8 - hostBits);
    let match = true;
    const ip = [a, b, c, d];
    const net = [ra, rb, rc, rd];
    for (let i = 0; i < 4; i++) {
      if (i < networkBytes) {
        if (ip[i] !== net[i]) match = false;
      } else if (i === networkBytes) {
        if ((ip[i] & mask) !== (net[i] & mask)) match = false;
      } else {
        break;
      }
      if (!match) break;
    }
    if (match) return true;
  }
  return false;
}

function isDisallowedIpv6(address) {
  if (address === "::1") return true;
  if (address.startsWith("fe80:")) return true;
  if (address.startsWith("fc00:") || address.startsWith("fd00:")) return true;

  // Gestione forme che incapsulano un IPv4 privato (SSRF bypass):
  //   ::ffff:127.0.0.1        (IPv4-mapped, dotted)
  //   ::ffff:7f00:1           (IPv4-mapped, hex)
  //   ::127.0.0.1             (IPv4-compatible)
  //   2002:7f00:1::           (6to4 — primi 2 gruppi = IPv4)
  //   ::ffff:a9fe:a9fe        (169.254.169.254, metadata cloud)
  const expanded = expandIpv6Groups(address);
  if (expanded) {
    const [g0, g1, g2, g3, g4, g5, g6, g7] = expanded;

    // IPv4-mapped (::ffff:0:0/96)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return isDisallowedIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
    }
    // IPv4-compatible (::/96)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isDisallowedIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
    }
    // 6to4 (2002::/16) — i primi 2 gruppi sono l'IPv4
    if (g0 === 0x2002) {
      return isDisallowedIpv4([(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff]);
    }
    // Teredo (2001:0000::/32) — tunnel che incapsula IPv4; nessun servizio
    // legittimo pubblico usa Teredo per hosting, blocca tutto il range.
    if (g0 === 0x2001 && g1 === 0) return true;
  }

  return false;
}

// Espande un indirizzo IPv6 in 8 gruppi numerici (gestisce "::"), oppure null.
function expandIpv6Groups(address) {
  try {
    let [head, tail] = address.split("::");
    if (!head && !tail) return null;
    const parse = (part) => part.split(":").map((h) => parseInt(h || "0", 16));
    const headGroups = head ? parse(head) : [];
    const tailGroups = tail ? parse(tail) : [];
    const total = headGroups.length + tailGroups.length;
    if (total > 7) return null; // 8+ gruppi espliciti: non è "::" valido
    const zeros = 8 - total;
    return [...headGroups, ...Array(zeros).fill(0), ...tailGroups];
  } catch {
    return null;
  }
}

function isDisallowedIp(address, family) {
  if (family === 4) {
    return isDisallowedIpv4(address.split(".").map(Number));
  }
  if (family === 6) {
    return isDisallowedIpv6(address);
  }
  return false;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Fetch che rivalida l'IP di destinazione ad ogni hop di redirect, per evitare
// che un URL pubblico iniziale rediriga verso un host interno (SSRF).
// Con options.allowPrivate=true (SOLO per test con server locali) salta il
// blocco IP privati/loopback: mai esposto via API, default sicuro.
export async function safeFetch(urlString, options = {}, maxRedirects = 5) {
  let currentUrl = urlString;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!options.allowPrivate) await assertPublicHttpUrl(currentUrl);
    const response = await fetch(currentUrl, { ...options, redirect: "manual" });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect senza header Location");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error("Troppi redirect (" + maxRedirects + ")");
}

export async function assertPublicHttpUrl(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new Error("URL non valido");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Solo schemi HTTP/HTTPS consentiti");
  }
  const hostname = parsedUrl.hostname;
  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new Error("Impossibile risolvere host: " + hostname);
  }
  for (const { address, family } of addresses) {
    if (isDisallowedIp(address, family)) {
      throw new Error("Indirizzo IP non consentito: " + hostname);
    }
  }
  return true;
}

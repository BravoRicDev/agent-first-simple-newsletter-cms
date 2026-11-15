(function () {
  function b64uToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  function bufToB64u(buf) {
    var arr = new Uint8Array(buf), bin = '';
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  async function create(optionsJSON) {
    var opts = clone(optionsJSON);
    opts.challenge = b64uToBuf(opts.challenge);
    opts.user.id = b64uToBuf(opts.user.id);
    (opts.excludeCredentials || []).forEach(function (c) { c.id = b64uToBuf(c.id); });
    var cred = await navigator.credentials.create({ publicKey: opts });
    return {
      id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : []
      }
    };
  }
  async function get(optionsJSON) {
    var opts = clone(optionsJSON);
    opts.challenge = b64uToBuf(opts.challenge);
    (opts.allowCredentials || []).forEach(function (c) { c.id = b64uToBuf(c.id); });
    var cred = await navigator.credentials.get({ publicKey: opts });
    return {
      id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined
      }
    };
  }
  window.cmsWebauthn = { supported: !!(window.PublicKeyCredential && navigator.credentials), create: create, get: get };
})();

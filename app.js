/* UniShare uses PeerJS for signaling and WebRTC for the media connection. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'hostTab', 'watchTab', 'hostPanel', 'watchPanel', 'startShare', 'audioToggle',
    'pauseShare', 'continueShare', 'stopShare', 'copyCode', 'copyLink', 'joinForm',
    'joinCode', 'hostVideo', 'viewerVideo', 'hostStatus', 'viewerStatus', 'shareCode',
    'shareLink', 'toast', 'viewerPlay', 'hostAudioStatus', 'hostPlaceholder', 'viewerPlaceholder'
  ].map((id) => [id, $(id)]));

  let hostPeer = null;
  let hostStream = null;
  let hostTimer = null;
  let paused = false;
  let viewers = new Set();
  let viewerPeer = null;
  let viewerConnection = null;
  let viewerCall = null;
  let joinTimer = null;
  let toastTimer = null;
  let joining = false;
  let remotePaused = false;

  function message(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3000);
  }

  function selectTab(name) {
    const hosting = name === 'host';
    ui.hostTab.classList.toggle('active', hosting);
    ui.watchTab.classList.toggle('active', !hosting);
    ui.hostTab.setAttribute('aria-selected', String(hosting));
    ui.watchTab.setAttribute('aria-selected', String(!hosting));
    ui.hostPanel.hidden = !hosting;
    ui.watchPanel.hidden = hosting;
  }

  function setHostState(state) {
    const live = state === 'live' || state === 'paused';
    ui.startShare.disabled = live || state === 'starting';
    ui.audioToggle.disabled = live || state === 'starting';
    ui.pauseShare.disabled = state !== 'live';
    ui.continueShare.disabled = state !== 'paused';
    ui.stopShare.disabled = !live;
    ui.copyCode.disabled = !live;
    ui.copyLink.disabled = !live;
    ui.hostStatus.textContent = ({ idle: 'Ready to share', starting: 'Connecting', live: 'Streaming', paused: 'Paused' })[state];
    ui.hostStatus.dataset.state = state;
    ui.hostPanel.dataset.state = state;
  }

  function setViewerStatus(text, state = 'idle') {
    ui.viewerStatus.textContent = text;
    ui.viewerStatus.dataset.state = state;
    ui.watchPanel.dataset.state = state;
  }

  function generateCode() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{1,4}/g).join('-');
  }

  function normalizeCode(value) {
    let input = value.trim();
    try {
      const url = new URL(input);
      input = url.searchParams.get('join') || input;
    } catch (_) { /* A code is not a URL. */ }
    return input.toUpperCase().replace(/[^A-F0-9]/g, '');
  }

  function peerId(code) { return `unishare-${code.replace(/-/g, '').toLowerCase()}`; }

  function broadcast(data) {
    for (const conn of viewers) {
      if (conn.open) {
        try { conn.send(data); } catch (_) { /* A disconnected viewer is removed on close. */ }
      }
    }
  }

  function stopHosting(reason = 'Sharing stopped') {
    clearTimeout(hostTimer);
    broadcast({ type: 'ended' });
    for (const conn of viewers) conn.close();
    viewers.clear();
    const oldHostPeer = hostPeer;
    hostPeer = null;
    if (oldHostPeer) oldHostPeer.destroy();
    if (hostStream) {
      hostStream.getTracks().forEach((track) => track.stop());
      hostStream = null;
    }
    ui.hostVideo.srcObject = null;
    ui.hostVideo.hidden = true;
    ui.hostPlaceholder.hidden = false;
    ui.shareCode.textContent = '— — — —';
    ui.shareLink.textContent = 'Your link will appear here';
    ui.hostAudioStatus.textContent = 'Choose whether to include audio before sharing.';
    paused = false;
    setHostState('idle');
    if (reason) message(reason);
  }

  async function startHosting() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      message('Screen sharing requires a supported browser on HTTPS or localhost.');
      return;
    }
    if (typeof Peer === 'undefined') {
      message('The connection service could not load. Check your internet connection.');
      return;
    }
    setHostState('starting');
    try {
      // This call stays directly in the click handler's activation chain.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window' }, audio: ui.audioToggle.checked });
      hostStream = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => stopHosting('Screen sharing ended'));
      ui.hostVideo.srcObject = stream;
      ui.hostVideo.hidden = false;
      ui.hostPlaceholder.hidden = true;
      ui.hostVideo.play().catch(() => {});
      const hasAudio = stream.getAudioTracks().length > 0;
      ui.hostAudioStatus.textContent = hasAudio ? 'Audio is being shared.' : (ui.audioToggle.checked ? 'No audio was supplied by your browser or selected source.' : 'Sharing without audio.');
      const code = generateCode();
      const link = new URL(window.location.href);
      link.search = '';
      link.hash = '';
      link.searchParams.set('join', code);
      const peer = new Peer(peerId(code));
      hostPeer = peer;
      hostTimer = setTimeout(() => {
        if (hostPeer === peer) stopHosting('Could not connect to the sharing service. Please try again.');
      }, 20000);
      peer.on('open', () => {
        if (hostPeer !== peer) return;
        clearTimeout(hostTimer);
        ui.shareCode.textContent = code;
        ui.shareLink.textContent = link.toString();
        setHostState('live');
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          if (hostPeer !== peer || !hostStream) { conn.close(); return; }
          viewers.add(conn);
          conn.send({ type: 'state', paused, hasAudio });
          const call = peer.call(conn.peer, hostStream);
          if (call) call.on('error', () => conn.close());
        });
        conn.on('close', () => viewers.delete(conn));
        conn.on('error', () => viewers.delete(conn));
      });
      peer.on('error', (error) => {
        if (hostPeer !== peer) return;
        stopHosting('Connection failed. Please try sharing again.');
        console.error('Host connection error:', error.type);
      });
      peer.on('disconnected', () => {
        if (hostPeer === peer) stopHosting('Connection to the sharing service was lost.');
      });
    } catch (error) {
      if (hostStream) stopHosting('Could not start sharing. Please try again.');
      else {
        setHostState('idle');
        message(error.name === 'NotAllowedError' ? 'Screen selection was cancelled.' : 'Could not start screen sharing.');
      }
    }
  }

  function changePause(nextPaused) {
    if (!hostStream) return;
    paused = nextPaused;
    hostStream.getTracks().forEach((track) => { track.enabled = !paused; });
    broadcast({ type: 'state', paused, hasAudio: hostStream.getAudioTracks().length > 0 });
    setHostState(paused ? 'paused' : 'live');
  }

  function resetViewer(status = 'Ready to connect', state = 'idle') {
    clearTimeout(joinTimer);
    joining = false;
    const oldCall = viewerCall;
    const oldConnection = viewerConnection;
    const oldPeer = viewerPeer;
    viewerCall = null;
    viewerConnection = null;
    viewerPeer = null;
    if (oldCall) oldCall.close();
    if (oldConnection) oldConnection.close();
    if (oldPeer) oldPeer.destroy();
    ui.viewerVideo.srcObject = null;
    ui.viewerVideo.hidden = true;
    ui.viewerPlaceholder.hidden = false;
    remotePaused = false;
    ui.viewerPlay.hidden = true;
    const submit = ui.joinForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = false;
    setViewerStatus(status, state);
  }

  function join(code) {
    const normalized = normalizeCode(code);
    if (normalized.length !== 24) { message('Enter a valid share code or link.'); return; }
    if (typeof Peer === 'undefined') { message('The connection service could not load. Check your internet connection.'); return; }
    resetViewer();
    joining = true;
    setViewerStatus('Connecting…', 'connecting');
    const submit = ui.joinForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const peer = new Peer();
    viewerPeer = peer;
    joinTimer = setTimeout(() => {
      if (viewerPeer === peer && joining) resetViewer('Could not connect. Check the code and try again.', 'error');
    }, 25000);
    peer.on('open', () => {
      if (viewerPeer !== peer) return;
      const conn = peer.connect(peerId(normalized), { reliable: true });
      viewerConnection = conn;
      conn.on('data', (data) => {
        if (viewerPeer !== peer || !data) return;
        if (data.type === 'ended') resetViewer('The host ended the stream.', 'idle');
        if (data.type === 'state') {
          remotePaused = Boolean(data.paused);
          setViewerStatus(remotePaused ? 'Stream paused by host' : 'Connected', remotePaused ? 'paused' : 'live');
        }
      });
      conn.on('close', () => {
        if (viewerPeer === peer) resetViewer('The host disconnected.', 'idle');
      });
      conn.on('error', () => {
        if (viewerPeer === peer) resetViewer('Connection failed. Check the code and try again.', 'error');
      });
    });
    peer.on('call', (call) => {
      if (viewerPeer !== peer || call.peer !== peerId(normalized)) { call.close(); return; }
      viewerCall = call;
      call.on('stream', (stream) => {
        if (viewerPeer !== peer) return;
        clearTimeout(joinTimer);
        joining = false;
        ui.viewerVideo.srcObject = stream;
        ui.viewerVideo.hidden = false;
        ui.viewerPlaceholder.hidden = true;
        ui.viewerVideo.muted = false;
        ui.viewerPlay.hidden = false;
        ui.viewerVideo.play().catch(() => {
          message('Press play to view the stream and enable audio.');
        });
        setViewerStatus(remotePaused ? 'Stream paused by host' : 'Connected', remotePaused ? 'paused' : 'live');
        if (submit) submit.disabled = false;
      });
      call.on('error', () => {
        if (viewerPeer === peer) resetViewer('The stream could not be opened.', 'error');
      });
      call.answer();
    });
    peer.on('error', () => {
      if (viewerPeer === peer) resetViewer('Connection failed. Check the code and try again.', 'error');
    });
    peer.on('disconnected', () => {
      if (viewerPeer === peer) resetViewer('Connection to the sharing service was lost.', 'error');
    });
  }

  async function copy(value) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); message('Copied to clipboard'); }
    catch (_) {
      const input = document.createElement('textarea');
      input.value = value;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const success = document.execCommand('copy');
      input.remove();
      message(success ? 'Copied to clipboard' : 'Could not copy. Select the text instead.');
    }
  }

  ui.hostTab.addEventListener('click', () => selectTab('host'));
  ui.watchTab.addEventListener('click', () => selectTab('watch'));
  ui.startShare.addEventListener('click', startHosting);
  ui.pauseShare.addEventListener('click', () => changePause(true));
  ui.continueShare.addEventListener('click', () => changePause(false));
  ui.stopShare.addEventListener('click', () => stopHosting());
  ui.copyCode.addEventListener('click', () => copy(ui.shareCode.textContent));
  ui.copyLink.addEventListener('click', () => copy(ui.shareLink.textContent));
  ui.joinForm.addEventListener('submit', (event) => { event.preventDefault(); join(ui.joinCode.value); });
  ui.viewerPlay.addEventListener('click', () => {
    ui.viewerVideo.muted = false;
    ui.viewerVideo.play().catch(() => message('Your browser could not play this stream.'));
  });
  const incoming = new URLSearchParams(window.location.search).get('join');
  if (incoming) { ui.joinCode.value = incoming; selectTab('watch'); }
  setHostState('idle');
})();

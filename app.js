/* UniShare uses PeerJS for signaling and WebRTC for the media connection. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'hostTab', 'watchTab', 'hostPanel', 'watchPanel', 'startShare', 'audioToggle',
    'pauseShare', 'continueShare', 'stopShare', 'copyCode', 'copyLink', 'joinForm',
    'joinCode', 'hostVideo', 'viewerVideo', 'hostStatus', 'viewerStatus', 'shareCode',
    'shareLink', 'toast', 'viewerPlay', 'hostAudioStatus', 'hostPlaceholder', 'viewerPlaceholder',
    'homeTab', 'homePanel'
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
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let selectedTab = 'home';

  function message(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3000);
  }

  function selectTab(name) {
    if (selectedTab === name) return;
    selectedTab = name;
    const hosting = name === 'host';
    const watching = name === 'watch';
    const home = name === 'home';
    ui.homeTab.classList.toggle('active', home);
    ui.hostTab.classList.toggle('active', hosting);
    ui.watchTab.classList.toggle('active', watching);
    ui.homeTab.setAttribute('aria-selected', String(home));
    ui.hostTab.setAttribute('aria-selected', String(hosting));
    ui.watchTab.setAttribute('aria-selected', String(watching));
    const panels = [ui.homePanel, ui.hostPanel, ui.watchPanel];
    panels.forEach((panel) => panel.classList.remove('is-entering', 'is-leaving'));
    ui.homePanel.hidden = !home;
    ui.hostPanel.hidden = !hosting;
    ui.watchPanel.hidden = !watching;
    const activePanel = home ? ui.homePanel : (hosting ? ui.hostPanel : ui.watchPanel);
    // Start a fresh entrance even if the visitor switches back quickly.
    if (!reducedMotion.matches) {
      void activePanel.offsetWidth;
      activePanel.classList.add('is-entering');
    }
  }

  function setHostState(state) {
    const live = state === 'live' || state === 'paused';
    ui.startShare.disabled = live || state === 'starting';
    ui.audioToggle.disabled = live || state === 'starting';
    ui.pauseShare.disabled = state !== 'live';
    ui.continueShare.disabled = state !== 'paused';
    ui.stopShare.disabled = !live && state !== 'starting';
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

  function hostErrorMessage(error) {
    const type = error && error.type;
    const explanations = {
      'browser-incompatible': 'This browser does not support the connection. Try Chrome or Edge.',
      'network': 'Cannot reach the sharing service. Check your internet connection or try another network.',
      'server-error': 'The sharing service is unavailable. Please try again later.',
      'socket-error': 'The sharing service connection was blocked. Try another network or disable a blocking extension.',
      'socket-closed': 'The sharing service closed the connection. Please try again.',
      'unavailable-id': 'Could not reserve a share code. Please try again.',
      'invalid-key': 'The sharing service rejected its connection key.',
      'ssl-unavailable': 'A secure connection to the sharing service is unavailable.'
    };
    return (explanations[type] || 'Could not connect to the sharing service. Please try again.') + (type ? ` (${type})` : '');
  }

  function viewerErrorMessage(error) {
    const type = error && error.type;
    const explanations = {
      'browser-incompatible': 'WebRTC is unavailable or blocked in this browser. Try Chrome or Edge, or check Firefox privacy extensions.',
      'peer-unavailable': 'No active share was found for this code. Keep the host page open and copy a fresh code.',
      'network': 'Cannot reach the sharing service. Check your internet connection or try another network.',
      'server-error': 'The sharing service is unavailable. Please try again later.',
      'socket-error': 'The connection to the sharing service was blocked. Check your network or privacy extensions.',
      'socket-closed': 'The sharing service closed the connection. Please try again.',
      'unavailable-id': 'Could not create a viewer connection. Please try again.',
      'webrtc': 'The browsers could not establish a direct connection. Try another network or check privacy extensions.',
      'negotiation-failed': 'The browsers could not establish a direct connection. Try another network or check privacy extensions.'
    };
    return (explanations[type] || 'Could not connect to the stream. Try again and check that the host is still sharing.') + (type ? ` (${type})` : '');
  }

  function connectHost(attempt = 1) {
    if (!hostStream) return;
    const code = generateCode();
    const link = new URL(window.location.href);
    link.search = '';
    link.hash = '';
    link.searchParams.set('join', code);
    const peer = new Peer(peerId(code));
    const hasAudio = hostStream.getAudioTracks().length > 0;
    let opened = false;
    let handled = false;
    hostPeer = peer;

    function connectionFailed(error) {
      if (hostPeer !== peer || handled) return;
      handled = true;
      clearTimeout(hostTimer);
      const retryable = !opened && (!error || ['network', 'server-error', 'socket-error', 'socket-closed', 'unavailable-id'].includes(error.type));
      if (retryable && attempt < 3 && hostStream) {
        hostPeer = null;
        peer.destroy();
        ui.hostStatus.textContent = `Connecting · retry ${attempt + 1}/3`;
        hostTimer = setTimeout(() => {
          if (hostStream && !hostPeer) connectHost(attempt + 1);
        }, attempt * 1000);
        return;
      }
      const reason = hostErrorMessage(error);
      stopHosting(reason);
      ui.hostStatus.textContent = reason;
      ui.hostStatus.dataset.state = 'error';
    }

    hostTimer = setTimeout(() => connectionFailed({ type: 'network' }), 15000);
    peer.on('open', () => {
      if (hostPeer !== peer) return;
      opened = true;
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
      console.error('Host connection error:', error.type, error.message);
      if (opened && ['peer-unavailable', 'webrtc'].includes(error.type)) {
        message('A viewer could not connect. They can try joining again.');
        return;
      }
      connectionFailed(error);
    });
    peer.on('disconnected', () => connectionFailed({ type: 'network' }));
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
      connectHost();
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
    // A local random viewer ID avoids a separate broker ID lookup before connecting.
    const peer = new Peer(`unishare-viewer-${generateCode().replace(/-/g, '').toLowerCase()}`);
    viewerPeer = peer;
    joinTimer = setTimeout(() => {
      if (viewerPeer === peer && joining) resetViewer('Connection timed out. Check the host is still sharing, or try another network.', 'error');
    }, 45000);
    peer.on('open', () => {
      if (viewerPeer !== peer) return;
      const conn = peer.connect(peerId(normalized), { reliable: true });
      viewerConnection = conn;
      conn.on('open', () => {
        if (viewerPeer === peer && joining) setViewerStatus('Connected to host. Opening stream…', 'connecting');
      });
      conn.on('data', (data) => {
        if (viewerPeer !== peer || !data) return;
        if (data.type === 'ended') resetViewer('The host ended the stream.', 'idle');
        if (data.type === 'state') {
          remotePaused = Boolean(data.paused);
          setViewerStatus(remotePaused ? 'Stream paused by host' : (joining ? 'Connected to host. Opening stream…' : 'Connected'), remotePaused ? 'paused' : (joining ? 'connecting' : 'live'));
        }
      });
      conn.on('close', () => {
        if (viewerPeer === peer) resetViewer(joining ? 'Connection closed before the stream arrived. Try again or use another network.' : 'The host disconnected.', joining ? 'error' : 'idle');
      });
      conn.on('error', (error) => {
        if (viewerPeer === peer) resetViewer(viewerErrorMessage(error), 'error');
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
      call.on('error', (error) => {
        if (viewerPeer === peer) resetViewer(viewerErrorMessage(error), 'error');
      });
      call.answer();
    });
    peer.on('error', (error) => {
      if (viewerPeer === peer) {
        console.error('Viewer connection error:', error.type, error.message);
        resetViewer(viewerErrorMessage(error), 'error');
      }
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

  ui.homeTab.addEventListener('click', () => selectTab('home'));
  $('homeLogo').addEventListener('click', () => selectTab('home'));
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
  if (!reducedMotion.matches) ui.homePanel.classList.add('is-entering');
  const incoming = new URLSearchParams(window.location.search).get('join');
  if (incoming) { ui.joinCode.value = incoming; selectTab('watch'); }
  window.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || event.pointerType === 'touch') return;
    const x = (event.clientX / window.innerWidth - 0.5) * 30;
    const y = (event.clientY / window.innerHeight - 0.5) * 30;
    document.documentElement.style.setProperty('--pointer-x', `${x.toFixed(1)}px`);
    document.documentElement.style.setProperty('--pointer-y', `${y.toFixed(1)}px`);
  }, { passive: true });
  window.addEventListener('pointerleave', () => {
    document.documentElement.style.setProperty('--pointer-x', '0px');
    document.documentElement.style.setProperty('--pointer-y', '0px');
  });
  setHostState('idle');
})();

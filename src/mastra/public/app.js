/* Keplar Outreach — static chat client.
 *
 * Source of truth is the server DB. This client:
 *  - persists threadId in localStorage (survives reload — R3),
 *  - paints from GET /thread/:id on load (and after every live event),
 *  - opens an SSE stream for instant updates (R2), with a poll fallback.
 * The drafted email is appended server-side; we just re-render the thread.
 */

const THREAD_KEY = 'keplar.threadId';

const els = {
  thread: document.getElementById('thread'),
  composer: document.getElementById('composer'),
  url: document.getElementById('prospect-url'),
  message: document.getElementById('message'),
  send: document.getElementById('send'),
  newChat: document.getElementById('new-chat'),
};

let threadId = localStorage.getItem(THREAD_KEY) || null;
let evtSource = null;
let pollTimer = null;
let researching = false;

// ── Rendering ────────────────────────────────────────────────────────────────

function clearThread() {
  els.thread.replaceChildren();
}

function renderEmpty() {
  const p = document.createElement('div');
  p.className = 'empty';
  p.textContent =
    'Enter a prospect and send. The assistant will acknowledge instantly, research them in the background, and drop a personalized Keplar outreach email right here.';
  els.thread.appendChild(p);
}

function looksLikeEmail(content) {
  return content.startsWith('Subject:');
}

function renderEmail(content) {
  // content = "Subject: <subject>\n\n<body>"
  const nl = content.indexOf('\n');
  const subject = content.slice('Subject:'.length, nl === -1 ? undefined : nl).trim();
  const body = nl === -1 ? '' : content.slice(nl).replace(/^\s+/, '');

  const card = document.createElement('div');
  card.className = 'email';

  const head = document.createElement('div');
  head.className = 'email-head';
  const subj = document.createElement('div');
  subj.className = 'subject';
  subj.textContent = subject || '(no subject)';
  const copy = document.createElement('button');
  copy.className = 'copy-btn';
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      copy.textContent = 'Copied';
      copy.classList.add('copied');
      setTimeout(() => {
        copy.textContent = 'Copy';
        copy.classList.remove('copied');
      }, 1500);
    } catch {
      /* clipboard may be blocked; ignore */
    }
  });
  head.append(subj, copy);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'body';
  bodyEl.textContent = body;

  card.append(head, bodyEl);
  return card;
}

function renderMessage(msg) {
  if (msg.role === 'assistant' && looksLikeEmail(msg.content)) {
    return renderEmail(msg.content);
  }
  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;
  div.textContent = msg.content;
  return div;
}

function renderIndicator(prospect) {
  const div = document.createElement('div');
  div.className = 'indicator';
  div.id = 'indicator';
  const label = document.createElement('span');
  label.textContent = `Researching ${prospect || 'the prospect'}…`;
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.innerHTML = '<i></i><i></i><i></i>';
  div.append(dots, label);
  return div;
}

function scrollToBottom() {
  els.thread.scrollTop = els.thread.scrollHeight;
}

function render(messages, activeJob) {
  clearThread();
  if (!messages || messages.length === 0) {
    if (!activeJob) {
      renderEmpty();
      return;
    }
  }
  for (const m of messages) {
    els.thread.appendChild(renderMessage(m));
  }
  researching = !!activeJob && activeJob.status === 'running';
  if (researching) {
    els.thread.appendChild(renderIndicator(activeJob.prospect));
  }
  scrollToBottom();
}

// ── Server interaction ───────────────────────────────────────────────────────

async function loadThread() {
  if (!threadId) {
    render([], null);
    return;
  }
  try {
    const res = await fetch(`/thread/${threadId}`);
    if (!res.ok) throw new Error(`thread ${res.status}`);
    const data = await res.json();
    render(data.messages, data.activeJob);
    if (data.activeJob && data.activeJob.status === 'running') {
      ensureSSE();
      ensurePoll();
    } else {
      stopPoll();
    }
  } catch (e) {
    console.error('loadThread failed', e);
  }
}

async function sendMessage() {
  const message = els.message.value.trim();
  if (!message) return;

  const prospect = {};
  const url = els.url.value.trim();
  if (url) prospect.linkedinUrl = url;

  els.send.disabled = true;
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ threadId, message, prospect }),
    });
    if (!res.ok) throw new Error(`chat ${res.status}`);
    const data = await res.json();

    if (!threadId) {
      threadId = data.threadId;
      localStorage.setItem(THREAD_KEY, threadId);
    }
    // Reconnect SSE to the (possibly new) thread, then paint from the DB.
    resetSSE();
    await loadThread();
    ensureSSE();
    ensurePoll();
  } catch (e) {
    console.error('send failed', e);
    alert('Could not start the research job. Is the server running?');
  } finally {
    els.send.disabled = false;
  }
}

// ── SSE (live updates) with auto-reconnect ───────────────────────────────────

function ensureSSE() {
  if (!threadId || evtSource) return;
  const src = new EventSource(`/research/${threadId}/stream`);
  evtSource = src;

  const onTerminal = () => loadThread(); // re-render from DB (source of truth)
  src.addEventListener('done', onTerminal);
  src.addEventListener('error', evt => {
    // Distinguish a job 'error' message (has data) from a transport drop.
    if (evt.data) {
      onTerminal();
    }
    // EventSource auto-reconnects on transport errors; nothing else to do.
  });
  src.addEventListener('status', () => {
    /* catch-up state; loadThread already reflects it */
  });
}

function resetSSE() {
  if (evtSource) {
    evtSource.close();
    evtSource = null;
  }
}

// ── Poll fallback (belt-and-suspenders while a job runs) ─────────────────────

function ensurePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (researching) loadThread();
    else stopPoll();
  }, 10000);
}
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

els.composer.addEventListener('submit', e => {
  e.preventDefault();
  sendMessage();
});

// Enter to send, Shift+Enter for newline.
els.message.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-grow the textarea.
els.message.addEventListener('input', () => {
  els.message.style.height = 'auto';
  els.message.style.height = Math.min(els.message.scrollHeight, 140) + 'px';
});

els.newChat.addEventListener('click', () => {
  resetSSE();
  stopPoll();
  threadId = null;
  localStorage.removeItem(THREAD_KEY);
  render([], null);
});

// First paint: reconstruct any existing thread (mid-research or completed).
loadThread();

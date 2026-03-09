/**
 * IT Workshop — Real-Time WebSocket Server
 * Deploy on Railway (free tier)
 * Handles: session management, live voting, student count
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;

// ─── SESSION STATE ────────────────────────────────────────────────────────────
let session = {
  code: generateCode(),
  active: false,
  currentSlide: 1,
  revealStep: 0,
  pollActive: false,
  pollQuestion: '',
  pollOptions: [],
  pollResults: { A: 0, B: 0, C: 0, D: 0 },
  studentCount: 0,
  instructorConnected: false,
};

// Track connected clients
const clients = new Map(); // ws -> { role: 'instructor'|'student', id: string }
let studentIdCounter = 0;

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function broadcastToStudents(data) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (info.role === 'student' && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function broadcastToInstructor(data) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (info.role === 'instructor' && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function getStudentCount() {
  let count = 0;
  clients.forEach(info => { if (info.role === 'student') count++; });
  return count;
}

function updateStudentCount() {
  session.studentCount = getStudentCount();
  // Broadcast real count to instructor
  broadcastToInstructor({
    type: 'student_count',
    count: session.studentCount,
  });
  // Also tell all students the count
  broadcastToStudents({
    type: 'student_count',
    count: session.studentCount,
  });
}

// ─── HTTP SERVER (health check for Railway) ───────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      students: getStudentCount(),
      slide: session.currentSlide,
      sessionCode: session.code,
    }));
    return;
  }
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('IT Workshop Server running ✅');
});

// ─── WEBSOCKET SERVER ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  clients.set(ws, { role: 'unknown', id: clientId });

  console.log(`[CONNECT] ${clientId} — total: ${clients.size}`);

  // Send current session state immediately on connect
  ws.send(JSON.stringify({
    type: 'session_state',
    sessionCode: session.code,
    currentSlide: session.currentSlide,
    pollActive: session.pollActive,
    pollQuestion: session.pollQuestion,
    pollOptions: session.pollOptions,
    pollResults: session.pollResults,
    studentCount: getStudentCount(),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const clientInfo = clients.get(ws);

    switch (msg.type) {

      // ── INSTRUCTOR AUTHENTICATES ──────────────────────────────────────────
      case 'instructor_auth': {
        if (msg.pin === '1906') {
          clients.set(ws, { ...clientInfo, role: 'instructor' });
          session.instructorConnected = true;
          session.active = true;
          ws.send(JSON.stringify({
            type: 'auth_success',
            role: 'instructor',
            sessionCode: session.code,
            currentSlide: session.currentSlide,
            studentCount: getStudentCount(),
            pollResults: session.pollResults,
          }));
          console.log(`[AUTH] Instructor authenticated`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail', message: 'Wrong PIN' }));
        }
        break;
      }

      // ── STUDENT JOINS ─────────────────────────────────────────────────────
      case 'student_join': {
        if (msg.code !== session.code) {
          ws.send(JSON.stringify({ type: 'join_fail', message: 'Wrong session code' }));
          return;
        }
        studentIdCounter++;
        const studentNum = studentIdCounter;
        clients.set(ws, { ...clientInfo, role: 'student', num: studentNum });

        ws.send(JSON.stringify({
          type: 'join_success',
          studentNum,
          currentSlide: session.currentSlide,
          slideTitle: session.currentSlideTitle || 'Welcome!',
          pollActive: session.pollActive,
          pollQuestion: session.pollQuestion,
          pollOptions: session.pollOptions,
        }));

        updateStudentCount();
        console.log(`[JOIN] Student #${studentNum} joined — total students: ${getStudentCount()}`);
        break;
      }

      // ── INSTRUCTOR: ADVANCE SLIDE ─────────────────────────────────────────
      case 'slide_change': {
        if (clientInfo.role !== 'instructor') return;
        session.currentSlide = msg.slide;
        session.currentSlideTitle = msg.title || '';
        session.revealStep = 0;
        // Close any active poll when slide changes
        if (session.pollActive && !msg.keepPoll) {
          session.pollActive = false;
        }
        // Broadcast to ALL students
        broadcastToStudents({
          type: 'slide_change',
          slide: session.currentSlide,
          title: session.currentSlideTitle,
          pollActive: session.pollActive,
        });
        console.log(`[SLIDE] → ${session.currentSlide}: ${session.currentSlideTitle}`);
        break;
      }

      // ── INSTRUCTOR: REVEAL STEP ───────────────────────────────────────────
      case 'reveal_step': {
        if (clientInfo.role !== 'instructor') return;
        session.revealStep = msg.step;
        broadcastToStudents({
          type: 'reveal_step',
          step: session.revealStep,
        });
        break;
      }

      // ── INSTRUCTOR: OPEN POLL ─────────────────────────────────────────────
      case 'open_poll': {
        if (clientInfo.role !== 'instructor') return;
        session.pollActive = true;
        session.pollQuestion = msg.question;
        session.pollOptions = msg.options || ['A', 'B', 'C', 'D'];
        session.pollResults = { A: 0, B: 0, C: 0, D: 0 };
        session.pollVoters = new Set(); // track who voted

        broadcastToStudents({
          type: 'poll_open',
          question: session.pollQuestion,
          options: session.pollOptions,
          activityNum: msg.activityNum || '',
        });

        ws.send(JSON.stringify({
          type: 'poll_opened',
          question: session.pollQuestion,
          studentCount: getStudentCount(),
        }));

        console.log(`[POLL OPEN] "${session.pollQuestion}"`);
        break;
      }

      // ── STUDENT: SUBMIT VOTE ──────────────────────────────────────────────
      case 'submit_vote': {
        if (clientInfo.role !== 'student') return;
        if (!session.pollActive) {
          ws.send(JSON.stringify({ type: 'vote_rejected', reason: 'No active poll' }));
          return;
        }
        // Prevent duplicate votes
        if (!session.pollVoters) session.pollVoters = new Set();
        if (session.pollVoters.has(clientInfo.id)) {
          ws.send(JSON.stringify({ type: 'vote_rejected', reason: 'Already voted' }));
          return;
        }

        const choice = msg.choice; // 'A', 'B', 'C', or 'D'
        if (!['A', 'B', 'C', 'D'].includes(choice)) return;

        session.pollVoters.add(clientInfo.id);
        session.pollResults[choice]++;

        // Confirm to voter
        ws.send(JSON.stringify({
          type: 'vote_accepted',
          choice,
          message: '✅ Submitted! Watch results on the projector',
        }));

        // Broadcast live results to instructor + all students (for projector)
        const totalVotes = Object.values(session.pollResults).reduce((a, b) => a + b, 0);
        const update = {
          type: 'poll_update',
          results: session.pollResults,
          totalVotes,
          voterCount: session.pollVoters.size,
          studentCount: getStudentCount(),
        };
        broadcast(update); // everyone sees live bar chart update

        console.log(`[VOTE] Student voted ${choice} — totals: ${JSON.stringify(session.pollResults)}`);
        break;
      }

      // ── STUDENT: SUBMIT TEXT (fill-in-the-blank, word cloud) ─────────────
      case 'submit_text': {
        if (clientInfo.role !== 'student') return;
        broadcastToInstructor({
          type: 'text_submission',
          text: msg.text,
          studentNum: clientInfo.num,
        });
        ws.send(JSON.stringify({ type: 'text_accepted', message: '✅ Submitted!' }));
        console.log(`[TEXT] Student #${clientInfo.num}: "${msg.text}"`);
        break;
      }

      // ── STUDENT: EMOJI REACTION ───────────────────────────────────────────
      case 'emoji_reaction': {
        if (clientInfo.role !== 'student') return;
        broadcastToInstructor({
          type: 'emoji_reaction',
          emoji: msg.emoji,
          studentNum: clientInfo.num,
        });
        // Tally emoji reactions
        if (!session.emojiCounts) session.emojiCounts = { '😀': 0, '😐': 0, '😕': 0 };
        if (session.emojiCounts[msg.emoji] !== undefined) {
          session.emojiCounts[msg.emoji]++;
        }
        broadcast({
          type: 'emoji_update',
          counts: session.emojiCounts,
        });
        ws.send(JSON.stringify({ type: 'reaction_accepted' }));
        break;
      }

      // ── INSTRUCTOR: CLOSE POLL ────────────────────────────────────────────
      case 'close_poll': {
        if (clientInfo.role !== 'instructor') return;
        session.pollActive = false;
        const finalResults = {
          type: 'poll_closed',
          results: session.pollResults,
          totalVotes: Object.values(session.pollResults).reduce((a, b) => a + b, 0),
          correctAnswer: msg.correctAnswer || null,
          explanation: msg.explanation || '',
        };
        broadcast(finalResults);
        console.log(`[POLL CLOSE] Final: ${JSON.stringify(session.pollResults)}`);
        break;
      }

      // ── INSTRUCTOR: NEW SESSION CODE ──────────────────────────────────────
      case 'new_session': {
        if (clientInfo.role !== 'instructor') return;
        session.code = generateCode();
        session.pollActive = false;
        session.pollResults = { A: 0, B: 0, C: 0, D: 0 };
        ws.send(JSON.stringify({
          type: 'new_session',
          sessionCode: session.code,
        }));
        console.log(`[SESSION] New code: ${session.code}`);
        break;
      }

      // ── PING / KEEPALIVE ──────────────────────────────────────────────────
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
      }

    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      console.log(`[DISCONNECT] ${info.role} ${info.id}`);
      if (info.role === 'instructor') {
        session.instructorConnected = false;
      }
    }
    clients.delete(ws);
    updateStudentCount();
  });

  ws.on('error', (err) => {
    console.error(`[WS ERROR] ${err.message}`);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`✅ IT Workshop Server running on port ${PORT}`);
  console.log(`   Session code: ${session.code}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT = 30;
const SB = 10, BB = 20;
const MAX_PLAYERS = 6;

const MIME = {
  ".html": "text/html",
  ".json": "application/json",
  ".js":   "application/javascript",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon"
};

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  let filePath;

  if (url === "/" || url === "/index.html") {
    filePath = path.join(__dirname, "public", "index.html");
  } else if (url === "/manifest.json") {
    filePath = path.join(__dirname, "public", "manifest.json");
  } else if (url === "/sw.js") {
    filePath = path.join(__dirname, "public", "sw.js");
  } else if (url === "/icon-192.png") {
    filePath = path.join(__dirname, "public", "icon-192.png");
  } else if (url === "/icon-512.png") {
    filePath = path.join(__dirname, "public", "icon-512.png");
  } else {
    res.writeHead(404); res.end("Not found"); return;
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const SUITS = ["♠","♥","♦","♣"];
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const RANK_VAL = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};

function makeDeck() {
  const d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({r,s})));
  for (let i = d.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [d[i],d[j]] = [d[j],d[i]];
  }
  return d;
}

function getCombos(arr, k) {
  const res = [];
  function bt(start, cur) {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); bt(i+1,cur); cur.pop(); }
  }
  bt(0, []);
  return res;
}

function evalFive(cards) {
  const vals = cards.map(c => RANK_VAL[c.r]).sort((a,b) => b-a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const seen = {};
  vals.forEach(v => { seen[v] = (seen[v]||0)+1; });
  const counts = [];
  Object.entries(seen).forEach(([v,n]) => counts.push({v:+v,n}));
  counts.sort((a,b) => b.n-a.n || b.v-a.v);
  const u = [...new Set(vals)];
  const straight = u.length >= 5 && (u[0]-u[4]===4 || (u[0]===14&&u[1]===5&&u[2]===4&&u[3]===3&&u[4]===2));
  const sv = () => (vals[0]===14&&vals[1]===5)?[5,4,3,2,1]:vals;
  const c = counts;
  const rn = v => ({14:"Ases",13:"Reyes",12:"Reinas",11:"Jotas",10:"Dieces"}[v]||v+"s");
  if (flush&&straight&&vals[0]===14&&vals[4]===10) return {rank:9,name:"Escalera real",tb:[14]};
  if (flush&&straight) return {rank:8,name:"Escalera de color",tb:sv()};
  if (c[0].n===4) return {rank:7,name:"Poker de "+rn(c[0].v),tb:[c[0].v,c[1].v]};
  if (c[0].n===3&&c[1].n===2) return {rank:6,name:"Full de "+rn(c[0].v)+" con "+rn(c[1].v),tb:[c[0].v,c[1].v]};
  if (flush) return {rank:5,name:"Color",tb:vals};
  if (straight) return {rank:4,name:"Escalera",tb:sv()};
  if (c[0].n===3) return {rank:3,name:"Trío de "+rn(c[0].v),tb:[c[0].v,...c.slice(1).map(x=>x.v)]};
  if (c[0].n===2&&c[1].n===2) return {rank:2,name:"Doble pareja "+rn(c[0].v)+"/"+rn(c[1].v),tb:[c[0].v,c[1].v,c[2].v]};
  if (c[0].n===2) return {rank:1,name:"Pareja de "+rn(c[0].v),tb:[c[0].v,...c.slice(1).map(x=>x.v)]};
  return {rank:0,name:"Carta alta "+rn(vals[0]),tb:vals};
}

function evalBest(cards) {
  let best = null;
  getCombos(cards,5).forEach(combo => {
    const ev = evalFive(combo);
    if (!best||ev.rank>best.rank||(ev.rank===best.rank&&compareTB(ev.tb,best.tb)>0)) best=ev;
  });
  return best;
}

function compareTB(a,b) {
  for (let i=0;i<Math.min(a.length,b.length);i++) { if(a[i]!==b[i]) return a[i]-b[i]; }
  return 0;
}

const rooms = new Map();

function createRoom(id) {
  return {
    id, players: [], state: "waiting",
    deck: [], community: [], pot: 0,
    sidePots: [], street: 0, dealer: 0,
    actionOn: -1, currentBet: 0, minRaise: BB,
    chips: [], bets: [], folded: [], allin: [],
    totalContribs: [],
    host: 0,
    handCount: 0, timer: null, timerLeft: TURN_TIMEOUT,
    readyVotes: new Set()
  };
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p && p.ws && p.ws.readyState===1) p.ws.send(JSON.stringify(msg));
  });
}

function sendState(room) {
  const showAll = room.state==="showdown";
  room.players.forEach((p,i) => {
    if (!p||p.ws.readyState!==1) return;
    const others = room.players.map((op,oi) => oi===i ? null : {
      name: op ? op.name : null,
      chips: room.chips[oi],
      bet: room.bets[oi],
      folded: room.folded[oi],
      allin: room.allin[oi],
      hand: (showAll && !room.folded[oi]) ? op.hand : null,
      handName: showAll ? room.handNames[oi] : null,
      seatIndex: oi
    });
    p.ws.send(JSON.stringify({
      type: "state",
      seatIndex: i,
      myHand: p.hand,
      myHandName: room.handNames ? room.handNames[i] : null,
      others,
      community: room.community.slice(0, room.commVisible||0),
      pot: room.pot,
      sidePots: room.sidePots,
      chips: room.chips[i],
      bet: room.bets[i],
      folded: room.folded[i],
      allin: room.allin[i],
      street: room.street,
      actionOn: room.actionOn,
      currentBet: room.currentBet,
      minRaise: room.minRaise,
      toCall: Math.max(0, room.currentBet - room.bets[i]),
      state: room.state,
      result: room.result||null,
      names: room.players.map(p => p?p.name:null),
      dealer: room.dealer,
      timerLeft: room.timerLeft,
      playerCount: room.players.filter(p=>p).length
    }));
  });
}

function activePlayers(room) {
  return room.players.map((_,i)=>i).filter(i => room.players[i] && !room.folded[i] && !room.allin[i]);
}

function nonFolded(room) {
  return room.players.map((_,i)=>i).filter(i => room.players[i] && !room.folded[i]);
}

function nextActive(room, from) {
  const n = room.players.length;
  for (let step=1; step<n; step++) {
    const idx = (from+step)%n;
    if (room.players[idx] && !room.folded[idx] && !room.allin[idx]) return idx;
  }
  return -1;
}

function clearTimer(room) {
  if (room.timer) { clearInterval(room.timer); room.timer=null; }
}

function startTimer(room) {
  clearTimer(room);
  room.timerLeft = TURN_TIMEOUT;
  room.timer = setInterval(() => {
    room.timerLeft--;
    broadcast(room, {type:"timer", timerLeft: room.timerLeft, actionOn: room.actionOn});
    if (room.timerLeft <= 0) {
      clearTimer(room);
      const idx = room.actionOn;
      if (idx >= 0 && room.players[idx] && !room.folded[idx]) {
        const toCall = Math.max(0, room.currentBet - room.bets[idx]);
        if (toCall === 0) doCheck(room, idx);
        else doFold(room, idx);
      }
    }
  }, 1000);
}

function startHand(room) {
  const n = room.players.filter(p=>p).length;
  if (n < 2) return;
  room.deck = makeDeck();
  room.community = [room.deck.pop(),room.deck.pop(),room.deck.pop(),room.deck.pop(),room.deck.pop()];
  room.commVisible = 0;
  const seats = room.players.length;
  room.chips = room.chips.slice();
  room.bets = new Array(seats).fill(0);
  room.folded = room.players.map(p => !p);
  room.allin = new Array(seats).fill(false);
  room.totalContribs = new Array(seats).fill(0);
  room.sidePots = [];
  room.pot = 0;
  room.street = 0;
  room.state = "playing";
  room.result = null;
  room.handNames = new Array(seats).fill("");
  room.currentBet = 0;
  room.minRaise = BB;
  room.handCount++;
  room.players.forEach((p,i) => { if(p) p.hand = [room.deck.pop(), room.deck.pop()]; });

  const active = nonFolded(room);
  const sbIdx = active[(active.indexOf(room.dealer)+1)%active.length];
  const bbIdx = active[(active.indexOf(room.dealer)+2)%active.length];

  postBlind(room, sbIdx, SB);
  postBlind(room, bbIdx, BB);
  room.currentBet = BB;
  room.minRaise = BB;

  const utg = active[(active.indexOf(room.dealer)+3)%active.length];
  room.actionOn = utg;
  room.lastRaiser = bbIdx;
  room.acted = new Array(room.players.length).fill(false);
  // BB and SB have "acted" by posting blinds, but UTG and beyond haven't
  // Mark SB and BB as not acted so they can re-act if raised
  startTimer(room);
  sendState(room);
}

function postBlind(room, idx, amount) {
  const actual = Math.min(amount, room.chips[idx]);
  room.chips[idx] -= actual;
  room.bets[idx] += actual;
  room.pot += actual;
  room.totalContribs[idx] = (room.totalContribs[idx]||0) + actual;
  if (room.chips[idx]===0) room.allin[idx]=true;
}

function computeSidePots(room) {
  // Use total contributions across all streets
  const allPlayers = room.players.map((_,i)=>i).filter(i => room.players[i]);
  const contribs = allPlayers.map(i => ({
    i,
    contrib: room.totalContribs[i]||0,
    folded: room.folded[i]
  })).sort((a,b) => a.contrib - b.contrib);

  const pots = [];
  let prev = 0;

  contribs.forEach(({contrib, i: idx}, ci) => {
    if (contrib <= prev) return;
    const level = contrib - prev;
    // All players who contributed at least this level
    const eligible = contribs.slice(ci).filter(x => !x.folded).map(x => x.i);
    // Amount = level * number of players who contributed at least this level
    const contributors = contribs.filter(x => x.contrib >= contrib).length;
    // Recalculate: each player contributes min(their_total, contrib) - prev
    let amount = 0;
    contribs.forEach(x => {
      const contribution = Math.min(x.contrib, contrib) - prev;
      if (contribution > 0) amount += contribution;
    });
    if (eligible.length > 0) pots.push({amount, eligible});
    prev = contrib;
  });

  return pots;
}

function doFold(room, idx) {
  room.folded[idx] = true;
  const nf = nonFolded(room);
  if (nf.length === 1) { endHand(room, "fold"); return; }
  advanceTurn(room);
}

function doCheck(room, idx) {
  advanceTurn(room);
}

function doCall(room, idx) {
  const toCall = Math.min(room.currentBet - room.bets[idx], room.chips[idx]);
  room.chips[idx] -= toCall;
  room.bets[idx] += toCall;
  room.pot += toCall;
  room.totalContribs[idx] = (room.totalContribs[idx]||0) + toCall;
  if (room.chips[idx]===0) room.allin[idx]=true;
  // Si todos los que no han foldado están all-in, pasar de calle directamente
  const nf = nonFolded(room);
  const everyoneAllin = nf.every(i => room.allin[i]);
  if (everyoneAllin) { nextStreet(room); return; }
  advanceTurn(room);
}

function doRaise(room, idx, total) {
  const totalBet = Math.min(total, room.bets[idx]+room.chips[idx]);
  const add = totalBet - room.bets[idx];
  if (add <= 0) return;
  room.minRaise = totalBet - room.currentBet;
  room.chips[idx] -= add;
  room.bets[idx] = totalBet;
  room.pot += add;
  room.totalContribs[idx] = (room.totalContribs[idx]||0) + add;
  room.currentBet = totalBet;
  room.lastRaiser = idx;
  if (room.chips[idx]===0) room.allin[idx]=true;
  if (!room.acted) room.acted = new Array(room.players.length).fill(false);
  room.acted = room.acted.map((a, i) => i === idx ? true : false);
  // Si todos están all-in tras el raise, pasar de calle
  const nf = nonFolded(room);
  const everyoneAllin = nf.every(i => room.allin[i]);
  if (everyoneAllin) { nextStreet(room); return; }
  advanceTurn(room);
}

function doAllin(room, idx) {
  doRaise(room, idx, room.bets[idx]+room.chips[idx]);
}

function advanceTurn(room) {
  clearTimer(room);
  const nf = nonFolded(room);
  if (nf.length <= 1) { endHand(room, "fold"); return; }

  // Marcar jugador actual como actuado
  if (!room.acted) room.acted = new Array(room.players.length).fill(false);
  if (room.actionOn >= 0) room.acted[room.actionOn] = true;

  // Jugadores activos = no foldeados, no all-in
  const active = activePlayers(room);

  // Si nadie puede actuar, pasar de calle
  if (active.length === 0) { nextStreet(room); return; }

  // Buscar el siguiente jugador que necesita actuar:
  // - no ha igualado la apuesta actual, O
  // - no ha actuado todavía esta calle
  const n = room.players.length;
  let next = -1;
  for (let step = 1; step < n; step++) {
    const idx = (room.actionOn + step) % n;
    if (!room.players[idx] || room.folded[idx] || room.allin[idx]) continue;
    const needsToCall = room.bets[idx] < room.currentBet;
    const hasntActed = !room.acted[idx];
    if (needsToCall || hasntActed) {
      next = idx;
      break;
    }
  }

  // Si no hay nadie que necesite actuar, fin de calle
  if (next === -1) { nextStreet(room); return; }

  room.actionOn = next;
  startTimer(room);
  sendState(room);
}

function nextStreet(room) {
  clearTimer(room);
  room.bets = new Array(room.players.length).fill(0);
  room.currentBet = 0;
  room.minRaise = BB;
  room.street++;
  room.commVisible = room.street===1?3 : room.street===2?4 : 5;

  if (room.street >= 4) { doShowdown(room); return; }

  const nf = nonFolded(room);
  if (nf.length <= 1) { endHand(room, "fold"); return; }

  const active = activePlayers(room);
  room.lastRaiser = -1;
  room.acted = new Array(room.players.length).fill(false);
  room.actionOn = -1; // nadie tiene turno por defecto

  // Mostrar cartas nuevas
  sendState(room);

  if (active.length === 0) {
    // Todos all-in — pasar calles automáticamente
    setTimeout(() => nextStreet(room), 1400);
  } else {
    // Hay jugadores activos — asignar turno al primero después del dealer
    const firstAct = nf.find(i => !room.allin[i] && i > room.dealer) 
                  || nf.find(i => !room.allin[i]) 
                  || -1;
    if (firstAct === -1) {
      setTimeout(() => nextStreet(room), 1400);
    } else {
      room.actionOn = firstAct;
      startTimer(room);
      sendState(room);
    }
  }
}

function doShowdown(room) {
  clearTimer(room);
  room.state = "showdown";
  room.commVisible = 5;
  const comm = room.community.slice(0,5);
  const nf = nonFolded(room);
  room.handNames = room.players.map((p,i) => {
    if (!p||room.folded[i]) return "";
    return evalBest([...p.hand,...comm]).name;
  });

  const pots = computeSidePots(room);
  if (pots.length === 0) pots.push({amount: room.pot, eligible: nf});

  const winners = {};
  pots.forEach(pot => {
    let best = null, bestIdx = -1;
    pot.eligible.filter(i=>!room.folded[i]).forEach(i => {
      const ev = evalBest([...room.players[i].hand,...comm]);
      if (!best||ev.rank>best.rank||(ev.rank===best.rank&&compareTB(ev.tb,best.tb)>0)) {
        best=ev; bestIdx=i;
      }
    });
    const tied = pot.eligible.filter(i=>!room.folded[i]).filter(i => {
      const ev = evalBest([...room.players[i].hand,...comm]);
      return ev.rank===best.rank && compareTB(ev.tb,best.tb)===0;
    });
    const share = Math.floor(pot.amount/tied.length);
    tied.forEach(i => { winners[i]=(winners[i]||0)+share; room.chips[i]+=share; });
  });

  room.result = { winners, handNames: room.handNames, pots };
  room.pot = 0;
  sendState(room);
}

function endHand(room, reason) {
  clearTimer(room);
  const nf = nonFolded(room);
  if (nf.length === 1) {
    const w = nf[0];
    room.chips[w] += room.pot;
    room.handNames = room.players.map(()=>"");
    room.result = { winners: {[w]: room.pot}, handNames: room.handNames, pots: [], reason: "fold" };
    room.pot = 0;
    room.state = "showdown";
    room.commVisible = room.commVisible || 0;
    sendState(room);
  } else {
    doShowdown(room);
  }
}

function handleAction(room, playerIdx, action, amount) {
  if (room.state !== "playing") return;
  if (room.actionOn !== playerIdx) return;
  if (room.folded[playerIdx] || room.allin[playerIdx]) return;

  clearTimer(room);
  const toCall = Math.max(0, room.currentBet - room.bets[playerIdx]);

  if (action==="fold") { doFold(room, playerIdx); }
  else if (action==="check" && toCall===0) { doCheck(room, playerIdx); }
  else if (action==="call") { doCall(room, playerIdx); }
  else if (action==="raise") { doRaise(room, playerIdx, amount); }
  else if (action==="allin") { doAllin(room, playerIdx); }
}

wss.on("connection", ws => {
  let currentRoom = null;
  let seatIndex = -1;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      const roomId = (msg.room||"default").trim().toLowerCase();
      let room = rooms.get(roomId);
      if (!room) { room = createRoom(roomId); rooms.set(roomId, room); }

      const taken = room.players.filter(p=>p).length;
      if (taken >= MAX_PLAYERS) {
        ws.send(JSON.stringify({type:"error",msg:"Sala llena (máx 6)"})); return;
      }

      let seat = room.players.findIndex(p=>!p);
      if (seat===-1) seat = room.players.length;
      if (!room.chips[seat]) room.chips[seat] = 1000;
      room.players[seat] = { ws, name: msg.name||("Jugador "+(seat+1)), hand:[] };
      seatIndex = seat;
      currentRoom = room;

      ws.send(JSON.stringify({type:"joined", seatIndex, roomId, chips: room.chips[seat]}));
      const count = room.players.filter(p=>p).length;
      const isHost = seatIndex === room.host;
      broadcast(room, {type:"playerJoined", names: room.players.map(p=>p?p.name:null), count, newName: room.players[seat].name, chips: room.chips});

      // First player becomes host
      if (count === 1) room.host = seat;

      // If game already in progress, send current state to new player
      if (room.state === "playing" || room.state === "showdown") {
        sendState(room);
        return;
      }

      // If countdown already running, just broadcast updated names
      if (room.state === "starting") {
        broadcast(room, {type:"starting", countdown:3});
        return;
      }

      // In waiting state, tell host they can start
      if (room.state === "waiting") {
        broadcast(room, {type:"lobby", names: room.players.map(p=>p?p.name:null), count, chips: room.chips, host: room.host});
      }
      return;
    }

    if (msg.type === "startgame" && currentRoom) {
      if (seatIndex !== currentRoom.host) return;
      if (currentRoom.state !== "waiting") return;
      const count = currentRoom.players.filter(p=>p).length;
      if (count < 2) {
        currentRoom.players[seatIndex].ws.send(JSON.stringify({type:"error",msg:"Se necesitan al menos 2 jugadores"}));
        return;
      }
      currentRoom.state = "starting";
      broadcast(currentRoom, {type:"starting", countdown:5});
      let c = 5;
      const iv = setInterval(() => {
        c--;
        broadcast(currentRoom, {type:"countdown", c});
        if (c <= 0) { clearInterval(iv); currentRoom.dealer=0; startHand(currentRoom); }
      }, 1000);
      return;
    }

    if (msg.type==="action" && currentRoom) {
      handleAction(currentRoom, seatIndex, msg.action, msg.amount);
      return;
    }

    if (msg.type==="newhand" && currentRoom) {
      if (currentRoom.state!=="showdown") return;
      // If this player is broke, they can't vote for new hand
      if (currentRoom.chips[seatIndex] <= 0) return;
      currentRoom.readyVotes.add(seatIndex);
      // Only count votes from players who still have chips
      const activePlayers = currentRoom.players.filter((p,i) => p && currentRoom.chips[i] > 0);
      const needed = activePlayers.length;
      broadcast(currentRoom, {type:"readyVote", votes: currentRoom.readyVotes.size, needed});
      if (currentRoom.readyVotes.size >= needed) {
        currentRoom.readyVotes = new Set();
        // Remove broke players
        currentRoom.players.forEach((p,i) => {
          if (p && currentRoom.chips[i] <= 0) {
            p.ws.send(JSON.stringify({type:"gameover", msg:"Te has quedado sin fichas. ¡Game Over!"}));
            currentRoom.players[i] = null;
          }
        });
        const remaining = currentRoom.players.filter(p=>p).length;
        if (remaining < 2) {
          // Only one player left - they win the whole game
          const winnerIdx = currentRoom.players.findIndex(p=>p);
          if (winnerIdx >= 0) {
            broadcast(currentRoom, {type:"gamewon", name: currentRoom.players[winnerIdx].name});
          }
          currentRoom.state = "waiting";
          return;
        }
        currentRoom.dealer = (currentRoom.dealer+1) % currentRoom.players.length;
        while (!currentRoom.players[currentRoom.dealer]) {
          currentRoom.dealer = (currentRoom.dealer+1)%currentRoom.players.length;
        }
        currentRoom.state = "waiting";
        startHand(currentRoom);
      }
      return;
    }

    if (msg.type==="chat" && currentRoom) {
      const sender = currentRoom.players[seatIndex];
      if (!sender) return;
      const text = (msg.text||"").slice(0,120).trim();
      if (!text) return;
      broadcast(currentRoom, {type:"chat", seat:seatIndex, name:sender.name, text});
      return;
    }

    if (msg.type==="sitout" && currentRoom) {
      const leavingName = currentRoom.players[seatIndex] ? currentRoom.players[seatIndex].name : null;
      currentRoom.players[seatIndex] = null;
      broadcast(currentRoom, {type:"playerLeft", seatIndex, names: currentRoom.players.map(p=>p?p.name:null), leftName: leavingName});
      return;
    }

    // Video frame relay — broadcast JPEG frame to all other players
    if (msg.type==="video-frame" && currentRoom) {
      const out = JSON.stringify({type:"video-frame", from: seatIndex, frame: msg.frame});
      currentRoom.players.forEach((p, i) => {
        if (i !== seatIndex && p && p.ws.readyState===1) p.ws.send(out);
      });
      return;
    }

    // Audio chunk relay — broadcast to all other players
    if (msg.type==="audio-chunk" && currentRoom) {
      const out = JSON.stringify({type:"audio-chunk", from: seatIndex, chunk: msg.chunk, sr: msg.sr});
      currentRoom.players.forEach((p, i) => {
        if (i !== seatIndex && p && p.ws.readyState===1) p.ws.send(out);
      });
      return;
    }

    // Camera joined/left broadcast
    if (msg.type==="rtc-joined" && currentRoom) {
      const name = currentRoom.players[seatIndex] ? currentRoom.players[seatIndex].name : "?";
      currentRoom.players.forEach((p, i) => {
        if (i !== seatIndex && p && p.ws.readyState===1)
          p.ws.send(JSON.stringify({type:"rtc-peer-joined", from: seatIndex, name}));
      });
      return;
    }

    if (msg.type==="rtc-left" && currentRoom) {
      currentRoom.players.forEach((p, i) => {
        if (i !== seatIndex && p && p.ws.readyState===1)
          p.ws.send(JSON.stringify({type:"rtc-peer-left", from: seatIndex}));
      });
      return;
    }
  });

  ws.on("close", () => {
    if (currentRoom && seatIndex>=0) {
      const leavingName = currentRoom.players[seatIndex] ? currentRoom.players[seatIndex].name : null;
      currentRoom.players[seatIndex] = null;
      broadcast(currentRoom, {type:"playerLeft", seatIndex, names: currentRoom.players.map(p=>p?p.name:null), leftName: leavingName});
      if (currentRoom.state==="playing" && currentRoom.actionOn===seatIndex) {
        doFold(currentRoom, seatIndex);
      }
    }
  });
});

server.listen(PORT, () => console.log("Poker 6max en puerto " + PORT));

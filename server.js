const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT = 30;
const SB = 10, BB = 20;
const MAX_PLAYERS = 6;

const server = http.createServer((req, res) => {
  const file = path.join(__dirname, "public", "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
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
  if (flush&&straight&&vals[0]===14&&vals[4]===10) return {rank:9,name:"Escalera real",tb:[14]};
  if (flush&&straight) return {rank:8,name:"Escalera de color",tb:sv()};
  if (c[0].n===4) return {rank:7,name:"Poker de "+c[0].v,tb:[c[0].v,c[1].v]};
  if (c[0].n===3&&c[1].n===2) return {rank:6,name:"Full",tb:[c[0].v,c[1].v]};
  if (flush) return {rank:5,name:"Color",tb:vals};
  if (straight) return {rank:4,name:"Escalera",tb:sv()};
  if (c[0].n===3) return {rank:3,name:"Trio",tb:[c[0].v,...c.slice(1).map(x=>x.v)]};
  if (c[0].n===2&&c[1].n===2) return {rank:2,name:"Doble pareja",tb:[c[0].v,c[1].v,c[2].v]};
  if (c[0].n===2) return {rank:1,name:"Pareja de "+c[0].v,tb:[c[0].v,...c.slice(1).map(x=>x.v)]};
  return {rank:0,name:"Carta alta",tb:vals};
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
  startTimer(room);
  sendState(room);
}

function postBlind(room, idx, amount) {
  const actual = Math.min(amount, room.chips[idx]);
  room.chips[idx] -= actual;
  room.bets[idx] += actual;
  room.pot += actual;
  if (room.chips[idx]===0) room.allin[idx]=true;
}

function computeSidePots(room) {
  const involved = room.players.map((_,i)=>i).filter(i => room.players[i] && !room.folded[i]);
  const contribs = involved.map(i => ({i, bet: room.bets[i]})).sort((a,b)=>a.bet-b.bet);
  const pots = [];
  let prev = 0;
  contribs.forEach(({bet},ci) => {
    if (bet <= prev) return;
    const level = bet - prev;
    const eligible = contribs.slice(ci).map(x=>x.i);
    const amount = level * involved.length;
    pots.push({amount, eligible});
    prev = bet;
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
  if (room.chips[idx]===0) room.allin[idx]=true;
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
  room.currentBet = totalBet;
  room.lastRaiser = idx;
  if (room.chips[idx]===0) room.allin[idx]=true;
  advanceTurn(room);
}

function doAllin(room, idx) {
  doRaise(room, idx, room.bets[idx]+room.chips[idx]);
}

function advanceTurn(room) {
  clearTimer(room);
  const nf = nonFolded(room);
  if (nf.length <= 1) { endHand(room, "fold"); return; }

  // Players who can still act: not folded, not all-in, and still need to call or haven't acted
  const active = activePlayers(room);

  // If nobody can act (all all-in or folded), run out the board
  if (active.length === 0) { nextStreet(room); return; }

  // Find next player after current who still needs to act
  // A player needs to act if their bet < currentBet OR they haven't acted yet this street
  // We track this by finding the next active player in order
  const n = room.players.length;
  let next = -1;
  for (let step = 1; step < n; step++) {
    const idx = (room.actionOn + step) % n;
    if (!room.players[idx] || room.folded[idx] || room.allin[idx]) continue;
    // This player can act
    next = idx;
    break;
  }

  // If we've gone all the way around to the last raiser (or no one left), end street
  if (next === -1 || next === room.lastRaiser) {
    // But first check if everyone has matched the current bet
    const allCalled = active.every(i => room.bets[i] >= room.currentBet);
    if (allCalled) { nextStreet(room); return; }
    // Someone still needs to call
    const needsCall = active.find(i => room.bets[i] < room.currentBet);
    if (needsCall === undefined) { nextStreet(room); return; }
    room.actionOn = needsCall;
    startTimer(room);
    sendState(room);
    return;
  }

  // Check if next player has already matched and we've completed the round
  if (next === room.lastRaiser) { nextStreet(room); return; }

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

  // Show the new community cards first
  sendState(room);

  if (active.length === 0) {
    // Everyone all-in, run out remaining streets with delay
    setTimeout(() => nextStreet(room), 1400);
  } else {
    // First active player after dealer acts first
    const firstAct = nf.find(i => i > room.dealer) || nf[0];
    room.actionOn = firstAct;
    startTimer(room);
    sendState(room);
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
      broadcast(room, {type:"playerJoined", names: room.players.map(p=>p?p.name:null), count});

      // If game already in progress, send current state to new player
      if (room.state === "playing" || room.state === "showdown") {
        sendState(room);
        return;
      }

      // If game starting countdown already running, just broadcast updated names
      if (room.state === "starting") {
        broadcast(room, {type:"starting", countdown:3});
        return;
      }

      // Start countdown when 2+ players join
      if (count >= 2 && room.state === "waiting") {
        setTimeout(() => {
          if (room.players.filter(p=>p).length >= 2 && room.state === "waiting") {
            room.state = "starting";
            broadcast(room, {type:"starting", countdown:5});
            let c = 5;
            const iv = setInterval(() => {
              c--;
              broadcast(room, {type:"countdown", c});
              if (c <= 0) { clearInterval(iv); room.dealer=0; startHand(room); }
            }, 1000);
          }
        }, 2000);
      }
      return;
    }

    if (msg.type==="action" && currentRoom) {
      handleAction(currentRoom, seatIndex, msg.action, msg.amount);
      return;
    }

    if (msg.type==="newhand" && currentRoom) {
      if (currentRoom.state!=="showdown") return;
      currentRoom.readyVotes.add(seatIndex);
      const needed = currentRoom.players.filter(p=>p).length;
      broadcast(currentRoom, {type:"readyVote", votes: currentRoom.readyVotes.size, needed});
      if (currentRoom.readyVotes.size >= needed) {
        currentRoom.readyVotes = new Set();
        currentRoom.players.forEach((p,i)=>{ if(p && currentRoom.chips[i]<=0) currentRoom.chips[i]=1000; });
        currentRoom.dealer = (currentRoom.dealer+1) % currentRoom.players.length;
        while (!currentRoom.players[currentRoom.dealer]) {
          currentRoom.dealer = (currentRoom.dealer+1)%currentRoom.players.length;
        }
        currentRoom.state = "waiting";
        startHand(currentRoom);
      }
      return;
    }

    if (msg.type==="sitout" && currentRoom) {
      currentRoom.players[seatIndex] = null;
      broadcast(currentRoom, {type:"playerLeft", seatIndex, names: currentRoom.players.map(p=>p?p.name:null)});
      return;
    }
  });

  ws.on("close", () => {
    if (currentRoom && seatIndex>=0) {
      currentRoom.players[seatIndex] = null;
      broadcast(currentRoom, {type:"playerLeft", seatIndex, names: currentRoom.players.map(p=>p?p.name:null)});
      if (currentRoom.state==="playing" && currentRoom.actionOn===seatIndex) {
        doFold(currentRoom, seatIndex);
      }
    }
  });
});

server.listen(PORT, () => console.log("Poker 6max en puerto " + PORT));



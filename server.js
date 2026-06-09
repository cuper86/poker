const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const file = path.join(__dirname, "public", "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const RANK_VAL = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const SB = 10, BB = 20;

function makeDeck() {
  const d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({ r, s })));
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getCombos(arr, k) {
  const res = [];
  function bt(start, cur) {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); bt(i+1, cur); cur.pop(); }
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
  const isStraight = () => {
    const u = [...new Set(vals)];
    if (u.length < 5) return false;
    if (u[0]-u[4] === 4) return true;
    if (u[0]===14&&u[1]===5&&u[2]===4&&u[3]===3&&u[4]===2) return true;
    return false;
  };
  const straight = isStraight();
  const sv = () => (vals[0]===14&&vals[1]===5) ? [5,4,3,2,1] : vals;
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
  getCombos(cards, 5).forEach(combo => {
    const ev = evalFive(combo);
    if (!best || ev.rank > best.rank || (ev.rank===best.rank && compareTB(ev.tb,best.tb)>0)) best = ev;
  });
  return best;
}

function compareTB(a,b) {
  for (let i = 0; i < Math.min(a.length,b.length); i++) { if(a[i]!==b[i]) return a[i]-b[i]; }
  return 0;
}

const rooms = new Map();

function createRoom(id) {
  return {
    id, players: [], state: "waiting",
    deck: [], community: [], pot: 0,
    street: 0, dealer: 0, bets: [0,0],
    toCall: 0, minRaise: BB, actionOn: -1,
    chips: [1000,1000], handCount: 0,
    acted: [false,false]
  };
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  });
}

function sendState(room) {
  room.players.forEach((p, i) => {
    if (p.ws.readyState !== 1) return;
    const opp = 1 - i;
    const commVisible = room.street===0?0 : room.street===1?3 : room.street===2?4 : 5;
    p.ws.send(JSON.stringify({
      type: "state",
      myIndex: i,
      myHand: room.players[i].hand,
      oppHandHidden: room.state==="showdown" ? room.players[opp].hand : null,
      community: room.community.slice(0, commVisible),
      pot: room.pot,
      chips: room.chips,
      bets: room.bets,
      street: room.street,
      actionOn: room.actionOn,
      toCall: room.toCall,
      minRaise: room.minRaise,
      state: room.state,
      result: room.result || null,
      names: room.players.map(p => p.name)
    }));
  });
}

function startHand(room) {
  room.deck = makeDeck();
  room.community = [room.deck.pop(),room.deck.pop(),room.deck.pop(),room.deck.pop(),room.deck.pop()];
  room.players.forEach(p => { p.hand = [room.deck.pop(), room.deck.pop()]; });
  room.pot = 0;
  room.bets = [0,0];
  room.street = 0;
  room.state = "playing";
  room.result = null;
  room.handCount++;
  room.acted = [false,false];
  const dealer = room.dealer;
  const other = 1 - dealer;
  const sb = Math.min(SB, room.chips[dealer]);
  const bb = Math.min(BB, room.chips[other]);
  room.chips[dealer] -= sb;
  room.chips[other] -= bb;
  room.bets[dealer] = sb;
  room.bets[other] = bb;
  room.pot = sb + bb;
  room.toCall = bb - sb;
  room.minRaise = BB;
  room.actionOn = dealer;
  sendState(room);
}

function nextStreet(room) {
  room.street++;
  room.bets = [0,0];
  room.toCall = 0;
  room.minRaise = BB;
  room.acted = [false,false];
  if (room.street >= 4) { doShowdown(room); return; }
  room.actionOn = 1 - room.dealer;
  sendState(room);
}

function doShowdown(room) {
  room.state = "showdown";
  const comm = room.community.slice(0, 5);
  const h0 = evalBest([...room.players[0].hand, ...comm]);
  const h1 = evalBest([...room.players[1].hand, ...comm]);
  let winner = -1;
  if (h0.rank > h1.rank) winner = 0;
  else if (h1.rank > h0.rank) winner = 1;
  else {
    const c = compareTB(h0.tb, h1.tb);
    if (c > 0) winner = 0;
    else if (c < 0) winner = 1;
  }
  if (winner >= 0) {
    room.chips[winner] += room.pot;
    room.result = { winner, reason: "showdown", hands: [h0.name, h1.name], pot: room.pot };
  } else {
    const half = Math.floor(room.pot / 2);
    room.chips[0] += half;
    room.chips[1] += room.pot - half;
    room.result = { winner: -1, reason: "tie", hands: [h0.name, h1.name], pot: room.pot };
  }
  room.pot = 0;
  sendState(room);
}

function foldHand(room, folderIdx) {
  const winner = 1 - folderIdx;
  room.chips[winner] += room.pot;
  room.pot = 0;
  room.state = "showdown";
  room.result = { winner, reason: "fold", hands: ["",""], pot: 0 };
  sendState(room);
}

function handleAction(room, playerIdx, action, amount) {
  if (room.actionOn !== playerIdx) return;
  if (!room.acted) room.acted = [false,false];
  const other = 1 - playerIdx;

  if (action === "fold") { foldHand(room, playerIdx); return; }

  if (action === "check") {
    if (room.toCall > 0) return;
    room.acted[playerIdx] = true;
    if (room.acted[other]) {
      nextStreet(room);
    } else {
      room.actionOn = other;
      sendState(room);
    }
    return;
  }

  if (action === "call") {
    const amt = Math.min(room.toCall, room.chips[playerIdx]);
    room.chips[playerIdx] -= amt;
    room.bets[playerIdx] += amt;
    room.pot += amt;
    room.toCall = 0;
    room.acted[playerIdx] = true;
    if (room.acted[other]) {
      nextStreet(room);
    } else {
      room.actionOn = other;
      sendState(room);
    }
    return;
  }

  if (action === "raise" || action === "allin") {
    const targetBet = action === "allin"
      ? room.bets[playerIdx] + room.chips[playerIdx]
      : Math.min(amount, room.bets[playerIdx] + room.chips[playerIdx]);
    const add = targetBet - room.bets[playerIdx];
    if (add <= 0) return;
    room.chips[playerIdx] -= add;
    room.pot += add;
    room.minRaise = add;
    room.bets[playerIdx] = targetBet;
    room.toCall = targetBet - room.bets[other];
    room.acted[playerIdx] = true;
    room.acted[other] = false;
    room.actionOn = other;
    sendState(room);
    return;
  }
}

wss.on("connection", ws => {
  let currentRoom = null;
  let playerIdx = -1;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      const roomId = msg.room || "default";
      let room = rooms.get(roomId);
      if (!room) { room = createRoom(roomId); rooms.set(roomId, room); }
      if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: "error", msg: "Sala llena" }));
        return;
      }
      playerIdx = room.players.length;
      room.players.push({ ws, name: msg.name || ("Jugador "+(playerIdx+1)), hand: [] });
      currentRoom = room;
      ws.send(JSON.stringify({ type: "joined", index: playerIdx, roomId }));
      if (room.players.length === 2) {
        broadcast(room, { type: "ready", names: room.players.map(p => p.name) });
        setTimeout(() => startHand(room), 800);
      } else {
        ws.send(JSON.stringify({ type: "waiting" }));
      }
      return;
    }

    if (msg.type === "action" && currentRoom) {
      handleAction(currentRoom, playerIdx, msg.action, msg.amount);
      return;
    }

    if (msg.type === "newhand" && currentRoom) {
      if (currentRoom.state !== "showdown") return;
      if (!currentRoom._readyVotes) currentRoom._readyVotes = new Set();
      currentRoom._readyVotes.add(playerIdx);
      if (currentRoom._readyVotes.size === 2) {
        currentRoom._readyVotes = new Set();
        if (currentRoom.chips[0] <= 0 || currentRoom.chips[1] <= 0) {
          currentRoom.chips = [1000, 1000];
        }
        currentRoom.dealer = 1 - currentRoom.dealer;
        startHand(currentRoom);
      } else {
        broadcast(currentRoom, { type: "waitingNext", waiting: playerIdx });
      }
      return;
    }
  });

  ws.on("close", () => {
    if (currentRoom) {
      broadcast(currentRoom, { type: "disconnected", playerIdx });
      currentRoom.state = "waiting";
      currentRoom.players = currentRoom.players.filter(p => p.ws !== ws);
    }
  });
});

server.listen(PORT, () => console.log("Poker server en puerto " + PORT));

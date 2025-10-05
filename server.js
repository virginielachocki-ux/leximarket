// server.js - Serveur LexiMarket complet
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

let connectedUsers = new Map();
let matchmakingQueue = [];
let activeRooms = new Map();
let userDatabase = new Map();
let privateRooms = new Map();
let gameHistory = [];

const DATA_DIR = './data';
const VOCAB_FILE = `${DATA_DIR}/vocabulary.json`;
const DICT_FILE = `${DATA_DIR}/dictionary.json`;
const HISTORY_FILE = `${DATA_DIR}/history.json`;
const USERS_FILE = `${DATA_DIR}/users.json`;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

const commonEnglishWords = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on', 'with',
  'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her',
  'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up',
  'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time',
  'market', 'marketing', 'business', 'product', 'price', 'sell', 'buy', 'customer', 'brand'
]);

let frenchDictionary = new Set([
  'le', 'de', 'un', 'être', 'et', 'à', 'il', 'avoir', 'ne', 'je', 'son', 'que', 'se', 'qui', 'ce',
  'dans', 'en', 'du', 'elle', 'au', 'pour', 'pas', 'vous', 'par', 'sur', 'faire', 'plus',
  'dire', 'me', 'on', 'mon', 'lui', 'nous', 'comme', 'mais', 'pouvoir', 'avec', 'tout', 'y', 'aller',
  'voir', 'bien', 'où', 'sans', 'tu', 'ou', 'leur', 'homme', 'si', 'deux', 'moi', 'autre',
  'logo', 'nom', 'entreprise', 'identité', 'coût', 'euros', 'argent', 'tarif', 'acheteur', 
  'consommateur', 'personne', 'magasin', 'commerce', 'transaction', 'échanger', 'vendeur',
  'objet', 'marchandise', 'bien', 'article', 'diviser', 'groupes', 'cibler', 'catégories',
  'image', 'perception', 'concurrence', 'vitrine', 'disposition', 'présentation', 'garder',
  'clients', 'fidèles', 'réseau', 'enseigne', 'contrat', 'canaux', 'intégration', 'cohérence',
  'cerveau', 'neurones', 'psychologie', 'publicité', 'internet', 'recibler', 'complémentaire',
  'supplémentaire', 'addition', 'histoire', 'récit', 'narration', 'stratégie', 'communication',
  'développement', 'croissance', 'innovation', 'qualité', 'service', 'valeur', 'budget',
  'objectif', 'projet', 'plan', 'analyser', 'étudier', 'observer', 'mesurer', 'évaluer',
  'relation', 'segment'
]);

let marketingVocabulary = {
  easy: [
    { word: "MARQUE", definition: "Nom commercial d'un produit", botClues: ["logo", "nom", "entreprise", "identité"], forbiddenWords: [] },
    { word: "PRIX", definition: "Valeur monétaire", botClues: ["coût", "euros", "argent", "tarif"], forbiddenWords: [] },
    { word: "CLIENT", definition: "Personne qui achète", botClues: ["acheteur", "consommateur", "personne", "magasin"], forbiddenWords: [] },
    { word: "VENTE", definition: "Action de vendre", botClues: ["commerce", "transaction", "échanger", "vendeur"], forbiddenWords: [] },
    { word: "PRODUIT", definition: "Bien ou service", botClues: ["objet", "marchandise", "bien", "article"], forbiddenWords: [] }
  ],
  medium: [
    { word: "SEGMENTATION", definition: "Division du marché", botClues: ["diviser", "groupes", "cibler", "catégories"], forbiddenWords: ["segment"] },
    { word: "POSITIONNEMENT", definition: "Place du produit", botClues: ["image", "perception", "concurrence", "stratégie"], forbiddenWords: [] },
    { word: "MERCHANDISING", definition: "Présentation des produits", botClues: ["vitrine", "disposition", "présentation", "magasin"], forbiddenWords: [] },
    { word: "FIDELISATION", definition: "Fidéliser la clientèle", botClues: ["garder", "clients", "fidèles", "relation"], forbiddenWords: [] },
    { word: "FRANCHISE", definition: "Contrat de distribution", botClues: ["réseau", "enseigne", "contrat", "commerce"], forbiddenWords: [] }
  ],
  hard: [
    { word: "OMNICANALITE", definition: "Stratégie multicanale", botClues: ["canaux", "intégration", "cohérence", "stratégie"], forbiddenWords: [] },
    { word: "NEUROMARKETING", definition: "Neurosciences et marketing", botClues: ["cerveau", "neurones", "psychologie", "étudier"], forbiddenWords: [] },
    { word: "RETARGETING", definition: "Reciblage publicitaire", botClues: ["publicité", "internet", "recibler", "stratégie"], forbiddenWords: [] },
    { word: "STORYTELLING", definition: "Technique narrative", botClues: ["histoire", "récit", "narration", "communication"], forbiddenWords: [] }
  ]
};

function loadData() {
  try {
    if (fs.existsSync(VOCAB_FILE)) marketingVocabulary = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
    if (fs.existsSync(DICT_FILE)) frenchDictionary = new Set(JSON.parse(fs.readFileSync(DICT_FILE, 'utf8')).words);
    if (fs.existsSync(HISTORY_FILE)) gameHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (fs.existsSync(USERS_FILE)) userDatabase = new Map(Object.entries(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))));
    console.log('Données chargées');
  } catch (err) {
    console.error('Erreur chargement:', err);
  }
}

function saveData() {
  try {
    fs.writeFileSync(VOCAB_FILE, JSON.stringify(marketingVocabulary, null, 2));
    fs.writeFileSync(DICT_FILE, JSON.stringify({ words: Array.from(frenchDictionary) }, null, 2));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(gameHistory, null, 2));
    fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(userDatabase), null, 2));
  } catch (err) {
    console.error('Erreur sauvegarde:', err);
  }
}

loadData();

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function getRandomWord(difficulty = null) {
  let targetDifficulty = difficulty || ['easy', 'medium', 'hard'][Math.floor(Math.random() * 3)];
  const words = marketingVocabulary[targetDifficulty];
  if (!words || words.length === 0) return null;
  return { ...words[Math.floor(Math.random() * words.length)], difficulty: targetDifficulty };
}

function validateClue(clue, targetWord, room) {
  const cleanClue = clue.toLowerCase().trim();
  const cleanTarget = targetWord.toLowerCase();
  
  if (cleanClue.length < 2) return { valid: false, reason: "Au moins 2 caractères" };
  if (cleanClue.includes(' ')) return { valid: false, reason: "Un seul mot" };
  if (cleanClue === cleanTarget) return { valid: false, reason: "Pas le mot à deviner" };
  if (cleanClue.length >= 3 && cleanTarget.length >= 3 && cleanClue.substring(0, 3) === cleanTarget.substring(0, 3)) {
    return { valid: false, reason: "Pas les 3 mêmes premières lettres" };
  }
  if (cleanTarget.includes(cleanClue) || cleanClue.includes(cleanTarget)) return { valid: false, reason: "Trop proche" };
  if (commonEnglishWords.has(cleanClue)) return { valid: false, reason: "Anglais interdit" };
  if (!frenchDictionary.has(cleanClue)) return { valid: false, reason: "Pas dans le dictionnaire" };
  if (room?.currentWord?.forbiddenWords?.length > 0 && room.currentWord.forbiddenWords.map(w => w.toLowerCase()).includes(cleanClue)) {
    return { valid: false, reason: "Mot interdit" };
  }
  return { valid: true };
}

function calculateScore(timeUsed, cluesUsed, difficulty) {
  const baseScore = 100;
  const timeBonus = Math.max(0, 60 - timeUsed) * 2;
  const clueBonus = (4 - cluesUsed) * 25;
  const diffMultiplier = { easy: 1, medium: 1.5, hard: 2 };
  const diffBonus = Math.round(baseScore * (diffMultiplier[difficulty] - 1));
  return Math.round(baseScore + timeBonus + clueBonus + diffBonus);
}

function saveGameToHistory(gameData) {
  gameHistory.push({ ...gameData, timestamp: new Date().toISOString() });
  saveData();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/vocabulary', (req, res) => res.json(marketingVocabulary));
app.post('/api/vocabulary/add', (req, res) => {
  const { word, definition, difficulty, botClues, forbiddenWords } = req.body;
  if (!word || !definition || !difficulty) return res.json({ success: false, message: 'Données manquantes' });
  marketingVocabulary[difficulty].push({ word: word.toUpperCase(), definition, botClues: botClues || [], forbiddenWords: forbiddenWords || [] });
  saveData();
  res.json({ success: true });
});
app.post('/api/vocabulary/delete', (req, res) => {
  const { difficulty, index } = req.body;
  if (!marketingVocabulary[difficulty] || index < 0) return res.json({ success: false });
  marketingVocabulary[difficulty].splice(index, 1);
  saveData();
  res.json({ success: true });
});
app.post('/api/vocabulary/import', (req, res) => {
  const data = req.body;
  if (data.easy && data.medium && data.hard) {
    Object.assign(marketingVocabulary, data);
    saveData();
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});
app.get('/api/dictionary', (req, res) => res.json({ words: Array.from(frenchDictionary).sort(), count: frenchDictionary.size }));
app.post('/api/dictionary/add', (req, res) => {
  const { words } = req.body;
  if (words && Array.isArray(words)) {
    words.forEach(w => frenchDictionary.add(w.toLowerCase().trim()));
    saveData();
    res.json({ success: true, count: frenchDictionary.size });
  } else {
    res.json({ success: false });
  }
});
app.post('/api/dictionary/import', (req, res) => {
  const { words } = req.body;
  if (words && Array.isArray(words)) {
    words.forEach(w => frenchDictionary.add(w.toLowerCase().trim()));
    saveData();
    res.json({ success: true, count: frenchDictionary.size });
  } else {
    res.json({ success: false });
  }
});
app.get('/api/history', (req, res) => res.json({ history: gameHistory, count: gameHistory.length }));
app.get('/api/history/:pseudo', (req, res) => {
  const playerHistory = gameHistory.filter(g => g.players && g.players.includes(req.params.pseudo));
  res.json({ history: playerHistory, count: playerHistory.length });
});

io.on('connection', (socket) => {
  console.log('Connexion:', socket.id);
  
  socket.on('user_login', (data) => {
    if (!userDatabase.has(data.pseudo)) {
      userDatabase.set(data.pseudo, { pseudo: data.pseudo, password: data.password, totalScore: 0, gamesPlayed: 0, wordsGuessed: 0 });
      saveData();
    }
    connectedUsers.set(socket.id, { socketId: socket.id, pseudo: data.pseudo });
    socket.emit('login_success', { userData: userDatabase.get(data.pseudo), connectedUsers: connectedUsers.size });
  });
  
  socket.on('join_matchmaking', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    matchmakingQueue.push(user);
    socket.emit('matchmaking_joined', { queuePosition: matchmakingQueue.length });
    io.emit('queue_update', { playersInQueue: matchmakingQueue.length });
    setTimeout(() => {
      if (matchmakingQueue.length >= 2) {
        const p1 = matchmakingQueue.shift();
        const p2 = matchmakingQueue.shift();
        const code = generateRoomCode();
        createMultiplayerRoom(code, [p1, p2], 'matchmaking');
        io.to(p1.socketId).emit('match_found', { roomCode: code, opponent: p2.pseudo });
        io.to(p2.socketId).emit('match_found', { roomCode: code, opponent: p1.pseudo });
      }
    }, 1000);
  });
  
  socket.on('leave_matchmaking', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      matchmakingQueue = matchmakingQueue.filter(p => p.socketId !== socket.id);
      socket.emit('matchmaking_left');
    }
  });
  
  socket.on('create_private_room', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const code = generateRoomCode();
    privateRooms.set(code, { host: user, players: [user], status: 'waiting', createdAt: Date.now() });
    socket.emit('private_room_created', { roomCode: code });
  });
  
  socket.on('join_private_room', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const room = privateRooms.get(data.roomCode);
    if (!room) return socket.emit('room_error', { message: 'Room introuvable' });
    if (room.players.length >= 2) return socket.emit('room_error', { message: 'Room complète' });
    room.players.push(user);
    if (room.players.length === 2) {
      createMultiplayerRoom(data.roomCode, room.players, 'private');
      io.to(room.players[0].socketId).emit('match_found', { roomCode: data.roomCode, opponent: room.players[1].pseudo });
      io.to(room.players[1].socketId).emit('match_found', { roomCode: data.roomCode, opponent: room.players[0].pseudo });
      privateRooms.delete(data.roomCode);
    } else {
      socket.emit('waiting_for_opponent', { roomCode: data.roomCode });
    }
  });
  
  socket.on('start_training', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const code = 'BOT_' + generateRoomCode();
    const diff = data.difficulty || 'easy';
    activeRooms.set(code, {
      type: 'training', player: user, gameState: 'playing', difficulty: diff,
      currentWord: getRandomWord(diff), botClueIndex: 0, clues: [], turnsLeft: 4, timeLeft: 60,
      scores: { [user.pseudo]: 0, 'Bot': 0 }, wordsPlayed: 1, maxWords: data.maxWords || 10, startTime: Date.now()
    });
    socket.join(code);
    socket.emit('training_start', { roomCode: code, word: activeRooms.get(code).currentWord, difficulty: diff, maxWords: data.maxWords || 10, yourRole: 'guesser' });
    setTimeout(() => giveBotClue(code), 2000);
    activeRooms.get(code).timer = setInterval(() => {
      const r = activeRooms.get(code);
      if (!r) return;
      r.timeLeft--;
      io.to(code).emit('timer_update', r.timeLeft);
      if (r.timeLeft <= 0) {
        clearInterval(r.timer);
        endTrainingRound(code, false, "Temps écoulé");
      }
    }, 1000);
  });
  
  socket.on('join_room', (code) => {
    const room = activeRooms.get(code);
    if (!room || room.type === 'training') return;
    socket.join(code);
    if (room.gameState === 'starting') {
      room.gameState = 'playing';
      room.currentWord = getRandomWord();
      room.startTime = Date.now();
      room.players.forEach((p, i) => {
        const isGiver = (i + 1) !== room.currentGuesser;
        io.to(p.socketId).emit('game_start', {
          word: room.currentWord, players: room.players.map(p => p.pseudo),
          yourRole: isGiver ? 'giver' : 'guesser', roundNumber: 1, maxWords: 4,
          scores: room.scores, clues: [], turnsLeft: 4, timeLeft: 60
        });
      });
      room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(code).emit('timer_update', room.timeLeft);
        if (room.timeLeft <= 0) {
          clearInterval(room.timer);
          endRound(code, false, "Temps écoulé");
        }
      }, 1000);
    }
  });
  
  socket.on('give_clue', (data) => {
    const room = activeRooms.get(data.roomCode);
    if (!room || room.type === 'training') return;
    const val = validateClue(data.clue, room.currentWord.word, room);
    if (!val.valid) return socket.emit('clue_error', val.reason);
    room.clues.push(data.clue);
    room.turnsLeft--;
    io.to(data.roomCode).emit('clue_given', { clue: data.clue, turnsLeft: room.turnsLeft, clues: room.clues });
    if (room.turnsLeft <= 0) endRound(data.roomCode, false, "Plus d'indices");
  });
  
  socket.on('make_guess', (data) => {
    const room = activeRooms.get(data.roomCode);
    if (!room) return;
    if (data.guess.trim().includes(' ')) return socket.emit('guess_error', 'Un seul mot');
    if (data.guess.toLowerCase().trim() === room.currentWord.word.toLowerCase()) {
      io.to(data.roomCode).emit('guess_correct', { guess: data.guess });
      room.type === 'training' ? endTrainingRound(data.roomCode, true, "Trouvé !") : endRound(data.roomCode, true, "Trouvé !");
    } else {
      io.to(data.roomCode).emit('guess_wrong_broadcast', { guess: data.guess });
      socket.emit('guess_wrong');
      
      // CORRECTION: Seulement en mode training, pas en matchmaking
      if (room.type === 'training' && activeRooms.has(data.roomCode)) {
        setTimeout(() => {
          const r = activeRooms.get(data.roomCode);
          if (r && r.type === 'training') giveBotClue(data.roomCode);
        }, 2000);
      }
    }
  });
  
  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    matchmakingQueue = matchmakingQueue.filter(p => p.socketId !== socket.id);
  });
});

function createMultiplayerRoom(code, players, type) {
  activeRooms.set(code, {
    type, players, gameState: 'starting', clues: [], turnsLeft: 4, timeLeft: 60, currentGuesser: 1,
    scores: { [players[0].pseudo]: 0, [players[1].pseudo]: 0 }, wordsPlayed: 1, maxWords: 4
  });
}

function giveBotClue(code) {
  const room = activeRooms.get(code);
  if (!room || room.type !== 'training') return;
  if (room.botClueIndex >= room.currentWord.botClues.length) return endTrainingRound(code, false, "Plus d'indices");
  const clue = room.currentWord.botClues[room.botClueIndex];
  room.botClueIndex++;
  room.clues.push(clue);
  room.turnsLeft--;
  io.to(code).emit('clue_given', { clue, turnsLeft: room.turnsLeft, clues: room.clues, fromBot: true });
}

function endTrainingRound(code, success, message) {
  const room = activeRooms.get(code);
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  const timeUsed = Math.round((Date.now() - room.startTime) / 1000);
  let points = 0;
  if (success) {
    points = calculateScore(timeUsed, room.clues.length, room.currentWord.difficulty);
    room.scores[room.player.pseudo] += points;
    const user = userDatabase.get(room.player.pseudo);
    if (user) {
      user.totalScore += points;
      user.wordsGuessed++;
      saveData();
    }
  }
  const isLast = room.wordsPlayed >= room.maxWords;
  io.to(code).emit('round_end', {
    success, message, word: room.currentWord.word, definition: room.currentWord.definition,
    timeUsed, cluesUsed: room.clues.length, pointsEarned: points, scores: room.scores,
    wordsPlayed: room.wordsPlayed, maxWords: room.maxWords, isLastWord: isLast
  });
  if (isLast) {
    saveGameToHistory({ type: 'training', player: room.player.pseudo, difficulty: room.difficulty, finalScore: room.scores[room.player.pseudo], wordsGuessed: room.wordsPlayed });
    setTimeout(() => {
      io.to(code).emit('game_ended', { finalScores: room.scores });
      activeRooms.delete(code);
    }, 5000);
  } else {
    setTimeout(() => {
      if (activeRooms.has(code)) {
        room.wordsPlayed++;
        room.currentWord = getRandomWord(room.difficulty);
        room.botClueIndex = 0;
        room.clues = [];
        room.turnsLeft = 4;
        room.timeLeft = 60;
        room.startTime = Date.now();
        io.to(code).emit('next_round', { word: room.currentWord, roundNumber: room.wordsPlayed, maxWords: room.maxWords, scores: room.scores });
        setTimeout(() => giveBotClue(code), 2000);
        room.timer = setInterval(() => {
          room.timeLeft--;
          io.to(code).emit('timer_update', room.timeLeft);
          if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            endTrainingRound(code, false, "Temps écoulé");
          }
        }, 1000);
      }
    }, 5000);
  }
}

function endRound(code, success, message) {
  const room = activeRooms.get(code);
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  const timeUsed = Math.round((Date.now() - room.startTime) / 1000);
  let points = 0;
  if (success) {
    points = calculateScore(timeUsed, room.clues.length, room.currentWord.difficulty);
    room.players.forEach(p => {
      room.scores[p.pseudo] += points;
      const user = userDatabase.get(p.pseudo);
      if (user) {
        user.totalScore += points;
        user.wordsGuessed++;
      }
    });
    saveData();
  }
  const isLast = room.wordsPlayed >= room.maxWords;
  io.to(code).emit('round_end', {
    success, message, word: room.currentWord.word, definition: room.currentWord.definition,
    timeUsed, cluesUsed: room.clues.length, pointsEarned: points, scores: room.scores,
    wordsPlayed: room.wordsPlayed, maxWords: room.maxWords, isLastWord: isLast
  });
  if (isLast) {
    saveGameToHistory({ type: room.type || 'multiplayer', players: room.players.map(p => p.pseudo), finalScores: room.scores, wordsPlayed: room.wordsPlayed });
    setTimeout(() => {
      io.to(code).emit('game_ended', { finalScores: room.scores });
      activeRooms.delete(code);
    }, 5000);
  } else {
    setTimeout(() => {
      if (activeRooms.has(code)) {
        room.wordsPlayed++;
        room.currentWord = getRandomWord();
        room.clues = [];
        room.turnsLeft = 4;
        room.timeLeft = 60;
        room.currentGuesser = room.currentGuesser === 1 ? 2 : 1;
        room.startTime = Date.now();
        room.players.forEach((p, i) => {
          const isGiver = (i + 1) !== room.currentGuesser;
          io.to(p.socketId).emit('next_round', {
            word: room.currentWord, yourRole: isGiver ? 'giver' : 'guesser', roundNumber: room.wordsPlayed,
            maxWords: room.maxWords, players: room.players.map(p => p.pseudo), scores: room.scores,
            clues: [], turnsLeft: 4, timeLeft: 60
          });
        });
        room.timer = setInterval(() => {
          room.timeLeft--;
          io.to(code).emit('timer_update', room.timeLeft);
          if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            endRound(code, false, "Temps écoulé");
          }
        }, 1000);
      }
    }, 5000);
  }
}

server.listen(PORT, () => {
  console.log(`🎯 LexiMarket sur le port ${PORT}`);
  console.log(`📚 ${marketingVocabulary.easy.length + marketingVocabulary.medium.length + marketingVocabulary.hard.length} mots`);
  console.log(`📖 ${frenchDictionary.size} mots autorisés`);
  console.log(`📊 ${gameHistory.length} parties`);
});
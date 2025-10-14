// server.js - LexiMarket avec PostgreSQL
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Créer les tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        pseudo VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100),
        password_hash VARCHAR(255) NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        total_score INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        words_guessed INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_history (
        id SERIAL PRIMARY KEY,
        game_type VARCHAR(20) NOT NULL,
        players TEXT[],
        final_scores JSONB,
        difficulty VARCHAR(20),
        words_played INTEGER,
        duration INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const adminExists = await pool.query('SELECT id FROM users WHERE pseudo = $1', ['admin']);
    if (adminExists.rows.length === 0) {
      const adminPassword = await bcrypt.hash('L@vyat1981', 10);
      await pool.query(
        'INSERT INTO users (pseudo, password_hash, is_admin) VALUES ($1, $2, $3)',
        ['admin', adminPassword, true]
      );
      console.log('✅ Compte admin créé (admin/L@vyat1981)');
    }

    console.log('✅ Base de données initialisée');
  } catch (err) {
    console.error('❌ Erreur init DB:', err);
  }
}

initDatabase();

let connectedUsers = new Map();
let matchmakingQueue = [];
let activeRooms = new Map();
let privateRooms = new Map();

const DATA_DIR = './data';
const VOCAB_FILE = `${DATA_DIR}/vocabulary.json`;
const DICT_FILE = `${DATA_DIR}/dictionary.json`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const commonEnglishWords = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on', 'with',
  'market', 'marketing', 'business', 'product', 'price', 'sell', 'buy', 'customer', 'brand'
]);

let frenchDictionary = new Set();
let marketingVocabulary = { level1: [], level2: [], level3: [], level4: [], level5: [], level6: [] };

function loadData() {
  try {
    if (fs.existsSync(VOCAB_FILE)) marketingVocabulary = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
    if (fs.existsSync(DICT_FILE)) frenchDictionary = new Set(JSON.parse(fs.readFileSync(DICT_FILE, 'utf8')).words);
    console.log('✅ Données chargées');
  } catch (err) {
    console.error('❌ Erreur chargement:', err);
  }
}

function saveVocabularyAndDictionary() {
  try {
    fs.writeFileSync(VOCAB_FILE, JSON.stringify(marketingVocabulary, null, 2));
    fs.writeFileSync(DICT_FILE, JSON.stringify({ words: Array.from(frenchDictionary) }, null, 2));
  } catch (err) {
    console.error('❌ Erreur sauvegarde:', err);
  }
}

loadData();

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function getRandomWord(difficulty = null) {
let targetDifficulty = difficulty || ['level1', 'level2', 'level3', 'level4', 'level5', 'level6'][Math.floor(Math.random() * 6)];
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

async function saveGameToHistory(gameData) {
  try {
    await pool.query(
      'INSERT INTO game_history (game_type, players, final_scores, difficulty, words_played, duration) VALUES ($1, $2, $3, $4, $5, $6)',
      [gameData.type, gameData.players || [], JSON.stringify(gameData.finalScores || {}), gameData.difficulty || null, gameData.wordsGuessed || gameData.wordsPlayed, gameData.duration || 0]
    );
  } catch (err) {
    console.error('Erreur sauvegarde historique:', err);
  }
}

// Routes API
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Page temporaire pour se promouvoir admin
app.get('/setup-admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Setup Admin</title>
      <style>
        body { font-family: Arial; max-width: 500px; margin: 50px auto; padding: 20px; }
        input, button { width: 100%; padding: 10px; margin: 10px 0; font-size: 16px; }
        button { background: #667eea; color: white; border: none; cursor: pointer; }
        .message { padding: 10px; margin: 10px 0; border-radius: 5px; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
      </style>
    </head>
    <body>
      <h1>🔧 Configuration Admin</h1>
      <p>Connectez-vous avec le compte admin par défaut pour promouvoir votre compte :</p>
      
      <input type="text" id="adminPseudo" placeholder="Admin pseudo" value="admin">
      <input type="password" id="adminPassword" placeholder="Admin password" value="L@vyat1981">
      <input type="text" id="targetPseudo" placeholder="Pseudo à promouvoir admin">
      <button onclick="promoteAdmin()">Promouvoir en Admin</button>
      
      <div id="result"></div>
      
      <script>
        async function promoteAdmin() {
          const adminPseudo = document.getElementById('adminPseudo').value;
          const adminPassword = document.getElementById('adminPassword').value;
          const targetPseudo = document.getElementById('targetPseudo').value;
          
          const result = document.getElementById('result');
          
          if (!targetPseudo) {
            result.innerHTML = '<div class="message error">Entrez le pseudo à promouvoir</div>';
            return;
          }
          
          try {
            const response = await fetch('/api/setup-admin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ adminPseudo, adminPassword, targetPseudo })
            });
            
            const data = await response.json();
            
            if (data.success) {
              result.innerHTML = '<div class="message success">✅ ' + data.message + '</div>';
            } else {
              result.innerHTML = '<div class="message error">❌ ' + data.message + '</div>';
            }
          } catch (err) {
            result.innerHTML = '<div class="message error">Erreur serveur</div>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/api/setup-admin', async (req, res) => {
  try {
    const { adminPseudo, adminPassword, targetPseudo } = req.body;
    
    // Vérifier que l'utilisateur admin existe et le mot de passe est correct
    const adminResult = await pool.query('SELECT * FROM users WHERE pseudo = $1', [adminPseudo]);
    if (adminResult.rows.length === 0) {
      return res.json({ success: false, message: 'Compte admin introuvable' });
    }
    
    const admin = adminResult.rows[0];
    const validPassword = await bcrypt.compare(adminPassword, admin.password_hash);
    if (!validPassword) {
      return res.json({ success: false, message: 'Mot de passe admin incorrect' });
    }
    
    if (!admin.is_admin) {
      return res.json({ success: false, message: 'Ce compte n\'est pas admin' });
    }
    
    // Promouvoir le compte cible
    const updateResult = await pool.query(
      'UPDATE users SET is_admin = true WHERE pseudo = $1 RETURNING *',
      [targetPseudo]
    );
    
    if (updateResult.rows.length === 0) {
      return res.json({ success: false, message: 'Utilisateur cible introuvable' });
    }
    
    res.json({ success: true, message: `${targetPseudo} est maintenant administrateur !` });
  } catch (err) {
    console.error('Erreur setup admin:', err);
    res.json({ success: false, message: 'Erreur serveur' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { pseudo, password, email } = req.body;
    if (!pseudo || !password) return res.json({ success: false, message: 'Pseudo et mot de passe requis' });
    if (password.length < 6) return res.json({ success: false, message: 'Mot de passe trop court (min 6)' });
    
    const existing = await pool.query('SELECT id FROM users WHERE pseudo = $1', [pseudo]);
    if (existing.rows.length > 0) return res.json({ success: false, message: 'Ce pseudo existe déjà' });
    
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (pseudo, email, password_hash) VALUES ($1, $2, $3)',
      [pseudo, email || null, passwordHash]
    );
    
    res.json({ success: true, message: 'Compte créé avec succès' });
  } catch (err) {
    console.error('Erreur inscription:', err);
    res.json({ success: false, message: 'Erreur serveur' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { pseudo, password } = req.body;
    if (!pseudo || !password) return res.json({ success: false, message: 'Identifiants manquants' });
    
    const result = await pool.query('SELECT * FROM users WHERE pseudo = $1', [pseudo]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Identifiants incorrects' });
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.json({ success: false, message: 'Identifiants incorrects' });
    
    res.json({
      success: true,
      user: {
        pseudo: user.pseudo,
        email: user.email,
        isAdmin: user.is_admin,
        totalScore: user.total_score,
        gamesPlayed: user.games_played,
        wordsGuessed: user.words_guessed
      }
    });
  } catch (err) {
    console.error('Erreur connexion:', err);
    res.json({ success: false, message: 'Erreur serveur' });
  }
});

app.post('/api/auth/check-admin', async (req, res) => {
  try {
    const { pseudo } = req.body;
    const result = await pool.query('SELECT is_admin FROM users WHERE pseudo = $1', [pseudo]);
    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.json({ isAdmin: false });
    }
    res.json({ isAdmin: true });
  } catch (err) {
    res.json({ isAdmin: false });
  }
});

app.get('/api/vocabulary', (req, res) => res.json(marketingVocabulary));

app.post('/api/vocabulary/add', async (req, res) => {
  const { word, definition, difficulty, botClues, forbiddenWords, adminPseudo } = req.body;
  
  const userResult = await pool.query('SELECT is_admin FROM users WHERE pseudo = $1', [adminPseudo]);
  if (!userResult.rows[0]?.is_admin) return res.json({ success: false, message: 'Accès refusé' });
  
  if (!word || !definition || !difficulty) return res.json({ success: false, message: 'Données manquantes' });
  marketingVocabulary[difficulty].push({ word: word.toUpperCase(), definition, botClues: botClues || [], forbiddenWords: forbiddenWords || [] });
  saveVocabularyAndDictionary();
  res.json({ success: true });
});

app.post('/api/vocabulary/delete', async (req, res) => {
  const { difficulty, index, adminPseudo } = req.body;
  
  const userResult = await pool.query('SELECT is_admin FROM users WHERE pseudo = $1', [adminPseudo]);
  if (!userResult.rows[0]?.is_admin) return res.json({ success: false, message: 'Accès refusé' });
  
  if (!marketingVocabulary[difficulty] || index < 0) return res.json({ success: false });
  marketingVocabulary[difficulty].splice(index, 1);
  saveVocabularyAndDictionary();
  res.json({ success: true });
});

app.post('/api/vocabulary/import', async (req, res) => {
  const { data: importData, adminPseudo } = req.body;
  
  const userResult = await pool.query('SELECT is_admin FROM users WHERE pseudo = $1', [adminPseudo]);
  if (!userResult.rows[0]?.is_admin) return res.json({ success: false, message: 'Accès refusé' });
  
  if (importData.easy && importData.medium && importData.hard) {
    Object.assign(marketingVocabulary, importData);
    saveVocabularyAndDictionary();
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/api/dictionary', (req, res) => res.json({ words: Array.from(frenchDictionary).sort(), count: frenchDictionary.size }));

app.post('/api/dictionary/add', async (req, res) => {
  const { words, adminPseudo } = req.body;
  
  const userResult = await pool.query('SELECT is_admin FROM users WHERE pseudo = $1', [adminPseudo]);
  if (!userResult.rows[0]?.is_admin) return res.json({ success: false, message: 'Accès refusé' });
  
  if (words && Array.isArray(words)) {
    words.forEach(w => frenchDictionary.add(w.toLowerCase().trim()));
    saveVocabularyAndDictionary();
    res.json({ success: true, count: frenchDictionary.size });
  } else {
    res.json({ success: false });
  }
});

app.post('/api/dictionary/import', async (req, res) => {
  const { words, adminPseudo } = req.body;
  
  const userResult = await pool.query('SELECT is_admin FROM users WHERE pseudo = $1', [adminPseudo]);
  if (!userResult.rows[0]?.is_admin) return res.json({ success: false, message: 'Accès refusé' });
  
  if (words && Array.isArray(words)) {
    words.forEach(w => frenchDictionary.add(w.toLowerCase().trim()));
    saveVocabularyAndDictionary();
    res.json({ success: true, count: frenchDictionary.size });
  } else {
    res.json({ success: false });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM game_history ORDER BY created_at DESC LIMIT 100');
    res.json({ history: result.rows, count: result.rows.length });
  } catch (err) {
    res.json({ history: [], count: 0 });
  }
});

app.get('/api/history/:pseudo', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM game_history WHERE $1 = ANY(players) ORDER BY created_at DESC', [req.params.pseudo]);
    res.json({ history: result.rows, count: result.rows.length });
  } catch (err) {
    res.json({ history: [], count: 0 });
  }
});

// WebSocket - Code de jeu identique à avant
io.on('connection', (socket) => {
  console.log('Connexion:', socket.id);
  
  socket.on('user_login', async (data) => {
    const result = await pool.query('SELECT * FROM users WHERE pseudo = $1', [data.pseudo]);
    if (result.rows.length === 0) return socket.emit('login_error', { message: 'Utilisateur introuvable' });
    
    const user = result.rows[0];
    connectedUsers.set(socket.id, { socketId: socket.id, pseudo: user.pseudo });
    socket.emit('login_success', {
      userData: {
        pseudo: user.pseudo,
        email: user.email,
        isAdmin: user.is_admin,
        totalScore: user.total_score,
        gamesPlayed: user.games_played,
        wordsGuessed: user.words_guessed
      },
      connectedUsers: connectedUsers.size
    });
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

async function endTrainingRound(code, success, message) {
  const room = activeRooms.get(code);
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  const timeUsed = Math.round((Date.now() - room.startTime) / 1000);
  let points = 0;
  if (success) {
    points = calculateScore(timeUsed, room.clues.length, room.currentWord.difficulty);
    room.scores[room.player.pseudo] += points;
    await pool.query('UPDATE users SET total_score = total_score + $1, words_guessed = words_guessed + 1 WHERE pseudo = $2', [points, room.player.pseudo]);
  }
  const isLast = room.wordsPlayed >= room.maxWords;
  io.to(code).emit('round_end', {
    success, message, word: room.currentWord.word, definition: room.currentWord.definition,
    timeUsed, cluesUsed: room.clues.length, pointsEarned: points, scores: room.scores,
    wordsPlayed: room.wordsPlayed, maxWords: room.maxWords, isLastWord: isLast
  });
  if (isLast) {
    await saveGameToHistory({ type: 'training', player: room.player.pseudo, difficulty: room.difficulty, finalScore: room.scores[room.player.pseudo], wordsGuessed: room.wordsPlayed });
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

async function endRound(code, success, message) {
  const room = activeRooms.get(code);
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  const timeUsed = Math.round((Date.now() - room.startTime) / 1000);
  let points = 0;
  if (success) {
    points = calculateScore(timeUsed, room.clues.length, room.currentWord.difficulty);
    for (const p of room.players) {
      room.scores[p.pseudo] += points;
      await pool.query('UPDATE users SET total_score = total_score + $1, words_guessed = words_guessed + 1 WHERE pseudo = $2', [points, p.pseudo]);
    }
  }
  const isLast = room.wordsPlayed >= room.maxWords;
  io.to(code).emit('round_end', {
    success, message, word: room.currentWord.word, definition: room.currentWord.definition,
    timeUsed, cluesUsed: room.clues.length, pointsEarned: points, scores: room.scores,
    wordsPlayed: room.wordsPlayed, maxWords: room.maxWords, isLastWord: isLast
  });
  if (isLast) {
    await saveGameToHistory({ type: room.type || 'multiplayer', players: room.players.map(p => p.pseudo), finalScores: room.scores, wordsPlayed: room.wordsPlayed });
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
});




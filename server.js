// server.js - Serveur Node.js avec WebSockets pour LexiMarket
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Variables globales du serveur
let connectedUsers = new Map(); // socketId -> userInfo
let matchmakingQueue = []; // Liste des joueurs en attente
let activeRooms = new Map(); // roomId -> roomData
let userDatabase = new Map(); // pseudo -> userData

// Données de jeu
const marketingVocabulary = {
  easy: [
    { 
      word: "MARQUE", 
      definition: "Nom commercial d'un produit ou service",
      botClues: ["logo", "nom", "entreprise", "identité"]
    },
    { 
      word: "PRIX", 
      definition: "Valeur monétaire demandée pour un bien",
      botClues: ["coût", "euros", "argent", "tarif"]
    },
    { 
      word: "CLIENT", 
      definition: "Personne qui achète un produit ou service",
      botClues: ["acheteur", "consommateur", "personne", "magasin"]
    },
    { 
      word: "VENTE", 
      definition: "Action de céder un bien contre paiement",
      botClues: ["commerce", "transaction", "échanger", "vendeur"]
    },
    { 
      word: "PRODUIT", 
      definition: "Bien ou service proposé sur le marché",
      botClues: ["objet", "marchandise", "bien", "article"]
    }
  ],
  medium: [
    { 
      word: "SEGMENTATION", 
      definition: "Division du marché en groupes homogènes",
      botClues: ["diviser", "groupes", "cibler", "catégories"]
    },
    { 
      word: "POSITIONNEMENT", 
      definition: "Place du produit dans l'esprit du consommateur",
      botClues: ["image", "perception", "concurrence", "différenciation"]
    },
    { 
      word: "MERCHANDISING", 
      definition: "Techniques de présentation des produits en magasin",
      botClues: ["vitrine", "disposition", "présentation", "rayon"]
    },
    { 
      word: "FIDELISATION", 
      definition: "Stratégies pour fidéliser la clientèle",
      botClues: ["garder", "clients", "fidèles", "programme"]
    },
    { 
      word: "FRANCHISE", 
      definition: "Contrat de distribution sous une enseigne",
      botClues: ["réseau", "enseigne", "contrat", "licence"]
    }
  ],
  hard: [
    { 
      word: "OMNICANALITE", 
      definition: "Stratégie multicanale intégrée et cohérente",
      botClues: ["canaux", "intégration", "cohérence", "multicanal"]
    },
    { 
      word: "NEUROMARKETING", 
      definition: "Application des neurosciences au marketing",
      botClues: ["cerveau", "neurones", "psychologie", "comportement"]
    },
    { 
      word: "RETARGETING", 
      definition: "Reciblage publicitaire des visiteurs web",
      botClues: ["publicité", "internet", "recibler", "visiteurs"]
    },
    { 
      word: "CROSSELLING", 
      definition: "Vente de produits complémentaires",
      botClues: ["complémentaire", "supplémentaire", "addition", "combinaison"]
    },
    { 
      word: "STORYTELLING", 
      definition: "Technique narrative en communication marketing",
      botClues: ["histoire", "récit", "narration", "émotions"]
    }
  ]
};

// Fonctions utilitaires
function generateRoomCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

function getRandomWord() {
  const difficulties = ['easy', 'medium', 'hard'];
  const difficulty = difficulties[Math.floor(Math.random() * difficulties.length)];
  const words = marketingVocabulary[difficulty];
  const randomWord = words[Math.floor(Math.random() * words.length)];
  return { ...randomWord, difficulty };
}

function findMatchForPlayer(player) {
  // Chercher un autre joueur dans la queue
  const opponent = matchmakingQueue.find(p => p.socketId !== player.socketId);
  if (opponent) {
    // Retirer les deux joueurs de la queue
    matchmakingQueue = matchmakingQueue.filter(p => 
      p.socketId !== player.socketId && p.socketId !== opponent.socketId
    );
    
    // Créer une nouvelle room
    const roomCode = generateRoomCode();
    const roomData = {
      id: roomCode,
      players: [player, opponent],
      gameState: 'starting',
      currentWord: null,
      clues: [],
      turnsLeft: 4,
      timeLeft: 60,
      currentGuesser: 1,
      scores: { [player.pseudo]: 0, [opponent.pseudo]: 0 },
      createdAt: Date.now()
    };
    
    activeRooms.set(roomCode, roomData);
    
    // Notifier les deux joueurs
    io.to(player.socketId).emit('match_found', {
      roomCode,
      opponent: opponent.pseudo,
      playerNumber: 1
    });
    
    io.to(opponent.socketId).emit('match_found', {
      roomCode,
      opponent: player.pseudo,
      playerNumber: 2
    });
    
    console.log(`Match créé: ${player.pseudo} vs ${opponent.pseudo} - Room: ${roomCode}`);
    return true;
  }
  return false;
}

// Routes API
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/stats', (req, res) => {
  res.json({
    connectedUsers: connectedUsers.size,
    playersInQueue: matchmakingQueue.length,
    activeRooms: activeRooms.size,
    totalUsers: userDatabase.size
  });
});

// Gestion des connexions WebSocket
io.on('connection', (socket) => {
  console.log(`Nouvel utilisateur connecté: ${socket.id}`);
  
  // Connexion utilisateur
  socket.on('user_login', (userData) => {
    console.log(`Connexion de ${userData.pseudo}`);
    
    // Stocker les infos utilisateur
    if (!userDatabase.has(userData.pseudo)) {
      userDatabase.set(userData.pseudo, {
        pseudo: userData.pseudo,
        password: userData.password,
        email: userData.email || '',
        totalScore: 0,
        gamesPlayed: 0,
        wordsGuessed: 0,
        createdAt: Date.now(),
        lastLogin: Date.now()
      });
    } else {
      const user = userDatabase.get(userData.pseudo);
      user.lastLogin = Date.now();
    }
    
    connectedUsers.set(socket.id, {
      socketId: socket.id,
      pseudo: userData.pseudo,
      status: 'lobby'
    });
    
    socket.emit('login_success', {
      userData: userDatabase.get(userData.pseudo),
      connectedUsers: connectedUsers.size
    });
    
    // Envoyer le leaderboard
    const leaderboard = Array.from(userDatabase.values())
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 10);
    
    socket.emit('leaderboard_update', leaderboard);
  });
  
  // Rejoindre la queue de matchmaking
  socket.on('join_matchmaking', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    
    console.log(`${user.pseudo} rejoint le matchmaking`);
    
    // Vérifier s'il n'est pas déjà dans la queue
    if (!matchmakingQueue.find(p => p.socketId === socket.id)) {
      matchmakingQueue.push(user);
      user.status = 'matchmaking';
      
      socket.emit('matchmaking_joined', {
        queuePosition: matchmakingQueue.length,
        estimatedWait: matchmakingQueue.length * 10 // estimation en secondes
      });
      
      // Essayer de trouver un match immédiatement
      setTimeout(() => {
        if (matchmakingQueue.find(p => p.socketId === socket.id)) {
          findMatchForPlayer(user);
        }
      }, 1000);
    }
    
    // Broadcast du nombre de joueurs en queue
    io.emit('queue_update', {
      playersInQueue: matchmakingQueue.length
    });
  });
  
  // Quitter la queue de matchmaking
  socket.on('leave_matchmaking', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    
    matchmakingQueue = matchmakingQueue.filter(p => p.socketId !== socket.id);
    user.status = 'lobby';
    
    socket.emit('matchmaking_left');
    
    io.emit('queue_update', {
      playersInQueue: matchmakingQueue.length
    });
  });
  
  // Rejoindre une room de jeu
  socket.on('join_room', (roomCode) => {
    const room = activeRooms.get(roomCode);
    if (!room) {
      socket.emit('room_error', 'Room introuvable');
      return;
    }
    
    socket.join(roomCode);
    
    // Démarrer la partie si c'est la première connexion
    if (room.gameState === 'starting') {
      room.gameState = 'playing';
      room.currentWord = getRandomWord();
      room.startTime = Date.now();
      
      io.to(roomCode).emit('game_start', {
        word: room.currentWord,
        players: room.players.map(p => p.pseudo),
        currentGuesser: room.currentGuesser
      });
      
      // Démarrer le timer
      room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timer_update', room.timeLeft);
        
        if (room.timeLeft <= 0) {
          clearInterval(room.timer);
          endRound(roomCode, false, "⏰ Temps écoulé !");
        }
      }, 1000);
    }
    
    socket.emit('room_joined', {
      roomCode,
      gameState: room.gameState,
      currentWord: room.gameState === 'playing' ? room.currentWord : null,
      players: room.players.map(p => p.pseudo),
      scores: room.scores,
      clues: room.clues,
      turnsLeft: room.turnsLeft,
      timeLeft: room.timeLeft,
      currentGuesser: room.currentGuesser
    });
  });
  
  // Donner un indice
  socket.on('give_clue', (data) => {
    const { roomCode, clue } = data;
    const room = activeRooms.get(roomCode);
    const user = connectedUsers.get(socket.id);
    
    if (!room || !user || room.gameState !== 'playing') return;
    
    // Valider l'indice
    const cleanClue = clue.toLowerCase().trim();
    const cleanTarget = room.currentWord.word.toLowerCase();
    
    if (cleanClue.length < 2 || 
        cleanClue.includes(' ') || 
        cleanClue === cleanTarget ||
        cleanTarget.includes(cleanClue) ||
        room.clues.includes(clue)) {
      socket.emit('clue_error', 'Indice invalide');
      return;
    }
    
    room.clues.push(clue);
    room.turnsLeft--;
    
    io.to(roomCode).emit('clue_given', {
      clue,
      giver: user.pseudo,
      turnsLeft: room.turnsLeft,
      clues: room.clues
    });
    
    if (room.turnsLeft <= 0) {
      endRound(roomCode, false, "❌ Plus d'indices disponibles !");
    }
  });
  
  // Faire une tentative
  socket.on('make_guess', (data) => {
    const { roomCode, guess } = data;
    const room = activeRooms.get(roomCode);
    const user = connectedUsers.get(socket.id);
    
    if (!room || !user || room.gameState !== 'playing') return;
    
    const cleanGuess = guess.toLowerCase().trim();
    const cleanTarget = room.currentWord.word.toLowerCase();
    
    if (cleanGuess === cleanTarget) {
      endRound(roomCode, true, `🎉 ${user.pseudo} a trouvé le mot !`);
    } else {
      socket.emit('guess_wrong', 'Mauvaise réponse');
    }
  });
  
  // Créer une room privée
  socket.on('create_private_room', () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    
    const roomCode = generateRoomCode();
    const roomData = {
      id: roomCode,
      players: [user],
      gameState: 'waiting',
      type: 'private',
      createdAt: Date.now()
    };
    
    activeRooms.set(roomCode, roomData);
    socket.join(roomCode);
    
    socket.emit('private_room_created', { roomCode });
  });
  
  // Rejoindre une room privée
  socket.on('join_private_room', (roomCode) => {
    const room = activeRooms.get(roomCode);
    const user = connectedUsers.get(socket.id);
    
    if (!room || !user) {
      socket.emit('room_error', 'Room introuvable');
      return;
    }
    
    if (room.players.length >= 2) {
      socket.emit('room_error', 'Room pleine');
      return;
    }
    
    room.players.push(user);
    socket.join(roomCode);
    
    // Notifier les joueurs de la room
    io.to(roomCode).emit('player_joined', {
      player: user.pseudo,
      players: room.players.map(p => p.pseudo)
    });
    
    // Si 2 joueurs, démarrer la partie
    if (room.players.length === 2) {
      startGame(roomCode);
    }
  });
  
  // Déconnexion
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      console.log(`Déconnexion de ${user.pseudo}`);
      
      // Retirer de la queue de matchmaking
      matchmakingQueue = matchmakingQueue.filter(p => p.socketId !== socket.id);
      
      // Notifier les rooms actives
      activeRooms.forEach((room, roomCode) => {
        if (room.players.some(p => p.socketId === socket.id)) {
          socket.to(roomCode).emit('player_disconnected', user.pseudo);
          
          // Nettoyer la room si elle devient vide
          room.players = room.players.filter(p => p.socketId !== socket.id);
          if (room.players.length === 0) {
            if (room.timer) clearInterval(room.timer);
            activeRooms.delete(roomCode);
          }
        }
      });
      
      connectedUsers.delete(socket.id);
    }
    
    io.emit('queue_update', {
      playersInQueue: matchmakingQueue.length
    });
  });
});

// Fonction pour terminer une manche
function endRound(roomCode, success, message) {
  const room = activeRooms.get(roomCode);
  if (!room) return;
  
  if (room.timer) {
    clearInterval(room.timer);
  }
  
  const timeUsed = Math.round((Date.now() - room.startTime) / 1000);
  let pointsEarned = 0;
  
  if (success) {
    pointsEarned = calculateScore(timeUsed, room.clues.length, room.currentWord.difficulty);
    
    // Attribuer les points aux deux joueurs
    room.players.forEach(player => {
      room.scores[player.pseudo] = (room.scores[player.pseudo] || 0) + pointsEarned;
      
      // Mettre à jour la base de données
      const userData = userDatabase.get(player.pseudo);
      if (userData) {
        userData.totalScore += pointsEarned;
        userData.wordsGuessed++;
        userData.gamesPlayed++;
      }
    });
  }
  
  io.to(roomCode).emit('round_end', {
    success,
    message,
    word: room.currentWord.word,
    definition: room.currentWord.definition,
    timeUsed,
    cluesUsed: room.clues.length,
    pointsEarned,
    scores: room.scores
  });
  
  // Programmer le prochain round ou terminer la partie
  setTimeout(() => {
    if (activeRooms.has(roomCode)) {
      startNextRound(roomCode);
    }
  }, 5000);
}

function startNextRound(roomCode) {
  const room = activeRooms.get(roomCode);
  if (!room) return;
  
  // Réinitialiser pour le prochain round
  room.currentWord = getRandomWord();
  room.clues = [];
  room.turnsLeft = 4;
  room.timeLeft = 60;
  room.currentGuesser = room.currentGuesser === 1 ? 2 : 1;
  room.startTime = Date.now();
  
  io.to(roomCode).emit('next_round', {
    word: room.currentWord,
    currentGuesser: room.currentGuesser
  });
  
  // Redémarrer le timer
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timer_update', room.timeLeft);
    
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      endRound(roomCode, false, "⏰ Temps écoulé !");
    }
  }, 1000);
}

function startGame(roomCode) {
  const room = activeRooms.get(roomCode);
  if (!room) return;
  
  room.gameState = 'playing';
  room.currentWord = getRandomWord();
  room.clues = [];
  room.turnsLeft = 4;
  room.timeLeft = 60;
  room.currentGuesser = 1;
  room.scores = {};
  room.players.forEach(p => room.scores[p.pseudo] = 0);
  room.startTime = Date.now();
  
  io.to(roomCode).emit('game_start', {
    word: room.currentWord,
    players: room.players.map(p => p.pseudo),
    currentGuesser: room.currentGuesser
  });
  
  // Démarrer le timer
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timer_update', room.timeLeft);
    
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      endRound(roomCode, false, "⏰ Temps écoulé !");
    }
  }, 1000);
}

function calculateScore(timeUsed, cluesUsed, difficulty) {
  let baseScore = 100;
  const timeBonus = Math.max(0, 60 - timeUsed) * 2;
  const clueBonus = (4 - cluesUsed) * 25;
  const difficultyMultiplier = { easy: 1, medium: 1.5, hard: 2 };
  const difficultyBonus = Math.round(baseScore * (difficultyMultiplier[difficulty] - 1));
  
  return Math.round(baseScore + timeBonus + clueBonus + difficultyBonus);
}

// Nettoyage périodique
setInterval(() => {
  const now = Date.now();
  
  // Nettoyer les rooms inactives (plus de 1 heure)
  activeRooms.forEach((room, roomCode) => {
    if (now - room.createdAt > 3600000) {
      if (room.timer) clearInterval(room.timer);
      activeRooms.delete(roomCode);
    }
  });
  
  console.log(`Statistiques: ${connectedUsers.size} connectés, ${matchmakingQueue.length} en queue, ${activeRooms.size} rooms actives`);
}, 300000); // Toutes les 5 minutes

// Démarrage du serveur
server.listen(PORT, () => {
  console.log(`🎯 LexiMarket Server démarré sur le port ${PORT}`);
  console.log(`📊 Tableau de bord: http://localhost:${PORT}`);
});

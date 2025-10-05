const fs = require('fs');

// Lire votre fichier (adaptez le nom si différent)
const mots = JSON.parse(fs.readFileSync('./dictionnaire_francais.json', 'utf8'));

console.log(`📖 ${mots.length} mots trouvés`);

// Nettoyer : minuscules, enlever doublons, enlever vides
const motsNettoyes = [...new Set(mots.map(m => m.toLowerCase().trim()).filter(m => m.length > 0))];

console.log(`✨ ${motsNettoyes.length} mots après nettoyage`);

// Créer le dossier data s'il n'existe pas
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data');
}

// Sauvegarder dans le format attendu
fs.writeFileSync('./data/dictionary.json', JSON.stringify({ words: motsNettoyes }, null, 2));

console.log(`✅ Dictionnaire importé dans ./data/dictionary.json`);
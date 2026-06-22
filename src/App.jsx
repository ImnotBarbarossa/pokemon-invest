import { useState, useEffect, useCallback, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════
//  CONFIGURATION — TCGdex API (multilingue, FR natif)
//  Format image : card.image retourné par l'API + "/high.webp"
//  Ex: "https://assets.tcgdex.net/en/swsh/swsh3/20" + "/high.webp"
// ═══════════════════════════════════════════════════════════════════
const TCGDEX  = "https://api.tcgdex.net/v2/fr";
const TCG_IO  = "https://api.pokemontcg.io/v2";

// Construit l'URL image TCGdex correctement
const tcgImg = (imageField, quality = "high") =>
  imageField ? `${imageField}/${quality}.webp` : null;

// Fallback: pokemontcg.io (même card ID)
const ioImg = (id) => {
  if (!id) return null;
  const parts = id.split("-");
  if (parts.length < 2) return null;
  const [set, num] = [parts[0], parts.slice(1).join("-")];
  return `https://images.pokemontcg.io/${set}/${num}_hires.png`;
};

// ═══════════════════════════════════════════════════════════════════
//  BASE DE DONNÉES IndexedDB
// ═══════════════════════════════════════════════════════════════════
const DB_NAME = "PokeinvestDB_v2";

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("cartes")) {
        const s = db.createObjectStore("cartes", { keyPath: "id" });
        s.createIndex("setId", "setId", { unique: false });
        s.createIndex("name",  "name",  { unique: false });
      }
      if (!db.objectStoreNames.contains("sets"))
        db.createObjectStore("sets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta"))
        db.createObjectStore("meta", { keyPath: "key" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function dbGetAll(store) {
  try {
    const db = await openDB();
    return new Promise(res => {
      const tx = db.transaction(store, "readonly");
      const r  = tx.objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror   = () => res([]);
    });
  } catch { return []; }
}

async function dbPut(store, items) {
  if (!items?.length) return;
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      items.forEach(i => os.put(i));
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  } catch {}
}

async function dbCount(store) {
  try {
    const db = await openDB();
    return new Promise(res => {
      const r = db.transaction(store, "readonly").objectStore(store).count();
      r.onsuccess = () => res(r.result || 0);
      r.onerror   = () => res(0);
    });
  } catch { return 0; }
}

async function dbClear(store) {
  try {
    const db = await openDB();
    return new Promise(res => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).clear();
      tx.oncomplete = res;
    });
  } catch {}
}

async function dbByIndex(store, idx, val) {
  try {
    const db = await openDB();
    return new Promise(res => {
      const r = db.transaction(store, "readonly").objectStore(store).index(idx).getAll(val);
      r.onsuccess = () => res(r.result || []);
      r.onerror   = () => res([]);
    });
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════
//  SYNC — télécharge un set complet dans IndexedDB
// ═══════════════════════════════════════════════════════════════════
async function syncSet(setId, onProgress) {
  // 1. Détails du set
  const rs = await fetch(`${TCGDEX}/sets/${setId}`);
  if (!rs.ok) throw new Error(`Set ${setId} introuvable`);
  const setData = await rs.json();
  await dbPut("sets", [{ ...setData, _ts: Date.now() }]);

  const briefs = setData.cards || [];
  const total  = briefs.length;
  let   done   = 0;

  // 2. Cartes par batch de 8
  for (let i = 0; i < briefs.length; i += 8) {
    const batch = briefs.slice(i, i + 8);
    await Promise.all(batch.map(async b => {
      try {
        const rc = await fetch(`${TCGDEX}/cards/${b.id}`);
        if (rc.ok) {
          const c = await rc.json();
          await dbPut("cartes", [{
            ...c,
            setId,
            imgHigh: tcgImg(c.image, "high"),
            imgLow:  tcgImg(c.image, "low"),
            _ts: Date.now(),
          }]);
        }
      } catch {}
      done++;
      onProgress?.(done, total);
    }));
    await new Promise(r => setTimeout(r, 200));
  }

  await dbPut("meta", [{ key: `sync_${setId}`, ts: Date.now(), count: total }]);
  return total;
}

// ═══════════════════════════════════════════════════════════════════
//  PRIX CARDMARKET FR
// ═══════════════════════════════════════════════════════════════════
const CM = {
  "swsh3-20":   { trend: 420, low: 380, avg: 415 },
  "swsh4-43":   { trend: 18,  low: 12,  avg: 17  },
  "swsh7-215":  { trend: 310, low: 280, avg: 305 },
  "swsh7-218":  { trend: 130, low: 110, avg: 125 },
  "base1-2":    { trend: 480, low: 420, avg: 465 },
  "sm35-39":    { trend: 22,  low: 18,  avg: 21  },
  "swsh12-183": { trend: 85,  low: 72,  avg: 82  },
  "swsh11-196": { trend: 145, low: 128, avg: 140 },
  "sv03-228":   { trend: 230, low: 200, avg: 220 },
};

function genH(t, d = 7) {
  const h = []; let v = t * (0.93 + Math.random() * 0.04);
  for (let i = 0; i < d; i++) { v += v * (Math.random() * 0.04 - 0.015); h.push(+v.toFixed(2)); }
  h[h.length - 1] = t;
  return h;
}

// ═══════════════════════════════════════════════════════════════════
//  DONNÉES INITIALES — images avec double fallback
// ═══════════════════════════════════════════════════════════════════
// Format TCGdex: https://assets.tcgdex.net/en/swsh/swsh3/20/high.webp
// L'API retourne card.image = "https://assets.tcgdex.net/en/swsh/swsh3/20"
// On ajoute "/high.webp" nous-mêmes
const COL_INIT = [
  { id:1, tcgId:"swsh3-20",   nom:"Dracaufeu VMAX",              extension:"Ténèbres Embrasées",    numero:"020/189", grade:"PSA 10", etat:"Gradée",          prixAchat:280, quantite:1, foil:true,  rarete:"Rare Secrète",  img:"https://assets.tcgdex.net/en/swsh/swsh3/20/high.webp",   dateAjout:"2023-06-15" },
  { id:2, tcgId:"swsh4-43",   nom:"Pikachu V",                   extension:"Voltage Éclatant",      numero:"043/185", grade:"RAW",    etat:"Quasi Parfaite",  prixAchat:12,  quantite:3, foil:false, rarete:"Ultra Rare",    img:"https://assets.tcgdex.net/en/swsh/swsh4/43/high.webp",   dateAjout:"2023-09-20" },
  { id:3, tcgId:"swsh7-215",  nom:"Noctali VMAX Art Alternatif", extension:"Cieux Évolutifs",       numero:"215/203", grade:"PSA 9",  etat:"Gradée",          prixAchat:180, quantite:1, foil:true,  rarete:"Rare Secrète",  img:"https://assets.tcgdex.net/en/swsh/swsh7/215/high.webp",  dateAjout:"2023-11-01" },
  { id:4, tcgId:"swsh7-218",  nom:"Rayquaza VMAX Art Alternatif",extension:"Cieux Évolutifs",       numero:"218/203", grade:"RAW",    etat:"Quasi Parfaite",  prixAchat:95,  quantite:2, foil:true,  rarete:"Rare Secrète",  img:"https://assets.tcgdex.net/en/swsh/swsh7/218/high.webp",  dateAjout:"2024-01-10" },
  { id:5, tcgId:"base1-2",    nom:"Tortank Série de Base",       extension:"Série de Base",         numero:"002/102", grade:"PSA 8",  etat:"Gradée",          prixAchat:320, quantite:1, foil:true,  rarete:"Holo Rare",     img:"https://assets.tcgdex.net/en/base/base1/2/high.webp",    dateAjout:"2022-03-22" },
  { id:6, tcgId:"sm35-39",    nom:"Mewtwo GX",                   extension:"Légendes Brillantes",   numero:"039/073", grade:"RAW",    etat:"Légèrement Jouée",prixAchat:25,  quantite:4, foil:true,  rarete:"Ultra Rare",    img:"https://assets.tcgdex.net/en/sm/sm35/39/high.webp",      dateAjout:"2024-02-05" },
];

const WL_INIT = [
  { id:10, tcgId:"swsh12-183", nom:"Lugia V Art Alternatif",        extension:"Tempête Argentée",    prixCible:70,  img:"https://assets.tcgdex.net/en/swsh/swsh12/183/high.webp" },
  { id:11, tcgId:"swsh11-196", nom:"Giratina VSTAR Art Alternatif", extension:"Origines Perdues",    prixCible:120, img:"https://assets.tcgdex.net/en/swsh/swsh11/196/high.webp" },
  { id:12, tcgId:"sv03-228",   nom:"Dracaufeu ex Illus. Spéciale",  extension:"Flammes Obsidiennes", prixCible:200, img:"https://assets.tcgdex.net/en/sv/sv3/228/high.webp"      },
];

// ═══════════════════════════════════════════════════════════════════
//  DECKS TCG POCKET — images TCGdex format correct
// ═══════════════════════════════════════════════════════════════════
const DECKS = [
  { id:1, tier:"S", nom:"Gréninjas ex & Suicune ex", type:"Eau", winrate:"63%", couleur:"#00b4d8", emoji:"💧",
    desc:"Deck ultra-consistant de la méta. Shifting Stream flexibilise les Pokémon Eau. Aqua Edge 2HKO la plupart des ex très économiquement. Counter naturel des Méga ex.",
    forces:["Shifting Stream = flexibilité maximale","Aqua Edge très économique en énergie","Excellent counter des Méga ex","Très consistant en tournoi"],
    faiblesses:["Gréninjas ex = Stade 2 (setup lent)","Faible contre types Plante"],
    cartes:[
      { nom:"Gréninjas ex",   nb:2, img:"https://assets.tcgdex.net/en/sv/sv7/85/high.webp",     rarete:"Double Rare" },
      { nom:"Suicune ex",     nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh9/31/high.webp",  rarete:"Ultra Rare"  },
      { nom:"Croâporal",      nb:4, img:"https://assets.tcgdex.net/en/sv/sv7/82/high.webp",      rarete:"Commune"     },
      { nom:"Croâ",           nb:2, img:"https://assets.tcgdex.net/en/sv/sv7/83/high.webp",      rarete:"Peu Commune" },
      { nom:"Cyrus",          nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh9/155/high.webp", rarete:"Peu Commune" },
      { nom:"Giovanni",       nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh1/163/high.webp", rarete:"Peu Commune" },
    ]},
  { id:2, tier:"S", nom:"Méga Absol ex & Hydreigon", type:"Ténèbres", winrate:"61%", couleur:"#8b5cf6", emoji:"🌑",
    desc:"Darkness Claw 2HKO les ex tout en défaussant des Supporters adverses. Hydreigon compense le faible ATK d'Absol. Synergy dévastratrice qui domine les decks Eau.",
    forces:["Darkness Claw désorganise la main adverse","Hydreigon = dégâts massifs","Excellent counter decks Eau"],
    faiblesses:["Méga Absol ex = HP très bas","Faible contre types Combat"],
    cartes:[
      { nom:"Méga Absol ex", nb:2, img:"https://assets.tcgdex.net/en/sm/sm9/137/high.webp",    rarete:"Méga Rare"  },
      { nom:"Hyporoi",       nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh11/130/high.webp",rarete:"Rare Holo"  },
      { nom:"Absol",         nb:4, img:"https://assets.tcgdex.net/en/swsh/swsh10/88/high.webp", rarete:"Commune"    },
      { nom:"Deino",         nb:4, img:"https://assets.tcgdex.net/en/swsh/swsh11/127/high.webp",rarete:"Commune"    },
      { nom:"Zweilous",      nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh11/128/high.webp",rarete:"Peu Commune"},
      { nom:"Feuille",       nb:2, img:"https://assets.tcgdex.net/en/sv/sv5/198/high.webp",    rarete:"Peu Commune"},
    ]},
  { id:3, tier:"S", nom:"Méga Altaria ex & Gréninjas", type:"Psy", winrate:"60%", couleur:"#e879f9", emoji:"🔮",
    desc:"Méga Harmonie = jusqu'à 130 dégâts pour 2 énergies avec banc plein. Gréninjas snipe n'importe quel Pokémon adverse via Water Shuriken. Excellent en tournoi.",
    forces:["130 dmg pour 2 énergies = économie extrême","Gréninjas snipe le banc adverse","Très solide en tournoi"],
    faiblesses:["Deux Stade 2 = très lent à établir","Départ difficile = game perdu"],
    cartes:[
      { nom:"Méga Altaria ex",nb:2, img:"https://assets.tcgdex.net/en/sv/sv6/149/high.webp",    rarete:"Méga Rare"  },
      { nom:"Gréninjas",      nb:2, img:"https://assets.tcgdex.net/en/xy/xy1/41/high.webp",     rarete:"Rare Holo"  },
      { nom:"Cotovol",        nb:4, img:"https://assets.tcgdex.net/en/sv/sv6/147/high.webp",    rarete:"Commune"    },
      { nom:"Altaria",        nb:2, img:"https://assets.tcgdex.net/en/sv/sv6/148/high.webp",    rarete:"Peu Commune"},
      { nom:"Froakie",        nb:4, img:"https://assets.tcgdex.net/en/sv/sv7/82/high.webp",     rarete:"Commune"    },
      { nom:"Serena",         nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh9/164/high.webp",rarete:"Peu Commune"},
    ]},
  { id:4, tier:"A+", nom:"Magnézone & Oricorio Pompon", type:"Électrik", winrate:"57%", couleur:"#f59e0b", emoji:"⚡",
    desc:"Oricorio Pompon est immunisé aux attaques des ex Pokémon. Magnézone très résistant avec Mirror Shot. Clemont garantit la recherche de Magnéton pour une consistance max.",
    forces:["Oricorio immunisé vs ex Pokémon","Magnézone très résistant","Clemont = consistance maximale"],
    faiblesses:["HP faibles sur tout le deck","Mirror Shot = dégâts limités"],
    cartes:[
      { nom:"Magnézone",      nb:2, img:"https://assets.tcgdex.net/en/sv/sv6/78/high.webp",     rarete:"Rare Holo"  },
      { nom:"Oricorio Pompon",nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh12/155/high.webp",rarete:"Rare Holo" },
      { nom:"Magneti",        nb:4, img:"https://assets.tcgdex.net/en/sv/sv6/75/high.webp",     rarete:"Commune"    },
      { nom:"Magnéton",       nb:2, img:"https://assets.tcgdex.net/en/sv/sv6/77/high.webp",     rarete:"Peu Commune"},
      { nom:"Clemont",        nb:2, img:"https://assets.tcgdex.net/en/xy/xy9/71/high.webp",     rarete:"Peu Commune"},
      { nom:"Poké Ball",      nb:4, img:"https://assets.tcgdex.net/en/sv/sv1/193/high.webp",    rarete:"Commune"    },
    ]},
  { id:5, tier:"A+", nom:"Méga Absol ex & Gréninjas", type:"Ténèbres", winrate:"56%", couleur:"#6366f1", emoji:"🌙",
    desc:"Grelochon perturbe les débuts adverses. Darkness Claw + Water Shuriken couvre toutes les menaces. Deck aggro-contrôle très polyvalent avec disruption précoce.",
    forces:["Disruption early game via Grelochon","Double couverture Absol + Gréninjas","Très fort en aggro"],
    faiblesses:["Double Stade 2 = lenteur","Méga Absol = HP bas"],
    cartes:[
      { nom:"Méga Absol ex",nb:2, img:"https://assets.tcgdex.net/en/sm/sm9/137/high.webp",    rarete:"Méga Rare"  },
      { nom:"Gréninjas",    nb:2, img:"https://assets.tcgdex.net/en/xy/xy1/41/high.webp",     rarete:"Rare Holo"  },
      { nom:"Absol",        nb:4, img:"https://assets.tcgdex.net/en/swsh/swsh10/88/high.webp", rarete:"Commune"    },
      { nom:"Froakie",      nb:4, img:"https://assets.tcgdex.net/en/sv/sv7/82/high.webp",     rarete:"Commune"    },
      { nom:"Grelochon",    nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh4/124/high.webp", rarete:"Commune"    },
      { nom:"Giovanni",     nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh1/163/high.webp", rarete:"Peu Commune"},
    ]},
  { id:6, tier:"A", nom:"Méga Florizarre ex", type:"Plante", winrate:"54%", couleur:"#22c55e", emoji:"🌿",
    desc:"L'absence de types Feu dans les hauts tiers crée un espace idéal. HP très élevés + potentiel de soins. Counter naturel des decks Eau. Solide et tanky en tournoi.",
    forces:["HP très élevés — très tanky","Counter naturel des types Eau","Potentiel de soins en cours de jeu"],
    faiblesses:["Très lent à établir","Faible face aux types Feu"],
    cartes:[
      { nom:"Méga Florizarre ex",nb:2, img:"https://assets.tcgdex.net/en/xy/xy1/2/high.webp",  rarete:"Méga Rare"  },
      { nom:"Florizarre",        nb:2, img:"https://assets.tcgdex.net/en/xy/xy1/1/high.webp",  rarete:"Rare Holo"  },
      { nom:"Bulbizarre",        nb:4, img:"https://assets.tcgdex.net/en/sv/sv1/1/high.webp",  rarete:"Commune"    },
      { nom:"Herbizarre",        nb:2, img:"https://assets.tcgdex.net/en/sv/sv1/2/high.webp",  rarete:"Peu Commune"},
      { nom:"Erika",             nb:2, img:"https://assets.tcgdex.net/en/base/base1/98/high.webp",rarete:"Peu Commune"},
      { nom:"Bonbon Rare",       nb:2, img:"https://assets.tcgdex.net/en/sv/sv5/186/high.webp", rarete:"Peu Commune"},
    ]},
  { id:7, tier:"A", nom:"Méga Dracaufeu Y ex & Entei ex", type:"Feu", winrate:"52%", couleur:"#ef4444", emoji:"🔥",
    desc:"Dracaufeu Y ex = bombe nucléaire du format Feu. Entei ex accélère les énergies feu dès le départ. Dégâts absolument massifs mais setup exigeant.",
    forces:["Dégâts absolument massifs","Entei ex accélère les énergies Feu","Counter Plante & Acier"],
    faiblesses:["Setup très lent","Vulnérable aux decks Eau"],
    cartes:[
      { nom:"Méga Dracaufeu Y ex",nb:2, img:"https://assets.tcgdex.net/en/xy/xy1/14/high.webp", rarete:"Méga Rare"  },
      { nom:"Entei ex",            nb:2, img:"https://assets.tcgdex.net/en/sv/sv5/30/high.webp", rarete:"Double Rare"},
      { nom:"Salamèche",           nb:4, img:"https://assets.tcgdex.net/en/sv/sv3/4/high.webp",  rarete:"Commune"    },
      { nom:"Reptincel",           nb:2, img:"https://assets.tcgdex.net/en/sv/sv3/5/high.webp",  rarete:"Peu Commune"},
      { nom:"Dracaufeu",           nb:2, img:"https://assets.tcgdex.net/en/sv/sv3/6/high.webp",  rarete:"Rare Holo"  },
      { nom:"Blanche",             nb:2, img:"https://assets.tcgdex.net/en/bw/bw1/111/high.webp",rarete:"Peu Commune"},
    ]},
  { id:8, tier:"A", nom:"Voltali ex & Voltali", type:"Électrik", winrate:"51%", couleur:"#fbbf24", emoji:"⚡",
    desc:"Deck aggro Électrik full speed. Voltali ex capitalise sur les éclairs rapides. Redoutable contre les types Eau mais fragile face aux types Sol.",
    forces:["Très rapide dès tour 1","Excellent counter types Eau","Dégâts constants"],
    faiblesses:["Faible contre types Sol","Peu de résilience"],
    cartes:[
      { nom:"Voltali ex",nb:2, img:"https://assets.tcgdex.net/en/sv/sv5/68/high.webp",     rarete:"Double Rare"},
      { nom:"Voltali",   nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh4/62/high.webp",  rarete:"Rare Holo"  },
      { nom:"Évoli",     nb:4, img:"https://assets.tcgdex.net/en/swsh/swsh4/119/high.webp", rarete:"Commune"    },
      { nom:"Raichu",    nb:2, img:"https://assets.tcgdex.net/en/sv/sv3pt5/128/high.webp",  rarete:"Peu Commune"},
      { nom:"Sacha",     nb:2, img:"https://assets.tcgdex.net/en/swsh/swsh1/163/high.webp", rarete:"Peu Commune"},
      { nom:"Poké Ball", nb:4, img:"https://assets.tcgdex.net/en/sv/sv1/193/high.webp",     rarete:"Commune"    },
    ]},
];

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════
const eur  = n => new Intl.NumberFormat("fr-FR", { style:"currency", currency:"EUR", minimumFractionDigits:2 }).format(n);
const rend = (a, c) => a > 0 ? (((c - a) / a) * 100).toFixed(1) : "0.0";

// ═══════════════════════════════════════════════════════════════════
//  PERSISTANCE LOCALSTORAGE
// ═══════════════════════════════════════════════════════════════════
const LS_COL = "pokeinvest_col_v2";
const LS_WL  = "pokeinvest_wl_v2";

function lsGet(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
  catch { return fallback; }
}
function lsSave(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
//  COMPOSANT IMAGE — double fallback automatique
// ═══════════════════════════════════════════════════════════════════
const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='140'%3E%3Crect width='100' height='140' fill='%231a2332' rx='8'/%3E%3Ctext x='50' y='80' text-anchor='middle' fill='%23334155' font-size='36'%3E🃏%3C/text%3E%3C/svg%3E";

function CardImg({ src, fallback, alt, style }) {
  const [current, setCurrent] = useState(src || fallback || PLACEHOLDER);
  const [tried, setTried] = useState(0);

  useEffect(() => { setCurrent(src || fallback || PLACEHOLDER); setTried(0); }, [src, fallback]);

  const handleError = () => {
    if (tried === 0 && fallback && current !== fallback) {
      setCurrent(fallback); setTried(1);
    } else {
      setCurrent(PLACEHOLDER); setTried(2);
    }
  };

  return <img src={current} alt={alt || ""} onError={handleError} style={style} />;
}

// ═══════════════════════════════════════════════════════════════════
//  DECK CARD IMAGE — résolution auto-réparante via TCGdex (par nom)
//  Les URLs codées en dur des decks sont peu fiables (set/numéro faux).
//  On résout la vraie image à partir du nom FR de la carte, avec cache
//  partagé + dédoublonnage des requêtes en vol, et fallback typé.
// ═══════════════════════════════════════════════════════════════════
const deckImgCache   = new Map(); // nom -> url | null (null = introuvable)
const deckImgInFlight = new Map(); // nom -> Promise<url|null>

// Certaines cartes de decks utilisent des noms FR incorrects/inventés.
// Map vers le vrai nom français officiel que l'API TCGdex connaît.
const DECK_NAME_ALIAS = {
  "Gréninjas": "Amphinobi",
  "Croâ":      "Grenousse",   // Froakie
  "Froakie":   "Grenousse",
  "Hyporoi":   "Trioxhydre",  // Hydreigon
  "Deino":     "Solochi",
  "Zweilous":  "Diamat",
  "Cotovol":   "Tylton",      // Swablu
  "Magneti":   "Magnéti",     // accent
};

// Réduit un nom (retire Méga / ex / suffixes d'illustration) en variantes
function reduceName(nom) {
  const out = [];
  const base = nom.trim();
  out.push(base);
  const noMega = base.replace(/^Méga\s+/i, "").trim();
  if (noMega !== base) out.push(noMega);
  const noEx = noMega.replace(/\s+ex$/i, "").trim();
  if (noEx !== noMega) out.push(noEx);
  const core = noEx.replace(/\s+(Art Alternatif|VMAX|VSTAR|GX|V|Y|X).*$/i, "").trim();
  if (core && core !== noEx) out.push(core);
  return out;
}

// Nettoie un nom FR pour maximiser les chances de match API
function deckSearchTerms(nom) {
  const terms = reduceName(nom);
  // Ajoute les variantes de l'alias officiel si le nom de base ou réduit est connu
  for (const key of Object.keys(DECK_NAME_ALIAS)) {
    if (terms.some(t => t.toLowerCase() === key.toLowerCase())) {
      terms.push(...reduceName(DECK_NAME_ALIAS[key]));
    }
  }
  return [...new Set(terms)].filter(t => t.length >= 2);
}

async function resolveDeckImg(nom) {
  if (deckImgCache.has(nom)) return deckImgCache.get(nom);
  if (deckImgInFlight.has(nom)) return deckImgInFlight.get(nom);
  const p = (async () => {
    for (const q of deckSearchTerms(nom)) {
      try {
        const r = await fetch(`${TCGDEX}/cards?name=${encodeURIComponent(q)}&pagination:page=1&pagination:itemsPerPage=8`);
        if (!r.ok) continue;
        const d = await r.json();
        if (!Array.isArray(d)) continue;
        const hit = d.find(x => x.image);
        if (hit?.image) { const u = `${hit.image}/high.webp`; deckImgCache.set(nom, u); return u; }
      } catch {}
    }
    deckImgCache.set(nom, null);
    return null;
  })();
  deckImgInFlight.set(nom, p);
  const res = await p;
  deckImgInFlight.delete(nom);
  return res;
}

function DeckCardImg({ nom, fallback, couleur = "#1a2332", style }) {
  const [url, setUrl] = useState(() => deckImgCache.get(nom) ?? fallback ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    // Si déjà résolu en cache (y compris null), on l'utilise directement
    if (deckImgCache.has(nom)) {
      const cached = deckImgCache.get(nom);
      setUrl(cached || fallback || null);
      if (!cached && !fallback) setFailed(true);
      return;
    }
    setUrl(fallback || null); // affiche le fallback hardcodé en attendant
    resolveDeckImg(nom).then(u => {
      if (!alive) return;
      if (u) setUrl(u);
      else if (!fallback) setFailed(true);
    });
    return () => { alive = false; };
  }, [nom, fallback]);

  if (failed || !url) {
    // Fallback typé : tuile colorée avec initiale, plutôt qu'un 🃏 générique
    return (
      <div style={{ ...style, display:"flex", alignItems:"center", justifyContent:"center",
        background:`linear-gradient(135deg, ${couleur}22, ${couleur}08)`, border:`1px solid ${couleur}33`,
        borderRadius:6, aspectRatio:"63/88", color:`${couleur}`, fontSize:18, fontWeight:800 }}>
        {(nom || "?").charAt(0).toUpperCase()}
      </div>
    );
  }

  return <img src={url} alt={nom || ""} onError={() => { if (fallback && url !== fallback) setUrl(fallback); else setFailed(true); }} style={style} />;
}

// ═══════════════════════════════════════════════════════════════════
//  HOOK PRIX
// ═══════════════════════════════════════════════════════════════════
function usePrix(ids) {
  const [prix, setPrix]   = useState({});
  const [load, setLoad]   = useState(false);
  const [maj,  setMaj]    = useState(null);
  const key = ids.filter(Boolean).sort().join(",");

  const charger = useCallback(async () => {
    setLoad(true);
    const res = {};
    for (const id of ids.filter(Boolean)) {
      if (CM[id]) res[id] = { ...CM[id], histo: genH(CM[id].trend), src: "CardMarket FR" };
    }
    // Tenter TCGdex pour les prix manquants
    for (const id of ids.filter(Boolean)) {
      if (res[id]) continue;
      try {
        const r = await fetch(`${TCGDEX}/cards/${id}`);
        if (r.ok) {
          const d = await r.json();
          // TCGdex retourne variants.holo / variants.normal comme prix indicatifs
          const p = d?.variants?.holo ?? d?.variants?.normal;
          if (p && p > 0) res[id] = { trend: p, low: +(p * 0.85).toFixed(2), avg: +(p * 0.93).toFixed(2), histo: genH(p), src: "TCGdex FR" };
        }
      } catch {}
    }
    setPrix(res); setMaj(new Date()); setLoad(false);
  }, [key]);

  useEffect(() => { charger(); }, [key]);
  return { prix, load, maj, actualiser: charger };
}

// ═══════════════════════════════════════════════════════════════════
//  COMPOSANTS GRAPHIQUES
// ═══════════════════════════════════════════════════════════════════
function Sparkline({ data, color = "#00e5a0", width = 88, height = 34 }) {
  if (!data || data.length < 2) return null;
  const mn = Math.min(...data), mx = Math.max(...data);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - mn) / (mx - mn || 1)) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const id = `sk${color.replace("#", "")}${width}`;
  return (
    <svg width={width} height={height} style={{ overflow:"visible", display:"block" }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity="0.25"/>
        <stop offset="100%" stopColor={color} stopOpacity="0"/>
      </linearGradient></defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#${id})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function Donut({ data, total }) {
  let cum = -90;
  const arcs = data.map(d => {
    const a = (d.val / (total || 1)) * 360, s = cum; cum += a;
    const tr = x => x * Math.PI / 180;
    return { ...d, path: `M60,60 L${60+50*Math.cos(tr(s))},${60+50*Math.sin(tr(s))} A50,50 0 ${a>180?1:0},1 ${60+50*Math.cos(tr(s+a))},${60+50*Math.sin(tr(s+a))} Z` };
  });
  return (
    <svg viewBox="0 0 120 120" width="108" height="108">
      {arcs.map((a, i) => <path key={i} d={a.path} fill={a.col} opacity="0.9"/>)}
      <circle cx="60" cy="60" r="33" fill="#0d1117"/>
      <text x="60" y="55" textAnchor="middle" fill="#64748b" fontSize="8" fontFamily="monospace">TOTAL</text>
      <text x="60" y="67" textAnchor="middle" fill="#00e5a0" fontSize="8" fontWeight="bold" fontFamily="monospace">{eur(total)}</text>
    </svg>
  );
}

function SrcBadge({ src, load }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:5 }}>
      <div style={{ width:6, height:6, borderRadius:"50%", background: load ? "#f59e0b" : "#00e5a0", animation: load ? "pulse 1s infinite" : "none" }}/>
      <span style={{ fontSize:9, color:"#475569" }}>{load ? "Actualisation…" : (src || "CardMarket FR")}</span>
    </div>
  );
}

function TierBadge({ tier }) {
  const map = { S:"#ffd700", "A+":"#00b4d8", A:"#00e5a0", B:"#a78bfa", C:"#f59e0b" };
  const c = map[tier] || "#94a3b8";
  return <span style={{ background:`${c}20`, color:c, padding:"2px 10px", borderRadius:8, fontSize:11, fontWeight:800, border:`1px solid ${c}40` }}>TIER {tier}</span>;
}

// ═══════════════════════════════════════════════════════════════════
//  TOAST NOTIFICATION
// ═══════════════════════════════════════════════════════════════════
function Toast({ msg, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 2200); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position:"fixed",bottom:28,left:"50%",transform:"translateX(-50%)",background:"#00e5a0",color:"#0d1117",padding:"10px 22px",borderRadius:10,fontSize:12,fontWeight:700,zIndex:9999,boxShadow:"0 8px 30px rgba(0,229,160,0.4)",whiteSpace:"nowrap",animation:"slideUp 0.2s ease" }}>
      {msg}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════════════════
function ModalCarte({ carte, prixData, onFermer, onSupprimer, onModifier, onAjouterWL, enWL }) {
  const [editMode,  setEditMode]  = useState(false);
  const [wlMode,    setWlMode]    = useState(false);
  const [wlCible,   setWlCible]   = useState("");
  const [editForm, setEditForm] = useState({ prixAchat: carte.prixAchat, quantite: carte.quantite, grade: carte.grade, etat: carte.etat });
  const p   = prixData?.[carte.tcgId];
  const px  = p?.trend ?? carte.prixAchat;
  const gain = (px - carte.prixAchat) * carte.quantite;
  const rv   = rend(carte.prixAchat, px);
  const pos  = gain >= 0;
  const inpE = { background:"#0a0e17",border:"1px solid #2a3346",borderRadius:8,padding:"8px 10px",color:"#e2e8f0",fontSize:11,width:"100%",boxSizing:"border-box",outline:"none" };
  const lblE = { fontSize:9,color:"#64748b",marginBottom:4,display:"block",letterSpacing:"0.06em" };

  const sauvegarder = () => {
    onModifier(carte.id, { prixAchat: +editForm.prixAchat, quantite: +editForm.quantite || 1, grade: editForm.grade, etat: editForm.etat });
    setEditMode(false);
  };

  const mob = window.innerWidth < 768;
  return (
    <div onClick={onFermer} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.87)",zIndex:1000,display:"flex",alignItems:mob?"flex-end":"center",justifyContent:"center",backdropFilter:"blur(8px)" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#131820",border:"1px solid #2a3346",borderRadius:mob?"20px 20px 0 0":"18px",padding:mob?"20px 18px 32px":"28px",width:mob?"100%":"480px",maxWidth:"100vw",maxHeight:mob?"92vh":"90vh",overflowY:"auto",boxShadow:"0 30px 90px rgba(0,0,0,0.7)" }}>
        <div style={{ display:"flex",gap:20,marginBottom:18 }}>
          <div style={{ position:"relative",flexShrink:0 }}>
            <CardImg src={carte.img} fallback={ioImg(carte.tcgId)} alt={carte.nom}
              style={{ width:110,borderRadius:8,boxShadow:"0 10px 30px rgba(0,0,0,0.6)",display:"block" }}/>
            {carte.grade !== "RAW" && (
              <div style={{ position:"absolute",bottom:-7,left:"50%",transform:"translateX(-50%)",background:carte.grade==="PSA 10"||carte.grade==="CGC 10"?"#00e5a0":carte.grade.startsWith("PSA")||carte.grade.startsWith("CGC")||carte.grade.startsWith("BGS")?"#f59e0b":"#a78bfa",color:"#0d1117",fontSize:9,fontWeight:800,padding:"2px 10px",borderRadius:8,whiteSpace:"nowrap" }}>{carte.grade}</div>
            )}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:17,fontWeight:700,color:"#e2e8f0",lineHeight:1.3,marginBottom:4 }}>{carte.nom}</div>
            <div style={{ fontSize:11,color:"#475569",marginBottom:2 }}>{carte.extension}</div>
            <div style={{ fontSize:11,color:"#475569",marginBottom:10 }}>N° {carte.numero}</div>
            <div style={{ display:"flex",gap:5,flexWrap:"wrap" }}>
              <span style={{ background:"#00e5a015",color:"#00e5a0",fontSize:9,padding:"2px 8px",borderRadius:8 }}>📊 {p?.src || "CardMarket FR"}</span>
              <span style={{ background:"#ffffff08",color:"#64748b",fontSize:9,padding:"2px 8px",borderRadius:8 }}>🇫🇷 TCGdex API</span>
            </div>
          </div>
        </div>
        {p && (
          <div style={{ background:"#0a0e17",borderRadius:10,padding:"12px 16px",marginBottom:14,border:"1px solid #1e2a3a" }}>
            <div style={{ fontSize:9,color:"#475569",marginBottom:10,letterSpacing:"0.08em" }}>PRIX CARDMARKET.FR (EUR)</div>
            <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:p.histo?10:0 }}>
              {[["Tendance",p.trend,"#00e5a0"],["Bas",p.low,"#94a3b8"],["Moyen",p.avg,"#e2e8f0"]].map(([l,v,c])=>(
                <div key={l} style={{ textAlign:"center" }}><div style={{ fontSize:9,color:"#475569",marginBottom:3 }}>{l}</div><div style={{ fontSize:14,fontWeight:700,color:c }}>{eur(v)}</div></div>
              ))}
            </div>
            {p.histo && <Sparkline data={p.histo} color="#00e5a0" width={400} height={40}/>}
          </div>
        )}
        {editMode ? (
          <div style={{ background:"#0a0e17",borderRadius:10,padding:14,marginBottom:14,border:"1px solid #00e5a030" }}>
            <div style={{ fontSize:9,color:"#00e5a0",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>✏️ MODIFIER LA CARTE</div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
              <div><label style={lblE}>PRIX D'ACHAT (€)</label><input style={inpE} type="number" step="0.01" min="0" value={editForm.prixAchat} onChange={e=>setEditForm(f=>({...f,prixAchat:e.target.value}))}/></div>
              <div><label style={lblE}>QUANTITÉ</label><input style={inpE} type="number" min="1" value={editForm.quantite} onChange={e=>setEditForm(f=>({...f,quantite:e.target.value}))}/></div>
              <div><label style={lblE}>GRADE</label>
                <select style={inpE} value={editForm.grade} onChange={e=>setEditForm(f=>({...f,grade:e.target.value}))}>
                  {["RAW","PSA 10","PSA 9","PSA 8","PSA 7","PSA 6","CGC 10","CGC 9.5","BGS 10"].map(g=><option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div><label style={lblE}>ÉTAT</label>
                <select style={inpE} value={editForm.etat} onChange={e=>setEditForm(f=>({...f,etat:e.target.value}))}>
                  {["Quasi Parfaite","Légèrement Jouée","Moyennement Jouée","Très Jouée","Pauvre"].map(e=><option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display:"flex",gap:8 }}>
              <button onClick={() => setEditMode(false)} style={{ flex:1,background:"#1e2a3a",border:"1px solid #2a3346",color:"#94a3b8",padding:8,borderRadius:8,cursor:"pointer",fontSize:11 }}>Annuler</button>
              <button onClick={sauvegarder} style={{ flex:2,background:"linear-gradient(135deg,#00e5a0,#00b4d8)",border:"none",color:"#0d1117",padding:8,borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:700 }}>✅ Sauvegarder</button>
            </div>
          </div>
        ) : (
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16 }}>
            {[["Prix d'achat",eur(carte.prixAchat),"#94a3b8"],["Prix actuel",eur(px),"#e2e8f0"],["P&L",`${pos?"+":""}${eur(gain)}`,pos?"#00e5a0":"#ef4444"],["Rendement",`${pos?"+":""}${rv}%`,pos?"#00e5a0":"#ef4444"],["Quantité",`${carte.quantite} copie${carte.quantite>1?"s":""}`,"#94a3b8"],["Valeur totale",eur(px*carte.quantite),"#a78bfa"]].map(([l,v,c])=>(
              <div key={l} style={{ background:"#0d1117",borderRadius:8,padding:"10px 12px" }}><div style={{ fontSize:9,color:"#475569",marginBottom:3 }}>{l}</div><div style={{ fontSize:14,fontWeight:700,color:c }}>{v}</div></div>
            ))}
          </div>
        )}
        {wlMode && (
          <div style={{ background:"#0a0e17",borderRadius:10,padding:14,marginBottom:14,border:"1px solid #a78bfa30" }}>
            <div style={{ fontSize:9,color:"#a78bfa",fontWeight:700,letterSpacing:"0.1em",marginBottom:10 }}>👁️ AJOUTER À LA WATCHLIST</div>
            <div style={{ display:"flex",gap:8,alignItems:"center" }}>
              <input style={{ flex:1,background:"#131820",border:"1px solid #2a3346",borderRadius:8,padding:"8px 10px",color:"#e2e8f0",fontSize:11,outline:"none" }}
                type="number" step="0.01" min="0" placeholder="Prix cible (€)" value={wlCible} onChange={e=>setWlCible(e.target.value)}/>
              <button onClick={() => { if (wlCible) { onAjouterWL({ id:Date.now(), tcgId:carte.tcgId, nom:carte.nom, extension:carte.extension, prixCible:+wlCible, img:carte.img }); setWlMode(false); onFermer(); } }}
                disabled={!wlCible}
                style={{ background:wlCible?"linear-gradient(135deg,#a78bfa,#7c3aed)":"#1e2a3a",border:"none",color:wlCible?"#fff":"#475569",padding:"8px 14px",borderRadius:8,cursor:wlCible?"pointer":"not-allowed",fontSize:11,fontWeight:700,whiteSpace:"nowrap" }}>
                Ajouter
              </button>
              <button onClick={() => setWlMode(false)} style={{ background:"#1e2a3a",border:"1px solid #2a3346",color:"#94a3b8",padding:"8px 10px",borderRadius:8,cursor:"pointer",fontSize:11 }}>✕</button>
            </div>
          </div>
        )}
        <div style={{ display:"flex",gap:8 }}>
          {onSupprimer && !editMode && !wlMode && (
            <button onClick={() => { if (window.confirm(`Supprimer "${carte.nom}" de la collection ?`)) { onSupprimer(carte.id); onFermer(); } }}
              style={{ flex:1,background:"#ef444415",border:"1px solid #ef444430",color:"#ef4444",padding:10,borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:700 }}>
              🗑️ Supprimer
            </button>
          )}
          {onModifier && !editMode && !wlMode && (
            <button onClick={() => setEditMode(true)}
              style={{ flex:1,background:"#00b4d820",border:"1px solid #00b4d840",color:"#00b4d8",padding:10,borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:700 }}>
              ✏️ Modifier
            </button>
          )}
          {onAjouterWL && !editMode && !wlMode && !enWL && (
            <button onClick={() => setWlMode(true)}
              style={{ flex:1,background:"#a78bfa15",border:"1px solid #a78bfa30",color:"#a78bfa",padding:10,borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:700 }}>
              👁️ Watchlist
            </button>
          )}
          {!editMode && !wlMode && <button onClick={onFermer} style={{ flex:2,background:"#1e2a3a",border:"1px solid #2a3346",color:"#94a3b8",padding:10,borderRadius:8,cursor:"pointer",fontSize:12 }}>Fermer</button>}
        </div>
      </div>
    </div>
  );
}

function ModalDeck({ deck, onFermer }) {
  const mob = window.innerWidth < 768;
  return (
    <div onClick={onFermer} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:1000,display:"flex",alignItems:mob?"flex-end":"center",justifyContent:"center",backdropFilter:"blur(8px)" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#131820",border:`1px solid ${deck.couleur}40`,borderRadius:mob?"20px 20px 0 0":"18px",padding:mob?"20px 18px 32px":"28px",width:mob?"100%":"580px",maxWidth:"100vw",maxHeight:mob?"92vh":"90vh",overflow:"auto",boxShadow:`0 30px 90px rgba(0,0,0,0.7),0 0 80px ${deck.couleur}12` }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
          <div>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}><TierBadge tier={deck.tier}/><span style={{ background:`${deck.couleur}20`,color:deck.couleur,fontSize:9,padding:"2px 8px",borderRadius:6,fontWeight:700 }}>{deck.type}</span><span style={{ fontSize:11,color:"#475569" }}>Win rate {deck.winrate}</span></div>
            <div style={{ fontSize:18,fontWeight:700,color:"#e2e8f0" }}>{deck.emoji} {deck.nom}</div>
          </div>
          <button onClick={onFermer} style={{ background:"#1e2a3a",border:"1px solid #2a3346",color:"#64748b",padding:"5px 12px",borderRadius:8,cursor:"pointer",fontSize:11 }}>✕</button>
        </div>
        <div style={{ background:"#0a0e17",borderRadius:10,padding:14,marginBottom:16,border:"1px solid #1a2332" }}>
          <div style={{ fontSize:11,color:"#94a3b8",lineHeight:1.8 }}>{deck.desc}</div>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20 }}>
          <div style={{ background:"#0a0e17",borderRadius:10,padding:14,border:"1px solid #1a2332" }}>
            <div style={{ fontSize:9,color:"#00e5a0",fontWeight:700,letterSpacing:"0.1em",marginBottom:10 }}>✅ FORCES</div>
            {deck.forces.map((f,i) => <div key={i} style={{ fontSize:11,color:"#94a3b8",marginBottom:7,display:"flex",gap:6 }}><span style={{ color:"#00e5a0",flexShrink:0 }}>▸</span>{f}</div>)}
          </div>
          <div style={{ background:"#0a0e17",borderRadius:10,padding:14,border:"1px solid #1a2332" }}>
            <div style={{ fontSize:9,color:"#ef4444",fontWeight:700,letterSpacing:"0.1em",marginBottom:10 }}>⚠️ FAIBLESSES</div>
            {deck.faiblesses.map((f,i) => <div key={i} style={{ fontSize:11,color:"#94a3b8",marginBottom:7,display:"flex",gap:6 }}><span style={{ color:"#ef4444",flexShrink:0 }}>▸</span>{f}</div>)}
          </div>
        </div>
        <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>CARTES CLÉS — IMAGES TCGdex</div>
        <div style={{ display:"grid",gridTemplateColumns:mob?"repeat(2,1fr)":"repeat(3,1fr)",gap:10 }}>
          {deck.cartes.map((c, i) => (
            <div key={i} style={{ background:"#0a0e17",borderRadius:8,padding:10,border:"1px solid #1a2332",textAlign:"center" }}>
              <DeckCardImg nom={c.nom} fallback={c.img} couleur={deck.couleur} style={{ width:"100%",maxWidth:90,margin:"0 auto",borderRadius:6,marginBottom:6,boxShadow:"0 4px 14px rgba(0,0,0,0.5)",display:"block" }}/>
              <div style={{ fontSize:10,color:"#e2e8f0",fontWeight:600,lineHeight:1.3,marginBottom:2 }}>{c.nom}</div>
              <div style={{ fontSize:9,color:"#475569",marginBottom:4 }}>×{c.nb}</div>
              <span style={{ background:`${deck.couleur}20`,color:deck.couleur,fontSize:8,padding:"1px 7px",borderRadius:6,fontWeight:700 }}>{c.rarete}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ModalAjout({ onFermer, onAjouter }) {
  const [sel,    setSel]    = useState(null);
  const [terme,  setTerme]  = useState("");
  const [res,    setRes]    = useState([]);
  const [loadS,  setLoadS]  = useState(false);
  const [errApi, setErrApi] = useState(null);
  const [form,   setForm]   = useState({ grade:"RAW", prixAchat:"", quantite:"1", etat:"Quasi Parfaite", foil:false });
  const debounceRef = useRef(null);
  const mob = window.innerWidth < 768;
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const chercher = t => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!t || t.length < 2) { setRes([]); setErrApi(null); return; }
    debounceRef.current = setTimeout(async () => {
      setLoadS(true); setErrApi(null);
      try {
        const r = await fetch(`${TCGDEX}/cards?name=${encodeURIComponent(t)}&pagination:page=1&pagination:itemsPerPage=12`);
        if (r.ok) {
          const d = await r.json();
          setRes(Array.isArray(d) ? d : []);
        } else {
          setErrApi(`Erreur API : ${r.status}`);
        }
      } catch {
        setErrApi("Impossible de joindre TCGdex. Vérifiez votre connexion.");
      }
      setLoadS(false);
    }, 350);
  };

  const valider = () => {
    if (!form.prixAchat || !sel) return;
    onAjouter({
      id: Date.now(),
      tcgId:     sel.id,
      nom:       sel.name,
      extension: sel.set?.name || "",
      numero:    sel.localId  || "",
      grade:     form.grade,
      etat:      form.etat,
      prixAchat: +form.prixAchat,
      quantite:  +form.quantite || 1,
      foil:      form.foil,
      rarete:    sel.rarity || "Rare",
      // Bug fix: utilisation correcte du champ image TCGdex
      img: sel.image ? `${sel.image}/high.webp` : null,
      dateAjout: new Date().toISOString().split("T")[0],
    });
    onFermer();
  };

  const inp = { background:"#0a0e17",border:"1px solid #2a3346",borderRadius:8,padding:"9px 12px",color:"#e2e8f0",fontSize:12,width:"100%",boxSizing:"border-box",outline:"none" };
  const lbl = { fontSize:9,color:"#64748b",marginBottom:4,display:"block",letterSpacing:"0.06em" };

  return (
    <div onClick={onFermer} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:1000,display:"flex",alignItems:mob?"flex-end":"center",justifyContent:"center",backdropFilter:"blur(8px)" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#131820",border:"1px solid #2a3346",borderRadius:mob?"20px 20px 0 0":"18px",padding:mob?"18px 16px 32px":"24px",width:mob?"100%":"540px",maxWidth:"100vw",maxHeight:mob?"92vh":"88vh",overflow:"auto",boxShadow:"0 30px 90px rgba(0,0,0,0.7)" }}>
        <div style={{ fontSize:14,fontWeight:700,color:"#e2e8f0",marginBottom:14 }}>➕ Ajouter une carte</div>
        <div style={{ marginBottom:12 }}>
          <input style={inp} placeholder="🔍 Rechercher en français (ex: Dracaufeu, Pikachu…)" value={terme}
            onChange={e => { setTerme(e.target.value); chercher(e.target.value); }}/>
          <div style={{ fontSize:9,color:"#475569",marginTop:4 }}>Base TCGdex — noms et images 🇫🇷</div>
          {errApi && <div style={{ fontSize:10,color:"#ef4444",marginTop:6 }}>⚠ {errApi}</div>}
        </div>
        {loadS && <div style={{ textAlign:"center",padding:16,color:"#475569",fontSize:11 }}>Recherche dans TCGdex FR…</div>}
        {res.length > 0 && (
          <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12,maxHeight:260,overflowY:"auto" }}>
            {res.map(c => (
              <div key={c.id} onClick={() => setSel(c)}
                style={{ background:sel?.id===c.id?"#00e5a010":"#0a0e17",border:`1px solid ${sel?.id===c.id?"#00e5a040":"#1e2a3a"}`,borderRadius:8,padding:8,cursor:"pointer",textAlign:"center",transition:"all 0.15s" }}>
                {/* Bug fix: bon format URL image depuis résultat liste */}
                <CardImg src={c.image ? `${c.image}/low.webp` : null} alt={c.name}
                  style={{ width:"100%",borderRadius:5,marginBottom:4 }}/>
                <div style={{ fontSize:10,color:"#e2e8f0",fontWeight:600,lineHeight:1.3 }}>{c.name}</div>
                <div style={{ fontSize:8,color:"#475569" }}>{c.set?.name || ""}</div>
              </div>
            ))}
          </div>
        )}
        {sel && (
          <div style={{ display:"flex",gap:12,background:"#0a0e17",borderRadius:10,padding:12,marginBottom:14,border:"1px solid #00e5a030" }}>
            <CardImg src={sel.image ? `${sel.image}/low.webp` : null} alt={sel.name}
              style={{ width:58,borderRadius:6,flexShrink:0 }}/>
            <div>
              <div style={{ fontSize:12,fontWeight:700,color:"#e2e8f0" }}>{sel.name}</div>
              <div style={{ fontSize:10,color:"#475569" }}>{sel.set?.name} · {sel.localId}</div>
              <div style={{ fontSize:9,color:"#00e5a0",marginTop:3 }}>✅ Sélectionnée — Image TCGdex FR</div>
            </div>
          </div>
        )}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14 }}>
          <div><label style={lbl}>PRIX D'ACHAT (€) *</label><input style={inp} type="number" step="0.01" min="0" placeholder="0,00" value={form.prixAchat} onChange={e=>setForm(f=>({...f,prixAchat:e.target.value}))}/></div>
          <div><label style={lbl}>QUANTITÉ</label><input style={inp} type="number" min="1" value={form.quantite} onChange={e=>setForm(f=>({...f,quantite:e.target.value}))}/></div>
          <div><label style={lbl}>GRADE</label>
            <select style={inp} value={form.grade} onChange={e=>setForm(f=>({...f,grade:e.target.value}))}>
              {["RAW","PSA 10","PSA 9","PSA 8","PSA 7","PSA 6","CGC 10","CGC 9.5","BGS 10"].map(g=><option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div><label style={lbl}>ÉTAT</label>
            <select style={inp} value={form.etat} onChange={e=>setForm(f=>({...f,etat:e.target.value}))}>
              {["Quasi Parfaite","Légèrement Jouée","Moyennement Jouée","Très Jouée","Pauvre"].map(e=><option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:8,gridColumn:"1/-1" }}>
            <input type="checkbox" id="foil_check" checked={form.foil} onChange={e=>setForm(f=>({...f,foil:e.target.checked}))}
              style={{ width:16,height:16,accentColor:"#00e5a0",cursor:"pointer" }}/>
            <label htmlFor="foil_check" style={{ ...lbl,margin:0,cursor:"pointer",color:"#94a3b8",fontSize:11 }}>Carte Holo / Foil</label>
          </div>
        </div>
        <div style={{ display:"flex",gap:8 }}>
          <button onClick={onFermer} style={{ flex:1,background:"#1e2a3a",border:"1px solid #2a3346",color:"#94a3b8",padding:9,borderRadius:8,cursor:"pointer",fontSize:11 }}>Annuler</button>
          <button onClick={valider} disabled={!form.prixAchat || !sel}
            style={{ flex:2,background:(form.prixAchat&&sel)?"linear-gradient(135deg,#00e5a0,#00b4d8)":"#1e2a3a",border:"none",color:(form.prixAchat&&sel)?"#0d1117":"#475569",padding:9,borderRadius:8,cursor:(form.prixAchat&&sel)?"pointer":"not-allowed",fontSize:11,fontWeight:700 }}>
            ✅ Ajouter à la collection
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  VUE BASE DE DONNÉES
// ═══════════════════════════════════════════════════════════════════
function VueBD() {
  const [sets,       setSets]       = useState([]);
  const [setActif,   setSetActif]   = useState(null);
  const [cartesBD,   setCartesBD]   = useState([]);
  const [syncing,    setSyncing]     = useState(false);
  const [progress,   setProgress]   = useState({ done:0, total:0 });
  const [log,        setLog]         = useState([]);
  const [totalBD,    setTotalBD]     = useState(0);
  const [loadingSet, setLoadingSet]  = useState(false);
  const [filtre,     setFiltre]      = useState("");
  const [filtreSet,  setFiltreSet]   = useState("");
  const [syncedSets, setSyncedSets]  = useState({});
  const [vue,        setVue]         = useState("sets");
  const [errSets,    setErrSets]     = useState(null);

  useEffect(() => {
    chargerSets();
    dbCount("cartes").then(setTotalBD);
    dbGetAll("meta").then(metas => {
      const s = {};
      metas.filter(m => m.key?.startsWith("sync_")).forEach(m => { s[m.key.replace("sync_","")] = { ts:m.ts, count:m.count }; });
      setSyncedSets(s);
    });
  }, []);

  const chargerSets = async () => {
    setErrSets(null);
    const local = await dbGetAll("sets");
    if (local.length) { setSets(local); return; }
    try {
      const r = await fetch(`${TCGDEX}/sets`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setSets(d);
      await dbPut("sets", d.map(s => ({ ...s, _ts: Date.now() })));
    } catch (e) {
      setErrSets(`Impossible de charger les extensions TCGdex: ${e.message}`);
    }
  };

  const voirCartes = async set => {
    setSetActif(set); setLoadingSet(true); setCartesBD([]); setVue("cartes"); setFiltre("");
    const local = await dbByIndex("cartes", "setId", set.id);
    if (local.length) { setCartesBD(local); setLoadingSet(false); return; }
    try {
      const r = await fetch(`${TCGDEX}/sets/${set.id}`);
      if (r.ok) {
        const d = await r.json();
        // Bug fix: construire imgHigh correctement depuis card.image
        const cards = (d.cards || []).map(c => ({
          ...c, setId: set.id,
          imgHigh: c.image ? `${c.image}/high.webp` : null,
          imgLow:  c.image ? `${c.image}/low.webp`  : null,
        }));
        setCartesBD(cards);
      }
    } catch {}
    setLoadingSet(false);
  };

  const lancerSync = async set => {
    setSyncing(true); setProgress({ done:0, total:0 });
    setLog(l => [`▶ Synchronisation de "${set.name}"…`, ...l]);
    try {
      const nb = await syncSet(set.id, (done, total) => {
        setProgress({ done, total });
        if (done % 10 === 0) setLog(l => [`  ${done}/${total} cartes OK`, ...l.slice(0,14)]);
      });
      setSyncedSets(s => ({ ...s, [set.id]: { ts:Date.now(), count:nb } }));
      setLog(l => [`✅ "${set.name}" — ${nb} cartes dans IndexedDB`, ...l]);
      setTotalBD(await dbCount("cartes"));
    } catch (e) {
      setLog(l => [`❌ Erreur: ${e.message}`, ...l]);
    }
    setSyncing(false);
  };

  const viderBD = async () => {
    await Promise.all([dbClear("cartes"), dbClear("sets"), dbClear("meta")]);
    setSyncedSets({}); setTotalBD(0); setCartesBD([]); setSetActif(null);
    setLog(["🗑️ Base de données vidée"]);
    setSets([]);
    chargerSets();
  };

  const cartesFiltrees = filtre
    ? cartesBD.filter(c => (c.name||"").toLowerCase().includes(filtre.toLowerCase()))
    : cartesBD;

  const S = { card:{ background:"#0b0f18",border:"1px solid #1a2332",borderRadius:12 } };

  // Grouper sets par série (avec filtre)
  const setsFiltres = filtreSet
    ? sets.filter(s => s.name?.toLowerCase().includes(filtreSet.toLowerCase()) || s.serie?.name?.toLowerCase().includes(filtreSet.toLowerCase()))
    : sets;

  const parSerie = setsFiltres.reduce((acc, s) => {
    const k = s.serie?.name || "Autres";
    if (!acc[k]) acc[k] = [];
    acc[k].push(s);
    return acc;
  }, {});

  return (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:20 }}>
        <div>
          <div style={{ fontSize:20,fontWeight:700,color:"#e2e8f0" }}>🗄️ Base de Données Cartes FR</div>
          <div style={{ fontSize:10,color:"#3d5068",marginTop:2 }}>TCGdex API · Images HD · Persistance IndexedDB · Français natif</div>
        </div>
        <div style={{ display:"flex",gap:8,alignItems:"center" }}>
          <div style={{ background:"#00e5a015",border:"1px solid #00e5a030",borderRadius:8,padding:"6px 12px" }}>
            <span style={{ fontSize:9,color:"#3d5068" }}>BD locale </span>
            <span style={{ fontSize:13,fontWeight:700,color:"#00e5a0" }}>{totalBD.toLocaleString("fr-FR")}</span>
            <span style={{ fontSize:9,color:"#3d5068" }}> cartes</span>
          </div>
          {[["sets","📦 Extensions"],["cartes","🃏 Cartes"],["sync","⚙️ Sync"]].map(([id,lbl]) => (
            <button key={id} onClick={() => setVue(id)} style={{ background:vue===id?"#00e5a018":"#1a2332",border:`1px solid ${vue===id?"#00e5a040":"#2a3346"}`,color:vue===id?"#00e5a0":"#475569",padding:"6px 12px",borderRadius:8,cursor:"pointer",fontSize:10,fontWeight:700 }}>{lbl}</button>
          ))}
        </div>
      </div>

      {errSets && <div style={{ background:"#ef444415",border:"1px solid #ef444430",borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:11,color:"#ef4444" }}>⚠ {errSets}</div>}

      {vue === "sets" && (
        <div>
        <input style={{ width:"100%",background:"#0b0f18",border:"1px solid #1a2332",borderRadius:8,padding:"8px 14px",color:"#e2e8f0",fontSize:11,outline:"none",marginBottom:14 }}
          placeholder="🔍 Filtrer les extensions…" value={filtreSet} onChange={e => setFiltreSet(e.target.value)}/>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12 }}>
          {Object.entries(parSerie).map(([serie, exts]) => (
            <div key={serie} style={{ gridColumn:"1/-1" }}>
              <div style={{ fontSize:9,color:"#475569",fontWeight:700,letterSpacing:"0.1em",marginBottom:10,paddingBottom:6,borderBottom:"1px solid #1a2332" }}>{serie.toUpperCase()}</div>
              <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))",gap:10 }}>
                {exts.map(s => {
                  const synced = syncedSets[s.id];
                  return (
                    <div key={s.id} style={{ background:"#0b0f18",border:`1px solid ${synced?"#00e5a030":"#1a2332"}`,borderRadius:10,padding:14,transition:"all 0.2s" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor="#00e5a050"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = synced?"#00e5a030":"#1a2332"}>
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8 }}>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:11,fontWeight:700,color:"#e2e8f0",lineHeight:1.3,marginBottom:2 }}>{s.name}</div>
                          <div style={{ fontSize:9,color:"#3d5068" }}>{s.cardCount?.total || s.cardCount?.official || "?"} cartes · {s.releaseDate?.split("-")[0]}</div>
                        </div>
                        {synced && <span style={{ fontSize:8,background:"#00e5a020",color:"#00e5a0",padding:"1px 6px",borderRadius:4,marginLeft:6,flexShrink:0 }}>✅{synced.count}</span>}
                      </div>
                      <div style={{ display:"flex",gap:6 }}>
                        <button onClick={() => voirCartes(s)} style={{ flex:1,background:"#1a2332",border:"1px solid #2a3346",color:"#94a3b8",padding:5,borderRadius:6,cursor:"pointer",fontSize:9 }}>Voir</button>
                        <button onClick={() => lancerSync(s)} disabled={syncing}
                          style={{ background:synced?"#00e5a010":"linear-gradient(135deg,#00e5a0,#00b4d8)",border:"none",color:synced?"#00e5a0":"#0d1117",padding:"5px 8px",borderRadius:6,cursor:syncing?"not-allowed":"pointer",fontSize:9,fontWeight:700 }}>
                          {synced ? "↻" : "💾 Sync"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {Object.keys(parSerie).length === 0 && filtreSet && (
          <div style={{ textAlign:"center",padding:40,color:"#475569",fontSize:12 }}>Aucune extension ne correspond à "{filtreSet}"</div>
        )}
        </div>
      )}

      {vue === "cartes" && (
        <div>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
            <div>
              <button onClick={() => { setVue("sets"); setSetActif(null); }} style={{ background:"#1a2332",border:"1px solid #2a3346",color:"#94a3b8",padding:"5px 10px",borderRadius:6,cursor:"pointer",fontSize:10,marginRight:10 }}>← Retour</button>
              <span style={{ fontSize:14,fontWeight:700,color:"#e2e8f0" }}>{setActif?.name}</span>
              <span style={{ fontSize:10,color:"#3d5068",marginLeft:8 }}>{cartesBD.length} cartes · TCGdex FR</span>
            </div>
            <input style={{ background:"#0b0f18",border:"1px solid #1a2332",borderRadius:8,padding:"6px 12px",color:"#e2e8f0",fontSize:11,outline:"none",width:200 }}
              placeholder="🔍 Filtrer…" value={filtre} onChange={e => setFiltre(e.target.value)}/>
          </div>
          {loadingSet && <div style={{ textAlign:"center",padding:40,color:"#475569" }}>Chargement TCGdex FR…</div>}
          {!setActif && !loadingSet && <div style={{ textAlign:"center",padding:40,color:"#475569",fontSize:12 }}>← Sélectionnez une extension</div>}
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",gap:10,maxHeight:"68vh",overflowY:"auto" }}>
            {cartesFiltrees.map((c, i) => (
              <div key={c.id || i} style={{ background:"#0a0e17",borderRadius:8,border:"1px solid #1a2332",padding:8,textAlign:"center",cursor:"pointer",transition:"all 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor="#00e5a040"; e.currentTarget.style.transform="translateY(-2px)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor="#1a2332";   e.currentTarget.style.transform="translateY(0)"; }}>
                {/* Bug fix: utiliser imgLow ou construire depuis image directement */}
                <CardImg
                  src={c.imgLow || (c.image ? `${c.image}/low.webp` : null)}
                  alt={c.name}
                  style={{ width:"100%",borderRadius:5,marginBottom:5,display:"block" }}/>
                <div style={{ fontSize:9,color:"#e2e8f0",fontWeight:600,lineHeight:1.3,marginBottom:1 }}>{c.name}</div>
                <div style={{ fontSize:8,color:"#3d5068" }}>{c.localId || "—"}</div>
                {c.rarity && <div style={{ fontSize:7,color:"#475569",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{c.rarity}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {vue === "sync" && (
        <div style={{ display:"grid",gridTemplateColumns:"1fr",gap:16 }}>
          <div>
            <div style={{ ...S.card,padding:20,marginBottom:14 }}>
              <div style={{ fontSize:11,color:"#e2e8f0",fontWeight:700,marginBottom:12 }}>🗄️ État de la base IndexedDB</div>
              {[
                ["Cartes indexées",      totalBD.toLocaleString("fr-FR"), "#00e5a0"],
                ["Extensions dispo.",    sets.length,                     "#00b4d8"],
                ["Extensions synchro.",  Object.keys(syncedSets).length,  "#a78bfa"],
                ["Source API",           "TCGdex FR (api.tcgdex.net)",    "#f59e0b"],
                ["Persistance",          "IndexedDB (local navigateur)",   "#94a3b8"],
              ].map(([l,v,c]) => (
                <div key={l} style={{ display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #1a2332" }}>
                  <span style={{ fontSize:10,color:"#64748b" }}>{l}</span>
                  <span style={{ fontSize:11,fontWeight:700,color:c }}>{v}</span>
                </div>
              ))}
            </div>
            {syncing && progress.total > 0 && (
              <div style={{ marginBottom:12 }}>
                <div style={{ display:"flex",justifyContent:"space-between",fontSize:9,color:"#475569",marginBottom:4 }}>
                  <span>Synchronisation en cours…</span>
                  <span>{progress.done}/{progress.total}</span>
                </div>
                <div style={{ height:4,background:"#1a2332",borderRadius:2,overflow:"hidden" }}>
                  <div style={{ width:`${progress.total?Math.round(progress.done/progress.total*100):0}%`,height:"100%",background:"linear-gradient(90deg,#00e5a0,#00b4d8)",transition:"width 0.3s",borderRadius:2 }}/>
                </div>
              </div>
            )}
            <div style={{ display:"flex",gap:8 }}>
              <button onClick={viderBD} style={{ flex:1,background:"#1a2332",border:"1px solid #ef444440",color:"#ef4444",padding:10,borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:700 }}>🗑️ Vider BD</button>
              <button onClick={chargerSets} disabled={syncing} style={{ flex:2,background:"linear-gradient(135deg,#00e5a0,#00b4d8)",border:"none",color:"#0d1117",padding:10,borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:700 }}>↻ Recharger les sets</button>
            </div>
          </div>
          <div style={{ ...S.card,padding:16 }}>
            <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:10 }}>JOURNAL</div>
            <div style={{ fontFamily:"monospace",fontSize:10,lineHeight:1.8,maxHeight:340,overflowY:"auto" }}>
              {log.length === 0
                ? <span style={{ color:"#3d5068" }}>Aucune opération en cours…</span>
                : log.map((l, i) => (
                  <div key={i} style={{ color: l.startsWith("✅")?"#00e5a0":l.startsWith("▶")?"#00b4d8":l.startsWith("🏁")?"#a78bfa":l.startsWith("❌")?"#ef4444":l.startsWith("🗑️")?"#f59e0b":"#64748b" }}>{l}</div>
                ))
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  APPLICATION PRINCIPALE
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [onglet,  setOnglet]  = useState("tableau");
  const [col,     setCol]     = useState(() => lsGet(LS_COL, COL_INIT));
  const [wl,      setWl]      = useState(() => lsGet(LS_WL,  WL_INIT));
  const [carte,   setCarte]   = useState(null);
  const [deckSel, setDeckSel] = useState(null);
  const [ajout,   setAjout]   = useState(false);
  const [rech,    setRech]    = useState("");
  const [tri,     setTri]     = useState("rendement");
  const [fg,      setFg]      = useState("tous");
  const [tierFil, setTierFil] = useState("tous");
  const [toast,   setToast]   = useState(null);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  const showToast = msg => { setToast(msg); };

  const supprimerCarte = id => {
    setCol(p => p.filter(c => c.id !== id));
    showToast("🗑️ Carte supprimée de la collection");
  };

  const modifierCarte = (id, changes) => {
    setCol(p => p.map(c => c.id === id ? { ...c, ...changes } : c));
    showToast("✅ Carte mise à jour");
  };

  const ajouterCarte = c => {
    setCol(p => [...p, c]);
    showToast("✅ Carte ajoutée à la collection");
  };

  useEffect(() => lsSave(LS_COL, col), [col]);
  useEffect(() => lsSave(LS_WL,  wl),  [wl]);

  const ids = [...col.map(c => c.tcgId), ...wl.map(w => w.tcgId)].filter(Boolean);
  const { prix, load, maj, actualiser } = usePrix(ids);
  const gp  = c => prix?.[c.tcgId]?.trend ?? c.prixAchat;

  const investi = col.reduce((s, c) => s + c.prixAchat * c.quantite, 0);
  const actuel  = col.reduce((s, c) => s + gp(c) * c.quantite, 0);
  const gain    = actuel - investi;
  const r       = investi > 0 ? ((gain / investi) * 100).toFixed(1) : "0.0";
  const gag     = col.filter(c => gp(c) > c.prixAchat).length;
  const perd    = col.filter(c => gp(c) < c.prixAchat).length;
  const best    = [...col].sort((a, b) => +rend(b.prixAchat, gp(b)) - +rend(a.prixAchat, gp(a)))[0];

  const filtree = col
    .filter(c => c.nom.toLowerCase().includes(rech.toLowerCase()) || c.extension.toLowerCase().includes(rech.toLowerCase()))
    .filter(c => fg === "tous" || (fg === "gradees" ? c.grade !== "RAW" : c.grade === fg))
    .sort((a, b) =>
      tri === "rendement" ? +rend(b.prixAchat,gp(b)) - +rend(a.prixAchat,gp(a)) :
      tri === "valeur"    ? gp(b)*b.quantite - gp(a)*a.quantite :
      a.nom.localeCompare(b.nom, "fr")
    );

  const decksFil = tierFil === "tous" ? DECKS : DECKS.filter(d => d.tier === tierFil);

  const S = {
    app:  { fontFamily:"'IBM Plex Mono',monospace", background:"#080c12", minHeight:"100vh", color:"#e2e8f0" },
    sb:   { width:215, background:"#0b0f18", borderRight:"1px solid #1a2332", display:"flex", flexDirection:"column", padding:"20px 0", flexShrink:0 },
    nav:  a => ({ display:"flex",alignItems:"center",gap:10,padding:"10px 22px",cursor:"pointer",fontSize:11,fontWeight:600,letterSpacing:"0.06em",color:a?"#00e5a0":"#3d5068",background:a?"#00e5a008":"transparent",borderLeft:a?"2px solid #00e5a0":"2px solid transparent",transition:"all 0.2s" }),
    main: { flex:1, overflow:"auto", padding: isMobile ? "16px 14px" : 24, paddingBottom: isMobile ? 74 : 24 },
    card: { background:"#0b0f18", border:"1px solid #1a2332", borderRadius:12 },
    kpi:  acc => ({ background:"#0b0f18",border:"1px solid #1a2332",borderRadius:12,padding:"16px 18px",borderTop:`2px solid ${acc}` }),
    th:   { padding:"9px 14px",textAlign:"left",fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",borderBottom:"1px solid #1a2332" },
    td:   { padding:"11px 14px",fontSize:11,borderBottom:"1px solid #0b0f18",color:"#94a3b8",verticalAlign:"middle" },
    bdg:  c => ({ background:`${c}18`,color:c,padding:"2px 8px",borderRadius:8,fontSize:10,fontWeight:700,display:"inline-block" }),
    btn:  v => ({ background:v==="p"?"linear-gradient(135deg,#00e5a0,#00b4d8)":"#1a2332",border:v==="p"?"none":"1px solid #2a3346",color:v==="p"?"#0d1117":"#94a3b8",padding:"7px 14px",borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:700 }),
    inp:  { background:"#0b0f18",border:"1px solid #1a2332",borderRadius:8,padding:"7px 12px",color:"#e2e8f0",fontSize:11,outline:"none" },
  };

  const Tableau = () => {
    const dd = [
      { label:"Gradées", val:col.filter(c=>c.grade!=="RAW").reduce((s,c)=>s+gp(c)*c.quantite,0), col:"#00e5a0" },
      { label:"RAW",     val:col.filter(c=>c.grade==="RAW").reduce((s,c)=>s+gp(c)*c.quantite,0), col:"#00b4d8" },
    ];
    const tend = col.filter(c => prix[c.tcgId]?.histo).slice(0, 3).map(c => ({
      nom:c.nom, h:prix[c.tcgId].histo, px:gp(c), pct:+rend(prix[c.tcgId].histo[0]||c.prixAchat, gp(c))
    }));
    return (
      <div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:20 }}>
          <div>
            <div style={{ fontSize:20,fontWeight:700,color:"#e2e8f0",letterSpacing:"-0.02em" }}>Tableau de bord</div>
            <div style={{ fontSize:10,color:"#3d5068",marginTop:2 }}>Portefeuille Pokémon 🇫🇷 · TCGdex + CardMarket FR</div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <SrcBadge src="CardMarket FR" load={load}/>
            <button onClick={actualiser} style={S.btn("s")}>↻ Actualiser</button>
          </div>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:isMobile?"repeat(2,1fr)":"repeat(4,1fr)",gap:isMobile?10:14,marginBottom:isMobile?12:18 }}>
          {[
            { label:"VALEUR PORTEFEUILLE", val:eur(actuel),                        sub:"prix CardMarket FR",                                          acc:"#00e5a0" },
            { label:"P&L TOTAL",           val:`${gain>=0?"+":""}${eur(gain)}`,     sub:`${r}% rendement`,                                            acc:gain>=0?"#00e5a0":"#ef4444" },
            { label:"TOTAL INVESTI",       val:eur(investi),                        sub:`${col.length} cartes · ${col.reduce((s,c)=>s+c.quantite,0)} copies`, acc:"#00b4d8" },
            { label:"WIN RATE",            val:`${gag+perd>0?Math.round(gag/(gag+perd)*100):0}%`, sub:`${gag} haussières · ${perd} baissières`,       acc:"#a78bfa" },
          ].map((k, i) => (
            <div key={i} style={S.kpi(k.acc)}>
              <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:8 }}>{k.label}</div>
              <div style={{ fontSize:19,fontWeight:700,color:k.label==="P&L TOTAL"?(gain>=0?"#00e5a0":"#ef4444"):"#e2e8f0",marginBottom:3 }}>{k.val}</div>
              <div style={{ fontSize:9,color:"#3d5068" }}>{k.sub}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr":"1.1fr 1fr 1fr",gap:isMobile?10:14 }}>
          <div style={{ ...S.card,padding:18 }}>
            <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>RÉPARTITION</div>
            <div style={{ display:"flex",alignItems:"center",gap:14 }}>
              <Donut data={dd} total={actuel}/>
              <div>{dd.map((d,i) => (
                <div key={i} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10 }}>
                  <div style={{ width:7,height:7,borderRadius:"50%",background:d.col }}/>
                  <div>
                    <div style={{ fontSize:10,color:"#94a3b8" }}>{d.label}</div>
                    <div style={{ fontSize:12,fontWeight:700,color:"#e2e8f0" }}>{eur(d.val)}</div>
                    <div style={{ fontSize:9,color:"#3d5068" }}>{actuel>0?((d.val/actuel)*100).toFixed(1):0}%</div>
                  </div>
                </div>
              ))}</div>
            </div>
          </div>
          <div style={{ ...S.card,padding:18 }}>
            <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>MEILLEURE PERFORMANCE</div>
            {best ? (() => {
              const p = gp(best), gain_b = p - best.prixAchat, rv = rend(best.prixAchat, p), pos = gain_b >= 0;
              return (
                <div>
                  <div onClick={() => setCarte(best)} style={{ display:"flex",gap:10,marginBottom:10,cursor:"pointer" }}
                    onMouseEnter={e => e.currentTarget.style.opacity="0.8"}
                    onMouseLeave={e => e.currentTarget.style.opacity="1"}>
                    <CardImg src={best.img} fallback={ioImg(best.tcgId)} alt="" style={{ width:44,borderRadius:5 }}/>
                    <div>
                      <div style={{ fontSize:10,fontWeight:700,color:"#e2e8f0",lineHeight:1.3 }}>{best.nom}</div>
                      <div style={{ fontSize:9,color:"#3d5068",marginTop:1 }}>{best.extension}</div>
                      <div style={{ marginTop:4 }}><span style={S.bdg(best.grade==="PSA 10"||best.grade==="CGC 10"?"#00e5a0":best.grade.startsWith("PSA")||best.grade.startsWith("CGC")?"#f59e0b":"#64748b")}>{best.grade}</span></div>
                    </div>
                  </div>
                  {[["Achat",eur(best.prixAchat),"#64748b"],["Actuel",eur(p),"#e2e8f0"],["P&L",`${pos?"+":""}${eur(gain_b)}`,pos?"#00e5a0":"#ef4444"],["Rend.",`${pos?"+":""}${rv}%`,pos?"#00e5a0":"#ef4444"]].map(([l,v,c],i) => (
                    <div key={i} style={{ display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #1a2332" }}>
                      <span style={{ fontSize:9,color:"#3d5068" }}>{l}</span>
                      <span style={{ fontSize:10,fontWeight:700,color:c }}>{v}</span>
                    </div>
                  ))}
                </div>
              );
            })() : <div style={{ fontSize:10,color:"#3d5068",textAlign:"center",padding:"20px 0" }}>Ajoutez des cartes</div>}
          </div>
          <div style={{ ...S.card,padding:18 }}>
            <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>WATCHLIST</div>
            {wl.map(w => {
              const p = prix[w.tcgId]?.trend ?? w.prixCible * 1.1;
              const sig = p <= w.prixCible;
              const ec = (((p - w.prixCible) / w.prixCible) * 100).toFixed(1);
              return (
                <div key={w.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9,paddingBottom:9,borderBottom:"1px solid #1a2332" }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:10,color:"#e2e8f0",fontWeight:600,lineHeight:1.3 }}>{w.nom}</div>
                    <div style={{ fontSize:9,color:"#3d5068" }}>Cible: {eur(w.prixCible)}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:11,fontWeight:700,color:"#e2e8f0" }}>{eur(p)}</div>
                    {sig ? <span style={S.bdg("#00e5a0")}>🎯 ACHAT</span> : <span style={{ fontSize:9,color:+ec>0?"#ef4444":"#00e5a0",fontWeight:700 }}>{+ec>0?"+":""}{ec}%</span>}
                  </div>
                  <button onClick={() => setWl(l => l.filter(x => x.id !== w.id))}
                    style={{ background:"none",border:"none",color:"#3d5068",cursor:"pointer",fontSize:13,marginLeft:6,padding:"0 2px",lineHeight:1 }}
                    title="Retirer de la watchlist">×</button>
                </div>
              );
            })}
            {wl.length === 0 && <div style={{ fontSize:10,color:"#3d5068",textAlign:"center",padding:"10px 0" }}>Watchlist vide</div>}
            <button onClick={() => setOnglet("decks")} style={{ ...S.btn("s"),width:"100%",marginTop:4,fontSize:9 }}>Voir les decks Pocket →</button>
          </div>
        </div>
        {tend.length > 0 && (
          <div style={{ ...S.card,padding:18,marginTop:14 }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
              <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em" }}>TENDANCES CARDMARKET FR (7 JOURS)</div>
              {maj && <span style={{ fontSize:9,color:"#3d5068" }}>Actualisé : {maj.toLocaleTimeString("fr-FR")}</span>}
            </div>
            <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr":`repeat(${tend.length},1fr)`,gap:isMobile?8:14 }}>
              {tend.map((t, i) => (
                <div key={i} style={{ background:"#080c12",borderRadius:8,padding:"12px 14px" }}>
                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}>
                    <div><div style={{ fontSize:10,color:"#e2e8f0",fontWeight:600,marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:isMobile?180:140 }}>{t.nom}</div><div style={{ fontSize:13,fontWeight:700,color:"#e2e8f0" }}>{eur(t.px)}</div></div>
                    <span style={S.bdg(t.pct>=0?"#00e5a0":"#ef4444")}>{t.pct>=0?"+":""}{t.pct}%</span>
                  </div>
                  <Sparkline data={t.h} color={t.pct>=0?"#00e5a0":"#ef4444"} width={isMobile?280:160} height={38}/>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const gradeBadgeColor = g => g==="PSA 10"||g==="CGC 10"?"#00e5a0":g.startsWith("PSA")||g.startsWith("CGC")||g.startsWith("BGS")?"#f59e0b":"#3d5068";

  const exportCSV = () => {
    const rows = [["Nom","Extension","Numéro","Grade","État","Foil","Prix Achat","Prix Actuel","P&L","Rendement %","Quantité","Valeur Totale","Date Ajout"]];
    col.forEach(c => {
      const p = gp(c), g = (p - c.prixAchat) * c.quantite, rv = rend(c.prixAchat, p);
      rows.push([c.nom,c.extension,c.numero,c.grade,c.etat,c.foil?"Oui":"Non",c.prixAchat.toFixed(2),p.toFixed(2),g.toFixed(2),rv,c.quantite,(p*c.quantite).toFixed(2),c.dateAjout]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿"+csv], { type:"text/csv;charset=utf-8" }));
    a.download = `pokeinvest_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  };

  const Collection = () => (
    <div>
      {/* En-tête */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
        <div>
          <div style={{ fontSize:isMobile?17:20,fontWeight:700,color:"#e2e8f0" }}>Ma Collection</div>
          <div style={{ fontSize:10,color:"#3d5068",marginTop:2 }}>{col.length} cartes · {col.reduce((s,c)=>s+c.quantite,0)} copies · {eur(actuel)}</div>
        </div>
        <div style={{ display:"flex",gap:6,alignItems:"center" }}>
          {!isMobile && <SrcBadge src="CardMarket FR" load={load}/>}
          {!isMobile && <button onClick={exportCSV} style={{ ...S.btn("s"),fontSize:10 }}>📥 CSV</button>}
          <button onClick={() => setAjout(true)} style={{ ...S.btn("p"),padding:isMobile?"9px 14px":"7px 14px" }}>+ Ajouter</button>
        </div>
      </div>

      {/* Filtres */}
      <div style={{ display:"flex",gap:8,marginBottom:12,flexWrap:"wrap" }}>
        <input style={{ ...S.inp,flex:1,minWidth:120 }} placeholder="🔍 Rechercher…" value={rech} onChange={e=>setRech(e.target.value)}/>
        {!isMobile && (
          <select style={S.inp} value={fg} onChange={e=>setFg(e.target.value)}>
            <option value="tous">Tous grades</option>
            <option value="gradees">Gradées</option>
            {["PSA 10","PSA 9","PSA 8","PSA 7","RAW"].map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <select style={S.inp} value={tri} onChange={e=>setTri(e.target.value)}>
          <option value="rendement">↓ Rendement</option>
          <option value="valeur">↓ Valeur</option>
          <option value="nom">A–Z Nom</option>
        </select>
      </div>

      {/* VUE MOBILE — tiles */}
      {isMobile ? (
        <div>
          {filtree.map(c => {
            const p = gp(c), g = (p - c.prixAchat) * c.quantite, rv = rend(c.prixAchat, p), pos = g >= 0;
            return (
              <div key={c.id} onClick={() => setCarte(c)}
                style={{ background:"#0b0f18",border:"1px solid #1a2332",borderRadius:12,padding:12,marginBottom:10,display:"flex",gap:12,cursor:"pointer",WebkitTapHighlightColor:"transparent" }}>
                <div style={{ position:"relative",flexShrink:0 }}>
                  <CardImg src={c.img} fallback={ioImg(c.tcgId)} alt="" style={{ width:52,borderRadius:6,display:"block" }}/>
                  {c.grade !== "RAW" && (
                    <div style={{ position:"absolute",bottom:-5,left:"50%",transform:"translateX(-50%)",background:gradeBadgeColor(c.grade),color:"#0d1117",fontSize:7,fontWeight:800,padding:"1px 6px",borderRadius:4,whiteSpace:"nowrap" }}>{c.grade}</div>
                  )}
                </div>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:3 }}>
                    <div style={{ fontSize:12,fontWeight:700,color:"#e2e8f0",lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"70%" }}>{c.nom}</div>
                    <span style={{ fontSize:12,fontWeight:700,color:pos?"#00e5a0":"#ef4444",flexShrink:0,marginLeft:6 }}>{pos?"+":""}{rv}%</span>
                  </div>
                  <div style={{ fontSize:9,color:"#3d5068",marginBottom:8 }}>{c.extension} · {c.grade === "RAW" ? <span style={{ color:"#3d5068" }}>RAW</span> : null}</div>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                    <div>
                      <span style={{ fontSize:11,fontWeight:700,color:pos?"#00e5a0":"#ef4444" }}>{pos?"+":""}{eur(g)}</span>
                      <span style={{ fontSize:9,color:"#3d5068",marginLeft:4 }}>{eur(c.prixAchat)}→{eur(p)}</span>
                    </div>
                    <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                      <button onClick={e=>{e.stopPropagation();if(c.quantite>1)modifierCarte(c.id,{quantite:c.quantite-1});}}
                        style={{ background:"#1a2332",border:"1px solid #2a3346",color:"#94a3b8",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",WebkitTapHighlightColor:"transparent" }}>−</button>
                      <span style={{ fontSize:10,color:"#a78bfa",fontWeight:600 }}>×{c.quantite}</span>
                      <button onClick={e=>{e.stopPropagation();modifierCarte(c.id,{quantite:c.quantite+1});}}
                        style={{ background:"#1a2332",border:"1px solid #2a3346",color:"#94a3b8",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",WebkitTapHighlightColor:"transparent" }}>+</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {filtree.length === 0 && (
            <div style={{ textAlign:"center",padding:40,color:"#475569",fontSize:12 }}>
              {col.length === 0 ? "Collection vide — ajoutez votre première carte !" : "Aucune carte ne correspond aux filtres"}
            </div>
          )}
        </div>
      ) : (
        /* VUE DESKTOP — table */
        <div style={S.card}>
          <table style={{ width:"100%",borderCollapse:"collapse" }}>
            <thead><tr>{["CARTE","GRADE","ACHAT","CARDMARKET FR","P&L","REND.","VALEUR TOTALE","HIST. 7J",""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {filtree.map(c => {
                const p = gp(c), g = (p - c.prixAchat) * c.quantite, rv = rend(c.prixAchat, p), pos = g >= 0, h = prix[c.tcgId]?.histo;
                return (
                  <tr key={c.id} onClick={() => setCarte(c)} style={{ cursor:"pointer" }}
                    onMouseEnter={e => e.currentTarget.style.background="#ffffff04"}
                    onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                    <td style={S.td}>
                      <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                        <CardImg src={c.img} fallback={ioImg(c.tcgId)} alt="" style={{ width:30,height:42,objectFit:"cover",borderRadius:3 }}/>
                        <div>
                          <div style={{ color:"#e2e8f0",fontWeight:600,fontSize:11,lineHeight:1.3 }}>{c.nom}</div>
                          <div style={{ color:"#3d5068",fontSize:9 }}>{c.extension} · {c.numero}</div>
                        </div>
                      </div>
                    </td>
                    <td style={S.td}><span style={S.bdg(gradeBadgeColor(c.grade))}>{c.grade}</span></td>
                    <td style={S.td}>{eur(c.prixAchat)}</td>
                    <td style={S.td}><div style={{ fontWeight:700,color:"#e2e8f0",fontSize:12 }}>{eur(p)}</div>{prix[c.tcgId] && <div style={{ fontSize:8,color:"#3d5068" }}>Bas: {eur(prix[c.tcgId].low)}</div>}</td>
                    <td style={{ ...S.td,color:pos?"#00e5a0":"#ef4444",fontWeight:700 }}>{pos?"+":""}{eur(g)}</td>
                    <td style={S.td}><span style={{ color:pos?"#00e5a0":"#ef4444",fontWeight:700 }}>{pos?"+":""}{rv}%</span></td>
                    <td style={{ ...S.td,color:"#a78bfa",fontWeight:600 }}>
                      <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                        <button onClick={e=>{e.stopPropagation();if(c.quantite>1)modifierCarte(c.id,{quantite:c.quantite-1});}} style={{ background:"#1a2332",border:"1px solid #2a3346",color:"#94a3b8",width:18,height:18,borderRadius:4,cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,lineHeight:1 }}>−</button>
                        <span>{eur(p*c.quantite)} <span style={{ color:"#3d5068",fontWeight:400 }}>×{c.quantite}</span></span>
                        <button onClick={e=>{e.stopPropagation();modifierCarte(c.id,{quantite:c.quantite+1});}} style={{ background:"#1a2332",border:"1px solid #2a3346",color:"#94a3b8",width:18,height:18,borderRadius:4,cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,lineHeight:1 }}>+</button>
                      </div>
                    </td>
                    <td style={S.td}>{h && <Sparkline data={h} color={pos?"#00e5a0":"#ef4444"} width={62} height={24}/>}</td>
                    <td style={S.td}><button onClick={e=>{e.stopPropagation();setCarte(c);}} style={{ ...S.btn("s"),padding:"3px 10px",fontSize:10 }}>→</button></td>
                  </tr>
                );
              })}
              {filtree.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign:"center",padding:40,color:"#475569",fontSize:12 }}>
                  {col.length === 0 ? "Collection vide — ajoutez votre première carte !" : "Aucune carte ne correspond aux filtres"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const Decks = () => (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:18 }}>
        <div>
          <div style={{ fontSize:20,fontWeight:700,color:"#e2e8f0" }}>Decks Compétitifs TCG Pocket</div>
          <div style={{ fontSize:10,color:"#3d5068",marginTop:2 }}>Tier list · Images TCGdex · Données tournois 2025</div>
        </div>
        <div style={{ display:"flex",gap:6 }}>
          {["tous","S","A+","A"].map(t => (
            <button key={t} onClick={() => setTierFil(t)} style={{ background:tierFil===t?"#00e5a018":"#1a2332",border:`1px solid ${tierFil===t?"#00e5a040":"#2a3346"}`,color:tierFil===t?"#00e5a0":"#475569",padding:"5px 12px",borderRadius:8,cursor:"pointer",fontSize:10,fontWeight:700 }}>
              {t === "tous" ? "Tous" : `Tier ${t}`}
            </button>
          ))}
        </div>
      </div>
      <div style={{ ...S.card,padding:12,marginBottom:16 }}>
        <div style={{ display:"flex",gap:14,flexWrap:"wrap" }}>
          {[["S","#ffd700","Win >60% · Domine la méta"],["A+","#00b4d8","Win >56% · Très solide"],["A","#00e5a0","Win >52% · Polyvalent"]].map(([t,c,d]) => (
            <div key={t} style={{ display:"flex",alignItems:"center",gap:6 }}><TierBadge tier={t}/><span style={{ fontSize:9,color:"#475569" }}>{d}</span></div>
          ))}
        </div>
      </div>
      <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(310px,1fr))",gap:isMobile?10:14 }}>
        {decksFil.map(d => (
          <div key={d.id} onClick={() => setDeckSel(d)}
            style={{ ...S.card,padding:18,cursor:"pointer",borderTop:`2px solid ${d.couleur}`,transition:"all 0.2s" }}
            onMouseEnter={e => { e.currentTarget.style.boxShadow=`0 8px 30px ${d.couleur}20`; e.currentTarget.style.transform="translateY(-2px)"; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow="none"; e.currentTarget.style.transform="translateY(0)"; }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10 }}>
              <div>
                <div style={{ display:"flex",gap:6,alignItems:"center",marginBottom:6 }}><TierBadge tier={d.tier}/><span style={{ background:`${d.couleur}20`,color:d.couleur,fontSize:9,padding:"2px 7px",borderRadius:6,fontWeight:700 }}>{d.type}</span></div>
                <div style={{ fontSize:13,fontWeight:700,color:"#e2e8f0" }}>{d.emoji} {d.nom}</div>
              </div>
              <div style={{ textAlign:"right",flexShrink:0 }}>
                <div style={{ fontSize:18,fontWeight:700,color:d.couleur }}>{d.winrate}</div>
                <div style={{ fontSize:8,color:"#3d5068" }}>win rate</div>
              </div>
            </div>
            <div style={{ fontSize:10,color:"#64748b",lineHeight:1.6,marginBottom:10 }}>{d.desc.substring(0,110)}…</div>
            {/* Images deck auto-réparantes (résolues par nom via TCGdex) */}
            <div style={{ display:"flex",gap:4,marginBottom:10 }}>
              {d.cartes.slice(0, 4).map((c, i) => (
                <div key={i} style={{ flex:1,borderRadius:5,overflow:"hidden",background:"#080c12" }}>
                  <DeckCardImg nom={c.nom} fallback={c.img} couleur={d.couleur} style={{ width:"100%",display:"block",borderRadius:5 }}/>
                </div>
              ))}
            </div>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
              <div style={{ fontSize:9,color:"#3d5068" }}>{d.cartes.length} cartes · Cliquer pour détails</div>
              <div style={{ fontSize:9,color:d.couleur,fontWeight:700 }}>→ Voir le deck</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const Analytics = () => {
    const parR = {};
    const parExt = {};
    col.forEach(c => {
      parR[c.rarete]   = (parR[c.rarete]   || 0) + gp(c) * c.quantite;
      parExt[c.extension] = (parExt[c.extension] || 0) + gp(c) * c.quantite;
    });
    const COLS = ["#00e5a0","#00b4d8","#a78bfa","#f59e0b","#ef4444"];

    // Historique portefeuille 30j simulé basé sur les prix actuels
    const histo30 = (() => {
      let v = actuel * 0.88;
      return Array.from({ length:30 }, (_, i) => {
        v += v * (Math.random() * 0.03 - 0.008);
        if (i === 29) return actuel;
        return +v.toFixed(2);
      });
    })();
    const histo30Min = Math.min(...histo30), histo30Max = Math.max(...histo30);
    const pctMois = histo30Max > 0 ? (((actuel - histo30[0]) / histo30[0]) * 100).toFixed(1) : "0.0";

    const sorted = [...col].sort((a,b) => +rend(b.prixAchat,gp(b)) - +rend(a.prixAchat,gp(a)));
    const top3   = sorted.slice(0, 3);
    const flop3  = sorted.slice(-3).reverse();

    return (
      <div>
        <div style={{ marginBottom:20 }}><div style={{ fontSize:20,fontWeight:700,color:"#e2e8f0" }}>Analytics</div><div style={{ fontSize:10,color:"#3d5068",marginTop:2 }}>Analyse approfondie · CardMarket FR 🇫🇷</div></div>

        {/* KPIs ligne */}
        <div style={{ display:"grid",gridTemplateColumns:isMobile?"repeat(2,1fr)":"repeat(4,1fr)",gap:isMobile?8:12,marginBottom:14 }}>
          {[
            ["VALEUR ACTUELLE", eur(actuel),  "#00e5a0"],
            ["P&L TOTAL",  `${gain>=0?"+":""}${eur(gain)}`, gain>=0?"#00e5a0":"#ef4444"],
            ["ROI",        `${gain>=0?"+":""}${r}%`, gain>=0?"#00e5a0":"#ef4444"],
            ["PERF. 30J",  `${+pctMois>=0?"+":""}${pctMois}%`, +pctMois>=0?"#00e5a0":"#ef4444"],
          ].map(([l,v,c]) => (
            <div key={l} style={{ ...S.card,padding:"14px 16px" }}>
              <div style={{ fontSize:8,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:6 }}>{l}</div>
              <div style={{ fontSize:16,fontWeight:700,color:c }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Graphique historique 30j */}
        <div style={{ ...S.card,padding:18,marginBottom:14 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
            <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em" }}>ÉVOLUTION PORTEFEUILLE — 30 JOURS</div>
            <span style={{ fontSize:9,color:+pctMois>=0?"#00e5a0":"#ef4444",fontWeight:700 }}>{+pctMois>=0?"+":""}{pctMois}%</span>
          </div>
          <Sparkline data={histo30} color={+pctMois>=0?"#00e5a0":"#ef4444"} width={isMobile?320:780} height={isMobile?50:60}/>
          <div style={{ display:"flex",justifyContent:"space-between",marginTop:6 }}>
            <span style={{ fontSize:8,color:"#3d5068" }}>J-30 · {eur(histo30[0])}</span>
            <span style={{ fontSize:8,color:"#3d5068" }}>Aujourd'hui · {eur(actuel)}</span>
          </div>
        </div>

        <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?10:14,marginBottom:14 }}>
          {/* Top performers */}
          <div style={{ ...S.card,padding:18 }}>
            <div style={{ fontSize:9,color:"#00e5a0",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>🏆 TOP PERFORMERS</div>
            {top3.map((c,i) => {
              const p = +rend(c.prixAchat, gp(c));
              return (
                <div key={c.id} style={{ display:"flex",alignItems:"center",gap:10,marginBottom:10,paddingBottom:10,borderBottom:"1px solid #1a2332" }}>
                  <div style={{ width:22,height:22,borderRadius:"50%",background:["#ffd700","#94a3b8","#a0785a"][i],display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#0d1117",flexShrink:0 }}>{i+1}</div>
                  <CardImg src={c.img} fallback={ioImg(c.tcgId)} alt="" style={{ width:28,borderRadius:3,flexShrink:0 }}/>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:10,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{c.nom}</div>
                    <div style={{ fontSize:9,color:"#3d5068" }}>{c.grade}</div>
                  </div>
                  <span style={{ fontSize:11,fontWeight:700,color:"#00e5a0",flexShrink:0 }}>+{p}%</span>
                </div>
              );
            })}
          </div>

          {/* Flop performers */}
          <div style={{ ...S.card,padding:18 }}>
            <div style={{ fontSize:9,color:"#ef4444",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>📉 MOINS PERFORMANTS</div>
            {flop3.map((c,i) => {
              const p = +rend(c.prixAchat, gp(c));
              return (
                <div key={c.id} style={{ display:"flex",alignItems:"center",gap:10,marginBottom:10,paddingBottom:10,borderBottom:"1px solid #1a2332" }}>
                  <div style={{ width:22,height:22,borderRadius:"50%",background:"#ef444430",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#ef4444",flexShrink:0 }}>▼</div>
                  <CardImg src={c.img} fallback={ioImg(c.tcgId)} alt="" style={{ width:28,borderRadius:3,flexShrink:0 }}/>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:10,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{c.nom}</div>
                    <div style={{ fontSize:9,color:"#3d5068" }}>{c.grade}</div>
                  </div>
                  <span style={{ fontSize:11,fontWeight:700,color:p>=0?"#00e5a0":"#ef4444",flexShrink:0 }}>{p>=0?"+":""}{p}%</span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?10:14 }}>
          {/* Performance par carte — barre */}
          <div style={{ ...S.card,padding:18 }}>
            <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:14 }}>PERFORMANCE PAR CARTE</div>
            {sorted.map(c => {
              const p = +rend(c.prixAchat, gp(c)), pos = p >= 0;
              return (
                <div key={c.id} style={{ marginBottom:11 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:3 }}>
                    <span style={{ fontSize:10,color:"#94a3b8",maxWidth:"72%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{c.nom}</span>
                    <span style={{ fontSize:10,fontWeight:700,color:pos?"#00e5a0":"#ef4444" }}>{pos?"+":""}{p}%</span>
                  </div>
                  <div style={{ height:3,background:"#1a2332",borderRadius:2,overflow:"hidden" }}>
                    <div style={{ width:`${Math.min(Math.abs(p),100)}%`,height:"100%",background:pos?"#00e5a0":"#ef4444",borderRadius:2 }}/>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Valeur par rareté + extension */}
          <div>
            <div style={{ ...S.card,padding:18,marginBottom:12 }}>
              <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:14 }}>VALEUR PAR RARETÉ</div>
              {Object.entries(parR).sort((a,b) => b[1]-a[1]).map(([rar,val],i) => (
                <div key={rar} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid #1a2332" }}>
                  <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                    <div style={{ width:7,height:7,borderRadius:"50%",background:COLS[i%COLS.length] }}/>
                    <span style={{ fontSize:10,color:"#94a3b8" }}>{rar}</span>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:11,fontWeight:700,color:"#e2e8f0" }}>{eur(val)}</div>
                    <div style={{ fontSize:9,color:"#3d5068" }}>{actuel>0?((val/actuel)*100).toFixed(1):0}%</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ ...S.card,padding:18 }}>
              <div style={{ fontSize:9,color:"#3d5068",fontWeight:700,letterSpacing:"0.1em",marginBottom:12 }}>VALEUR PAR EXTENSION</div>
              {Object.entries(parExt).sort((a,b) => b[1]-a[1]).slice(0,5).map(([ext,val],i) => (
                <div key={ext} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #1a2332" }}>
                  <span style={{ fontSize:10,color:"#94a3b8",maxWidth:"60%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{ext}</span>
                  <span style={{ fontSize:11,fontWeight:700,color:COLS[i%COLS.length] }}>{eur(val)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const TABS = [
    { id:"tableau",    ico:"◈",  lbl:"Dashboard"    },
    { id:"collection", ico:"◻",  lbl:"Collection"   },
    { id:"base",       ico:"🗄️", lbl:"Base FR"      },
    { id:"decks",      ico:"⚔️", lbl:"Decks Pocket" },
    { id:"analytics",  ico:"◍",  lbl:"Analytics"    },
  ];

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0b0f18; }
        ::-webkit-scrollbar-thumb { background: #1a2332; border-radius: 2px; }
        select option { background: #0b0f18; color: #e2e8f0; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
        @keyframes slideUp { from { opacity:0; transform:translateX(-50%) translateY(12px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
        html { -webkit-tap-highlight-color: transparent; }
        input, select, button { font-family: inherit; }
        @media (max-width: 767px) {
          ::-webkit-scrollbar { width: 0; }
        }
      `}</style>
      <div style={{ display:"flex", height:"100vh", flexDirection:"row" }}>
        {/* SIDEBAR — desktop seulement */}
        {!isMobile && (
          <div style={S.sb}>
            <div style={{ padding:"0 20px 20px",borderBottom:"1px solid #1a2332",marginBottom:14 }}>
              <div style={{ fontSize:16,fontWeight:700,color:"#e2e8f0",letterSpacing:"-0.02em" }}>⚡ PokéInvest</div>
              <div style={{ fontSize:8,color:"#00e5a0",letterSpacing:"0.2em",marginTop:2 }}>TRADING TERMINAL</div>
            </div>
            <div style={{ flex:1 }}>
              {TABS.map(t => (
                <div key={t.id} style={S.nav(onglet===t.id)} onClick={() => setOnglet(t.id)}>
                  <span style={{ fontSize:13 }}>{t.ico}</span><span>{t.lbl}</span>
                </div>
              ))}
            </div>
            <div style={{ padding:"16px 20px",borderTop:"1px solid #1a2332" }}>
              <div style={{ fontSize:8,color:"#3d5068",marginBottom:4,letterSpacing:"0.1em" }}>PORTEFEUILLE</div>
              <div style={{ fontSize:15,fontWeight:700,color:"#00e5a0" }}>{eur(actuel)}</div>
              <div style={{ fontSize:9,color:gain>=0?"#00e5a0":"#ef4444",marginTop:1 }}>{gain>=0?"+":""}{eur(gain)} ({r}%)</div>
              <div style={{ fontSize:8,color:"#3d5068",marginTop:3 }}>{col.length} cartes · {col.reduce((s,c)=>s+c.quantite,0)} copies</div>
              <div style={{ fontSize:8,color:"#3d5068",marginTop:1 }}>🇫🇷 TCGdex + CardMarket FR</div>
              <button onClick={() => {
                if (window.confirm("Réinitialiser la collection aux données d'exemple ?")) {
                  setCol(COL_INIT); setWl(WL_INIT);
                  showToast("🔄 Collection réinitialisée");
                }
              }} style={{ marginTop:10,width:"100%",background:"#1a2332",border:"1px solid #2a3346",color:"#3d5068",padding:"5px 0",borderRadius:6,cursor:"pointer",fontSize:9 }}>
                ↺ Réinitialiser
              </button>
            </div>
          </div>
        )}

        {/* HEADER MOBILE */}
        {isMobile && (
          <div style={{ position:"fixed",top:0,left:0,right:0,background:"#0b0f18",borderBottom:"1px solid #1a2332",zIndex:90,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",height:52 }}>
            <div>
              <div style={{ fontSize:14,fontWeight:700,color:"#e2e8f0",letterSpacing:"-0.02em" }}>⚡ PokéInvest</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:13,fontWeight:700,color:"#00e5a0" }}>{eur(actuel)}</div>
              <div style={{ fontSize:9,color:gain>=0?"#00e5a0":"#ef4444" }}>{gain>=0?"+":""}{eur(gain)} ({r}%)</div>
            </div>
          </div>
        )}

        <div style={{ ...S.main, marginTop: isMobile ? 52 : 0 }}>
          {onglet==="tableau"    && <Tableau/>}
          {onglet==="collection" && <Collection/>}
          {onglet==="base"       && <VueBD/>}
          {onglet==="decks"      && <Decks/>}
          {onglet==="analytics"  && <Analytics/>}
        </div>

        {/* BOTTOM NAV — mobile seulement */}
        {isMobile && (
          <div style={{ position:"fixed",bottom:0,left:0,right:0,background:"#0b0f18",borderTop:"1px solid #1a2332",display:"flex",zIndex:90,height:58,paddingBottom:"env(safe-area-inset-bottom,0px)" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setOnglet(t.id)}
                style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,background:"none",border:"none",cursor:"pointer",color:onglet===t.id?"#00e5a0":"#3d5068",padding:"4px 0",transition:"color 0.15s",WebkitTapHighlightColor:"transparent" }}>
                <span style={{ fontSize:17,lineHeight:1 }}>{t.ico}</span>
                <span style={{ fontSize:8,fontWeight:700,letterSpacing:"0.04em" }}>{t.lbl.replace(" Pocket","").replace(" FR","")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {carte    && <ModalCarte carte={carte}   prixData={prix} onFermer={() => setCarte(null)} onSupprimer={supprimerCarte} onModifier={modifierCarte}
                    onAjouterWL={w => { setWl(p => [...p, w]); showToast("👁️ Ajouté à la watchlist"); }}
                    enWL={wl.some(w => w.tcgId === carte.tcgId)}/>}
      {deckSel  && <ModalDeck  deck={deckSel}              onFermer={() => setDeckSel(null)}/>}
      {ajout    && <ModalAjout                             onFermer={() => setAjout(false)} onAjouter={ajouterCarte}/>}
      {toast    && <Toast msg={toast} onDone={() => setToast(null)}/>}
    </div>
  );
}

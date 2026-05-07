# Caisse Enregistreuse — Guide de déploiement

## Structure

```
caisse/
├── index.html          # App shell (PWA)
├── manifest.json       # PWA manifest
├── sw.js              # Service Worker (cache + sync en arrière-plan)
├── app.css            # Styles
├── .htaccess          # Config Apache
├── js/
│   ├── db.js          # Couche IndexedDB
│   ├── sync.js        # Gestionnaire de sync
│   └── app.js         # Logique principale
└── api/
    ├── catalog.php        # GET/POST catalogue
    ├── transactions.php   # POST transaction, GET toutes
    ├── report.php         # Rapport agrégé (multi-périphérique)
    └── data/              # Créé automatiquement par PHP
        ├── catalog.json
        └── transactions_dev_xxxx.json  (un par device)
```

## Déploiement

1. Copier le dossier `caisse/` dans la racine web de votre serveur Apache/PHP
2. S'assurer que PHP ≥ 7.4 est disponible
3. Vérifier que le dossier `api/data/` est accessible en écriture par le serveur web :
   ```bash
   mkdir -p caisse/api/data
   chown www-data:www-data caisse/api/data
   chmod 755 caisse/api/data
   ```
4. Activer `mod_rewrite` et `mod_headers` Apache si ce n'est pas déjà fait
5. Ouvrir `https://votre-serveur/caisse/` dans le navigateur du téléphone
6. Sur mobile : "Ajouter à l'écran d'accueil" pour l'installer comme PWA

## Fonctionnement offline

- L'app shell est mise en cache lors de la première visite
- Les transactions sont sauvegardées en IndexedDB immédiatement
- La synchronisation vers le serveur se fait en tâche de fond
- Le point coloré dans le header indique le statut :
  - 🟢 Vert : en ligne et synchronisé
  - 🟡 Ambre clignotant : sync en cours
  - 🔵 Bleu : transactions en attente (hors ligne)
  - 🔴 Rouge : hors ligne

## Multi-périphérique

- Chaque appareil génère un `device_id` unique au premier démarrage
- Les transactions sont stockées dans des fichiers séparés par device
- Les rapports (`report.php`) agrègent automatiquement tous les fichiers
- Les IDs de transaction sont de la forme `timestamp_deviceId`, garantissant
  l'unicité et l'idempotence en cas de double envoi

## Flux de paiement

```
Commande constituée
       ↓
[Liquide/Bon] ──→ Saisir montants cash + bons
                       ↓
               Monnaie à rendre ?
               ├─ Oui + cash > 0 → Choisir [Liquide] ou [Bon]
               └─ Non / only bons → Monnaie en bons auto
                       ↓
                  Confirmation → Enregistrement local → Sync BG

[CB] ──→ (CB + Tél tous deux actifs) → Choisir terminal
             ↓
        Confirmation → Enregistrement local → Sync BG
```

## Règles de rendu de monnaie

- Paiement en liquide : rendu en liquide ou en bons (choix client)
- Paiement en bons : rendu en bons obligatoirement
- Paiement mixte : rendu en liquide possible jusqu'au montant du liquide donné
- Paiements CB/Téléphone : pas de rendu de monnaie

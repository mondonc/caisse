# Guide gestionnaire — Caisse Enregistreuse

## Installer l'application (PWA)

L'application fonctionne dans le navigateur, mais s'installe comme une vraie appli sur l'écran d'accueil.

**Sur Android (Firefox ou Chrome) :**
1. Ouvrir l'URL de la caisse dans le navigateur
2. Menu ⋮ → *Ajouter à l'écran d'accueil*
3. Confirmer — l'icône apparaît sur l'écran d'accueil

> Une fois installée, l'application fonctionne **sans connexion internet**. Les données sont sauvegardées localement et synchronisées dès que le réseau revient.

---

## Configurer les produits

Accéder à la configuration via le bouton **⚙** en haut à droite.

### Ajouter un produit
- Appuyer sur **+ Ajouter un produit** en bas de la liste
- Saisir le nom, le prix, choisir une couleur
- Appuyer sur **✓** pour enregistrer

### Modifier un produit
- Modifier directement le nom, le prix ou la couleur dans la carte du produit
- Appuyer sur **✓** pour enregistrer

### Supprimer un produit
- Appuyer sur **✕** sur la carte du produit

> Les modifications sont synchronisées vers le serveur automatiquement. En cas d'échec, appuyer sur **↻** en haut de la configuration pour forcer la synchronisation.

---

## Modes de paiement

Dans la section **Modes de paiement** de la configuration :
- **Liquide** et **Bons** sont toujours actifs
- **Terminal CB** et **Paiement téléphone** peuvent être activés ou désactivés selon l'équipement disponible

---

## Début de service — Ajout dans la caisse

Avant d'ouvrir le service, saisir le contenu initial de la caisse.

Dans **⚙ Configuration → Ajout dans la caisse** :
- Saisir le montant en **Liquide** et/ou en **Bons**
- Indiquer une note : *fond de caisse*
- Appuyer sur **↑ Enregistrer l'ajout**

> Cet ajout est enregistré avec l'heure exacte et sert de point de départ pour le rapport de caisse.

---

## Décaissements et ajustements en cours de service

Toujours dans **⚙ Configuration**, deux sections permettent de tracer les mouvements hors ventes :

| Section | Quand l'utiliser |
|---|---|
| **Ajout dans la caisse** ↑ | Apport de monnaie, rattrapage d'un écart |
| **Décaissements** ↓ | Retrait de monnaie, règlement d'une dépense |

Toujours indiquer une note explicite (*appoint monnaie*, *achat consommables*…). Ces mouvements apparaissent dans le rapport et servent au recomptage.

---

## Rapports

Accéder aux rapports via le bouton **📊** en haut à droite.

> Les rapports sont générés depuis le serveur. Une connexion internet est nécessaire.

### Sélectionner la période
Choisir la date et l'heure de début et de fin avec les sélecteurs **Du / Au**.

### Contenu du rapport

**Chiffre d'affaires**
Ventes brutes, remboursements, net de la période.

**Produits vendus**
Quantité et montant par produit, du plus vendu au moins vendu.

**Entrées nettes par moyen de paiement**
Ce qui a été encaissé (ventes - rendus - remboursements) pour chaque mode.

**En caisse (théorique)**
Le rapport recalcule automatiquement ce qu'il devrait y avoir dans la caisse physique en déroulant tous les mouvements depuis le début :

```
Début de service     = état de la caisse avant la période
+ Ajouts caisse      = apports en cours de service
+ Ventes encaissées  = ventes en liquide / bons
− Rendu de monnaie   = monnaie rendue aux clients
− Remboursements     = remboursements effectués
− Décaissements      = retraits divers
= En caisse maintenant
```

Ce chiffre est à comparer avec le contenu réel de la caisse au moment du recomptage.

---

## Le voyant de synchronisation

Le petit point coloré en haut à droite de l'écran indique l'état de la synchronisation avec le serveur.

| Couleur | Signification |
|---|---|
| 🟢 Vert | En ligne, tout est synchronisé |
| 🟡 Ambre clignotant | Synchronisation en cours |
| 🔵 Bleu | Hors ligne, des ventes attendent d'être envoyées |
| 🔴 Rouge | Hors ligne |

### Ce que ça implique

- **Les ventes sont toujours enregistrées**, même hors ligne. Elles seront envoyées au serveur dès le retour du réseau.
- **Les rapports nécessitent une connexion** : ils lisent les données depuis le serveur. Si des ventes sont en attente (point bleu), elles n'apparaîtront pas encore dans le rapport.
- En cas de point bleu persistant malgré une connexion active, vérifier que le serveur est accessible et appuyer sur **↻** dans la configuration.

---

## Mettre à jour l'application

Après une mise à jour déployée sur le serveur :
1. Fermer complètement l'application (pas juste la mettre en arrière-plan)
2. La rouvrir

La nouvelle version se charge automatiquement.

---

## Bon à savoir

- Chaque téléphone/appareil a un identifiant unique. Les rapports agrègent les données de tous les appareils.
- En cas de doute sur un écart de caisse, vérifier que toutes les transactions sont bien synchronisées (voyant vert) avant de générer le rapport.
- Ne jamais effacer les données du navigateur en cours de service : les ventes non synchronisées seraient perdues.

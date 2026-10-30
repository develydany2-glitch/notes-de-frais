# Notes de frais — guide d'installation

Application de saisie des notes de frais avec photo du ticket, un tableau par mois et un suivi des remboursements.
Elle s'installe sur l'iPhone comme une vraie app, s'ouvre sur le PC et **fonctionne sans réseau**. Les notes partent toutes seules dès que le wifi ou la 4G revient.

Comptez environ 25 minutes au total. Aucun logiciel à installer et aucune ligne de commande.

---

## Étape 1 — Mettre l'application en ligne (gratuit, 10 min)

L'application est un petit site. Il faut l'héberger en HTTPS pour que l'iPhone accepte de l'installer.
GitHub Pages est gratuit et fiable.

1. Créez un compte sur **github.com**.
2. Cliquez sur **New repository** et nommez-le `notes-de-frais`. Choisissez **Public** (le compte gratuit l'exige pour Pages).
   Vos données ne sont **pas** dans ce dépôt : il ne contient que le code. Vos notes restent sur vos appareils et dans votre espace cloud privé.
3. Dans le dépôt, cliquez sur **Add file › Upload files**. Glissez **tout le contenu** du dossier décompressé (`index.html`, `styles.css`, `sw.js`, `manifest.webmanifest`, et les dossiers `js` et `icons`), puis cliquez sur **Commit changes**.
4. Allez dans **Settings › Pages**. Dans « Branch », choisissez `main` / `(root)`, puis **Save**.
5. Après une minute, l'adresse s'affiche, du type `https://votre-pseudo.github.io/notes-de-frais/`. C'est l'adresse de votre application.

## Étape 2 — Installer sur l'iPhone (1 min)

1. Ouvrez l'adresse dans **Safari** (pas Chrome).
2. Touchez **Partager** (carré avec une flèche), puis **Sur l'écran d'accueil**, puis **Ajouter**.
3. Ouvrez l'app depuis l'icône **Frais**. Elle est alors utilisable en mode avion.

> Le bouton orange au centre ouvre directement l'appareil photo : photo du ticket → montant → type → Enregistrer.

## Étape 3 — Ouvrir sur le PC Windows (1 min)

Ouvrez la même adresse dans **Edge** ou **Chrome**. Pour avoir une icône comme une vraie application :
menu **⋯ › Applications › Installer cette application**.
Le tableau mensuel s'affiche en grand, avec les miniatures des tickets et l'export Excel.

## Étape 4 — Synchroniser iPhone ↔ PC (gratuit, 10 min)

Sans cette étape, chaque appareil garde ses propres notes. Pour voir sur le PC ce que vous avez saisi sur l'iPhone :

1. Créez un compte sur **supabase.com**, puis **New project**. Choisissez la région **Paris (eu-west-3)** et notez le mot de passe proposé.
2. Menu **SQL Editor › New query** : collez le contenu du fichier `supabase-setup.sql`, puis cliquez sur **Run**. Le message « Success » doit s'afficher.
3. Menu **Authentication › Users › Add user › Create new user** : saisissez votre e-mail et un mot de passe, et cochez **Auto Confirm User**.
4. Menu **Project Settings › API** (ou **Data API**) : copiez la **Project URL** et la clé **anon / publishable**.
5. Dans l'application, ouvrez **Réglages › Synchronisation** et collez l'URL et la clé, puis saisissez l'e-mail et le mot de passe de l'étape 3. Touchez **Se connecter**.
6. Faites la même chose sur le PC.

Ensuite, tout est automatique :

* **Hors réseau**, la note est enregistrée sur le téléphone. Un petit point gris à côté du montant indique qu'elle n'est pas encore envoyée.
* Dès que le **wifi ou la 4G revient**, l'envoi se fait tout seul, ainsi qu'à chaque ouverture de l'app et toutes les 90 secondes quand elle est ouverte.
* La pastille en haut affiche l'état : *Local*, *Hors ligne*, *Synchronisé*.

Bon à savoir sur l'offre gratuite Supabase : 1 Go de photos (environ 4 000 tickets). Un projet gratuit se met en pause après environ une semaine sans aucune activité. Vos données sont conservées : il suffit de cliquer sur **Restore** dans le tableau de bord Supabase si la synchro affiche une erreur après une longue période sans saisie.

## Étape 5 — Rappel toutes les 2 semaines dans Outlook

Une application web ne peut pas programmer seule une alarme sur l'iPhone. Le rappel passe donc par **votre agenda Outlook**, qui sonne déjà sur le téléphone et le PC.

1. Sur le PC, dans l'app : **Oublis › Rappel dans Outlook**. Choisissez le jour, l'heure et « Toutes les 2 semaines ».
2. Cliquez sur **Ajouter le rappel à Outlook**, ouvrez le fichier téléchargé, puis **Enregistrer et fermer** dans Outlook.
3. C'est fait une fois pour toutes. Le rendez-vous contient le lien vers l'application.

## Étape 6 — Repérer les déplacements oubliés grâce au planning Outlook

L'app compare vos rendez-vous sur site avec vos notes saisies.

1. Dans Outlook sur le PC : **Fichier › Enregistrer le calendrier**, puis **Plus d'options** › Plage de dates « 3 derniers mois » › Détails complets. Enregistrez le fichier `.ics`.
2. Dans l'app sur le PC : **Oublis › Importer le planning**.
3. La liste affiche les jours de déplacement **sans aucune note**. Pour chaque jour, choisissez **Ajouter** (la date est préremplie) ou **Pas de frais**.

Un jour compte comme déplacement si le rendez-vous a une adresse physique, ou s'il contient un mot comme *chantier, visite, rdv, client, installation, vérification…* Vous pouvez modifier la liste de mots. Les réunions Teams/Zoom sont ignorées.
Le plus simple est de refaire l'import à chaque rappel, toutes les 2 semaines.

## Suivi des remboursements

Chaque note a trois états : **À déclarer → Déclarée → Remboursée**.

* Dans **Tableau**, touchez le statut d'une note pour passer à l'état suivant, ou utilisez **Tout marquer déclaré / remboursé** sur un mois entier.
* Chaque mois affiche une barre : vert = remboursé, bleu = déclaré, gris = à déclarer.
* L'accueil vous alerte si une note est **déclarée depuis plus de 45 jours** sans être remboursée.
* **Exporter pour Excel** produit un fichier `.csv` qui s'ouvre directement dans Excel (séparateur `;`, montants avec virgule).
* **Réglages › Sauvegarde complète** crée un fichier unique avec toutes les notes et les photos.

## Mettre à jour l'application

Si vous modifiez un fichier, changez aussi la ligne `const VERSION = 'v1.0.0'` dans `sw.js` (par exemple `v1.0.1`) avant de le renvoyer sur GitHub. L'app proposera alors « Nouvelle version disponible › Mettre à jour ».

---

### Contenu du dossier

| Fichier | Rôle |
|---|---|
| `index.html`, `styles.css` | Écrans de l'application (mobile et PC) |
| `js/app.js` | Saisie, tableau mensuel, rappels, exports |
| `js/db.js` | Stockage sur l'appareil (fonctionne hors ligne) |
| `js/sync.js` | Envoi et réception avec Supabase quand le réseau revient |
| `js/ics.js` | Rappel Outlook et lecture du planning |
| `sw.js` | Mise en cache pour l'ouverture sans réseau |
| `manifest.webmanifest`, `icons/` | Icône et installation sur l'écran d'accueil |
| `supabase-setup.sql` | Création de la base privée (étape 4) |

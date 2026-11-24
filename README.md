# Out of Ten

A zero-backend online party game where friends on separate networks discuss any topic, rate players with whole numbers **0–10**, and reveal the ranked averages.

## Features

- **Zero backend servers to maintain** — plain HTML, CSS, and ES modules using **Firebase Realtime Database** + **Anonymous Auth** for real-time online rooms across Wi-Fi / 5G.
- **Instant Local Demo Mode** — works offline with zero config using `localStorage` + `BroadcastChannel` (open multiple browser tabs or add simulated demo friends to test alone).
- **Pre-round locked rules (no surprises!)** — every player sees and locks in:
  - **Self-rating toggle:** *Include self* (`0–10` for all `N` players) or *Others only* (`N − 1` players, skipping yourself).
  - **Vote visibility toggle:** *Anonymous* (names hidden; averages & shuffled score chips) or *Open* (names & individual scores shown after reveal).
  - Optional checkbox in *Anonymous + Include self* rounds to decide up front whether everyone’s **Self vs. Group** gap stays private (default: **private to you only**) or is shown publicly.
  - Rules are **write-once** per round (enforced in `database.rules.json`), so nobody can secretly flip an anonymous round to open after people vote.
- **Whole numbers `0–10`**, tie-safe competition ranking (`#1, #2, #2, #4`), round superlatives (*Top Ranked*, *Biggest Split*, *Most Unanimous*, *Highest Self-Belief*, *Most Humble*, *Most Self-Aware*), **Copy summary** for group chats, room lock toggle, late-joiner spectating, kick/transfer-host, and **Close & delete room**.

---

## Try It Locally Right Now

Serve the folder over HTTP (browsers restrict ES module imports over `file://`):

```bash
cd out-of-ten
python3 -m http.server 8080
```

Open `http://localhost:8080` in your browser:
- Create a room and click **Add Demo Friend** to test solo right away, **or**
- Click **Open Friend Tab ↗** to play as multiple friends across browser tabs.

---

## Go Online With Friends (5-Minute Free Setup via Firebase)

Everything runs inside Firebase’s free Spark plan with no accounts, emails, or personal data stored.

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and click **Create a project**.
2. Enable **Anonymous Authentication**:
   - **Build → Authentication → Get started → Sign-in method → Anonymous → Enable**.
3. Create a **Realtime Database**:
   - **Build → Realtime Database → Create database** (start in *locked mode*).
   - Open the **Rules** tab and paste the contents of [`database.rules.json`](./database.rules.json), then click **Publish**.
4. Register a Web App (**Project settings → Your apps → `</>` Web**), and copy the `firebaseConfig` object (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`).
5. Paste the config into [`config.js`](./config.js) (see [`config.example.js`](./config.example.js) for the format) — **or** click the **Local Demo** pill in the top-right header to paste it straight inside the browser while testing.
6. Deploy static files free to **Firebase Hosting**, **GitHub Pages**, **Cloudflare Pages**, or **Netlify**:
   ```bash
   # Example with Firebase CLI
   npm install -g firebase-tools
   firebase login
   firebase use --add   # pick your project
   firebase deploy
   ```

## Security Model (`database.rules.json`)

- **No room crawling:** Reading `/rooms` is denied (`".read": false`). Rooms use 6-character unambiguous random codes (`30⁶ ≈ 729M` possibilities).
- **Authenticated writes only:** Every player gets a cryptographic anonymous `auth.uid` automatically. No personal info (no email, phone, or password) is collected or stored.
- **Sealed ballots before reveal:** During `rating`, a player can only read/write their *own* ballot (`ballots/$roundId/$voterUid`). Other players’ ballots become readable only once the host switches the round to `results`.
- **Strict validation:** Ratings are enforced to be integers `0..10` (`% 1 === 0`). If `allowSelfRating` is `false`, Firebase rejects writing a score for yourself.
- **Immutable round settings:** Round `visibility`, `allowSelfRating`, `revealSelfInAnon`, `topic`, and participant snapshot are write-once (`!data.exists()`), so a round’s privacy rule cannot be swapped mid-round.
- **Room lock & cleanup:** Hosts can lock the room to block late joiners, and delete all room data permanently with **Close & delete room**.

> **Note on strict anonymous mode without a server:** Because the app uses zero backend/Cloud Functions, client browsers fetch the round’s revealed `ballots` node to calculate averages locally. The UI hides and sorts scores alphabetically/numerically so no names are shown, though a curious player opening browser DevTools after a round ends could inspect raw network keys. For casual fun with friends this is safe and zero-ops; your personal data isn’t stored anywhere.
